/**
 * Offline replay, Mode B: run masked webhook fixtures through the real Worker fetch handler with a
 * stubbed env.AI, a fake Notion API and in-memory KV. Collects clef_wake_shadow rows as label-only
 * summaries (no titles, no content, no raw ids). Never touches the network.
 *
 * Coalescing: the 20 s coalesce flush is pre-locked in KV, so forwarded events stay in the buffer
 * (counted as `buffered`) and no 20 s timer runs. CoS is never called.
 */
import { createHmac } from "node:crypto";
import type { Env } from "../../src/env.js";
import { resetGateLogRingForTests } from "../../src/gate-log-ring.js";
import { resetSoftDailyCountersForTests } from "../../src/soft-daily-counter.js";
import { resetExcludedLogCapForTests } from "../../src/wake-gate/clef-rule-skip-shadow.js";
import { resetClefPageEventCountsForTests, resetItemDedupeForTests } from "../../src/wake-gate/clef-wake-gate.js";
import { resetPageFetchMemo } from "../../src/wake-gate/notion-page-fetch.js";
import { maskedId } from "./replay-lib.js";

/** Obviously fake ids shared by every fixture. */
export const FAKE = {
  JOHN: "11111111-1111-4111-8111-111111111111",
  BOT: "22222222-2222-4222-8222-222222222222",
  OTHER: "33333333-3333-4333-8333-333333333333",
  TRACKED_DS: "7aac0000-0000-4000-8000-000000000001",
  UNTRACKED_DS: "0dd00000-0000-4000-8000-000000000002",
} as const;

const TOKEN = "fake_verification_token";
const COS_URL = "https://cos.invalid/webhook";

export type AiAnswer = { p_action: number; p_dup: number; q_when: "now" | "batch" | "ignore" };

export type ReplayFixture = {
  name: string;
  description?: string;
  env?: Record<string, string>;
  ai?: AiAnswer;
  /** Notion pages by id; `"fail"` ⇒ HTTP 500. Key `"*"` is the default for any other id ({id} substituted). */
  notion_pages?: Record<string, unknown>;
  /** Webhook payloads. An entry `{ "repeat": N, "event": {...} }` expands to N events with `{i}` → 12-digit index. */
  events: unknown[];
};

export type RowSummary = {
  event: string | null;
  source: string | null;
  decision: string | null;
  rule_decision: string | null;
  clef_decision: string | null;
  reason: string | null;
  scored: boolean | null;
  p_action: number | null;
  q_when: string | null;
  echo_reason: string | null;
  item_id: string;
};

export type FixtureResult = {
  name: string;
  statuses: number[];
  buffered: number;
  cos_calls: number;
  ai_calls: number;
  notion_fetches: number;
  rows: RowSummary[];
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function substitute(v: unknown, i: string): unknown {
  if (typeof v === "string") return v.split("{i}").join(i);
  if (Array.isArray(v)) return v.map((x) => substitute(x, i));
  if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, i)]));
  return v;
}

export function expandEvents(events: unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const e of events) {
    if (isRecord(e) && typeof e.repeat === "number" && isRecord(e.event)) {
      for (let n = 1; n <= e.repeat; n++) {
        const ev = substitute(e.event, String(n).padStart(12, "0"));
        if (isRecord(ev)) out.push(ev);
      }
    } else if (isRecord(e)) {
      out.push(e);
    }
  }
  return out;
}

function memoryKv(store: Map<string, string>): KVNamespace {
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
    delete: async (k: string) => {
      store.delete(k);
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async (k: string) => ({ value: store.get(k) ?? null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
}

function stubAi(answer: AiAnswer, counter: { n: number }): Ai {
  return {
    run: async () => {
      counter.n += 1;
      return {
        answers: {
          q_action: { type: "noul", noul: answer.p_action },
          q_dup: { type: "noul", noul: answer.p_dup },
          q_when: { type: "choice", choice: answer.q_when },
        },
      };
    },
  } as unknown as Ai;
}

function baseEnv(store: Map<string, string>, ai: Ai, over: Record<string, string>): Env {
  return {
    RELAY_KV: memoryKv(store),
    COS_WEBHOOK_URL: COS_URL,
    COS_WEBHOOK_AUTHORIZATION: "Bearer fake",
    SETUP_SECRET: "fake",
    NOTION_VERIFICATION_TOKEN: TOKEN,
    NOTION_API_TOKEN: "fake-notion-token",
    CLEF_DEFAULT_MODE: "shadow",
    JOHN_NOTION_USER_IDS: FAKE.JOHN,
    FLEET_COMMENTS_BOT_NOTION_USER_IDS: FAKE.BOT,
    TRACKED_DATA_SOURCE_IDS: FAKE.TRACKED_DS,
    CLEF_ECHO_SKIP_SAMPLE_PERCENT: "0",
    AI: ai,
    ...over,
  };
}

function normId(s: string): string {
  return s.replace(/-/g, "").toLowerCase();
}

function notionResponse(fixture: ReplayFixture, url: string): Response {
  const m = /\/v1\/pages\/([^/?]+)/.exec(url);
  if (!m) return new Response("{}", { status: 404 });
  const id = decodeURIComponent(m[1] ?? "");
  const pages = fixture.notion_pages ?? {};
  const hit = Object.entries(pages).find(([k]) => k !== "*" && normId(k) === normId(id));
  const page = hit ? hit[1] : pages["*"];
  if (page === undefined || page === "fail") return new Response("{}", { status: 500 });
  return new Response(JSON.stringify(substitute(page, id)), { status: 200 });
}

function summarize(row: Record<string, unknown>): RowSummary {
  const s = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    event: s(row.event),
    source: s(row.source),
    decision: s(row.decision),
    rule_decision: s(row.rule_decision),
    clef_decision: s(row.clef_decision),
    reason: s(row.reason),
    scored: typeof row.scored === "boolean" ? row.scored : null,
    p_action: typeof row.p_action === "number" ? row.p_action : null,
    q_when: s(row.q_when),
    echo_reason: s(row.echo_reason),
    item_id: maskedId(row.item_id),
  };
}

export function resetReplayState(): void {
  resetClefPageEventCountsForTests();
  resetItemDedupeForTests();
  resetSoftDailyCountersForTests();
  resetExcludedLogCapForTests();
  resetPageFetchMemo();
  resetGateLogRingForTests();
}

export async function runFixture(fixture: ReplayFixture): Promise<FixtureResult> {
  resetReplayState();
  const store = new Map<string, string>([["coalesce_flush_scheduled", "replay-prelocked"]]);
  const aiCounter = { n: 0 };
  const env = baseEnv(store, stubAi(fixture.ai ?? { p_action: 0.9, p_dup: 0.05, q_when: "now" }, aiCounter), fixture.env ?? {});
  const result: FixtureResult = {
    name: fixture.name,
    statuses: [],
    buffered: 0,
    cos_calls: 0,
    ai_calls: 0,
    notion_fetches: 0,
    rows: [],
  };
  const origLog = console.log;
  const origFetch = globalThis.fetch;
  console.log = ((line: unknown) => {
    if (typeof line !== "string" || !line.includes('"clef_wake_shadow"')) return;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed) && parsed.stream === "clef_wake_shadow") result.rows.push(summarize(parsed));
    } catch {
      // not a row
    }
  }) as typeof console.log;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(COS_URL)) {
      result.cos_calls += 1;
      return new Response("{}", { status: 200 });
    }
    if (url.startsWith("https://api.notion.com/")) {
      result.notion_fetches += 1;
      return notionResponse(fixture, url);
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  try {
    const { default: worker } = await import("../../src/index.js");
    for (const ev of expandEvents(fixture.events)) {
      const body = JSON.stringify(ev);
      const sig = `sha256=${createHmac("sha256", TOKEN).update(body).digest("hex")}`;
      const pending: Promise<unknown>[] = [];
      const ctx = {
        waitUntil(p: Promise<unknown>) {
          pending.push(p);
        },
      } as unknown as ExecutionContext;
      const res = await worker.fetch(
        new Request("https://relay.invalid/", {
          method: "POST",
          headers: { "X-Notion-Signature": sig, "content-type": "application/json", "user-agent": "notion" },
          body,
        }),
        env,
        ctx,
      );
      await Promise.allSettled(pending);
      result.statuses.push(res.status);
    }
    const buf: unknown = JSON.parse(store.get("coalesce_buffer") ?? "[]");
    result.buffered = Array.isArray(buf) ? buf.length : 0;
  } finally {
    console.log = origLog;
    globalThis.fetch = origFetch;
  }
  result.ai_calls = aiCounter.n;
  return result;
}

export function formatFixtureResult(r: FixtureResult): string {
  const out = [
    `fixture ${r.name}: statuses=${r.statuses.join(",")} buffered=${r.buffered} cos_calls=${r.cos_calls} ai_calls=${r.ai_calls} notion_fetches=${r.notion_fetches} rows=${r.rows.length}`,
  ];
  for (const row of r.rows) {
    out.push(
      `  ${row.event ?? "-"} src=${row.source ?? "-"} rule=${row.rule_decision ?? "-"} clef=${row.clef_decision ?? "-"}${row.decision ? ` decision=${row.decision}` : ""} reason=${row.reason ?? "-"}${row.scored === null ? "" : ` scored=${row.scored}`}${row.p_action === null ? "" : ` p_action=${row.p_action}`}${row.echo_reason ? ` echo=${row.echo_reason}` : ""}`,
    );
  }
  return out.join("\n");
}
