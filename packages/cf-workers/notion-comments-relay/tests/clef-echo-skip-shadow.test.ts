/**
 * Shadow Clef scoring of LOCK-69 echo-filter drops. The drop is live; scoring is sampled, capped and
 * runs in waitUntil, so it can never change the decision. All ids are fake.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { Env } from "../src/env.js";
import { clefDailyCapKey } from "../src/wake-gate/clef-daily-cap.js";
import {
  ECHO_SKIP_SAMPLE_PERCENT_DEFAULT,
  readEchoSkipDailyCap,
  readEchoSkipSamplePercent,
  runEchoSkipClefShadow,
} from "../src/wake-gate/clef-echo-skip-shadow.js";
import { resetExcludedLogCapForTests } from "../src/wake-gate/clef-rule-skip-shadow.js";
import { resetClefPageEventCountsForTests } from "../src/wake-gate/clef-wake-gate.js";
import { buildGateContext } from "../src/wake-gate/gate-orchestration.js";
import type { ClefShadowLogEntry } from "../src/wake-gate/gate-event-types.js";
import { resetSoftDailyCountersForTests } from "../src/soft-daily-counter.js";

const JOHN = "11111111-1111-4111-8111-111111111111";
const BOT = "22222222-2222-4222-8222-222222222222";
const PAGE = "fa4e0000-0000-4000-8000-000000000001";
const COMMENT = "c0aa0000-0000-4000-8000-000000000002";
const COS_URL = "https://cos.example/webhook";

let aiCalls = 0;
function ai(behavior: "ok" | "throw" = "ok"): Ai {
  return {
    run: async () => {
      aiCalls += 1;
      if (behavior === "throw") throw new Error("boom");
      return {
        answers: {
          q_action: { type: "noul", noul: 0.8 },
          q_dup: { type: "noul", noul: 0.1 },
          q_when: { type: "choice", choice: "now" },
        },
      };
    },
  } as unknown as Ai;
}

function env(store: Map<string, string>, o: Partial<Env> = {}): Env {
  return {
    RELAY_KV: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => {
        store.set(k, v);
      },
      delete: async (k: string) => {
        store.delete(k);
      },
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
      getWithMetadata: async (k: string) => ({ value: store.get(k) ?? null, metadata: null, cacheStatus: null }),
    } as unknown as KVNamespace,
    COS_WEBHOOK_URL: COS_URL,
    COS_WEBHOOK_AUTHORIZATION: "Bearer fake",
    SETUP_SECRET: "s",
    NOTION_VERIFICATION_TOKEN: "secret_test_token",
    CLEF_DEFAULT_MODE: "shadow",
    JOHN_NOTION_USER_IDS: JOHN,
    FLEET_COMMENTS_BOT_NOTION_USER_IDS: BOT,
    AI: ai(),
    ...o,
  };
}

function ownEcho(): Record<string, unknown> {
  return {
    id: "ev-fake-echo-1",
    type: "comment.created",
    authors: [{ id: BOT, type: "bot" }],
    entity: { id: COMMENT, type: "comment" },
    data: { page_id: PAGE, parent: { type: "page", id: PAGE } },
  };
}

type Posted = { res: Response; pending: Promise<unknown>[]; cosCalls: number };

async function post(e: Env, payload: Record<string, unknown>, waitUntilThrows = false): Promise<Posted> {
  const body = JSON.stringify(payload);
  const sig = `sha256=${createHmac("sha256", "secret_test_token").update(body).digest("hex")}`;
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      if (waitUntilThrows) throw new Error("waitUntil unavailable");
      pending.push(p);
    },
  } as unknown as ExecutionContext;
  let cosCalls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).startsWith(COS_URL)) cosCalls += 1;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const { default: worker } = await import("../src/index.js");
    const res = await worker.fetch(
      new Request("https://relay/", {
        method: "POST",
        headers: { "X-Notion-Signature": sig, "content-type": "application/json", "user-agent": "notion" },
        body,
      }),
      e,
      ctx,
    );
    await Promise.all(pending);
    return { res, pending, cosCalls };
  } finally {
    globalThis.fetch = origFetch;
  }
}

describe("echo-filter skip shadow scoring", () => {
  let logs: string[] = [];
  const origLog = console.log;

  function clefRows(): Record<string, unknown>[] {
    return logs
      .filter((l) => l.includes('"clef_wake_shadow"'))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((r) => r.source === "echo_filter");
  }

  beforeEach(() => {
    logs = [];
    aiCalls = 0;
    console.log = ((line: unknown) => {
      logs.push(String(line));
    }) as typeof console.log;
    resetSoftDailyCountersForTests();
    resetClefPageEventCountsForTests();
    resetExcludedLogCapForTests();
  });

  afterEach(() => {
    console.log = origLog;
  });

  test("defaults: 5% sample, 100/day echo cap", () => {
    const e = env(new Map());
    expect(readEchoSkipSamplePercent(e)).toBe(ECHO_SKIP_SAMPLE_PERCENT_DEFAULT);
    expect(ECHO_SKIP_SAMPLE_PERCENT_DEFAULT).toBe(5);
    expect(readEchoSkipDailyCap(e)).toBe(100);
    expect(readEchoSkipSamplePercent(env(new Map(), { CLEF_ECHO_SKIP_SAMPLE_PERCENT: "250" }))).toBe(100);
  });

  test("sampled own_echo drop ⇒ scored=true row, drop unchanged (200, no CoS call)", async () => {
    const store = new Map<string, string>();
    const { res, pending, cosCalls } = await post(env(store, { CLEF_ECHO_SKIP_SAMPLE_PERCENT: "100" }), ownEcho());
    expect(res.status).toBe(200);
    expect(cosCalls).toBe(0);
    expect(pending.length).toBe(1);
    expect(store.has("coalesce_buffer")).toBe(false);
    const rows = clefRows();
    const deterministic = rows.filter((r) => r.mode === "deterministic" && r.scored === false && r.model === null);
    expect(deterministic.length).toBeGreaterThanOrEqual(1);
    const scored = rows.filter((r) => r.scored === true);
    expect(scored.length).toBe(1);
    expect(scored[0]?.echo_reason).toBe("own_echo");
    expect(scored[0]?.decision).toBe("rule_skip");
    expect(scored[0]?.reason).toBe("rule_skip:clef_ok");
    expect(scored[0]?.candidate_false_skip).toBe(true);
    expect(String(scored[0]?.item_id)).toMatch(/^opaque:/);
    expect(aiCalls).toBe(1);
    // ids only: no raw comment/page id in the scored row
    expect(JSON.stringify(scored[0])).not.toContain(COMMENT);
  });

  test("unsampled drop ⇒ no Clef call, only the scored=false deterministic row", async () => {
    const { res } = await post(env(new Map(), { CLEF_ECHO_SKIP_SAMPLE_PERCENT: "0" }), ownEcho());
    expect(res.status).toBe(200);
    expect(aiCalls).toBe(0);
    const rows = clefRows();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.scored === false)).toBe(true);
  });

  test("scorer failure (AI throws / waitUntil throws) ⇒ decision unchanged", async () => {
    const a = await post(env(new Map(), { CLEF_ECHO_SKIP_SAMPLE_PERCENT: "100", AI: ai("throw") }), ownEcho());
    expect(a.res.status).toBe(200);
    expect(await a.res.text()).toBe("ok");
    expect(a.cosCalls).toBe(0);
    expect(clefRows().some((r) => r.scored === true)).toBe(false);

    const b = await post(env(new Map(), { CLEF_ECHO_SKIP_SAMPLE_PERCENT: "100" }), ownEcho(), true);
    expect(b.res.status).toBe(200);
    expect(await b.res.text()).toBe("ok");
    expect(b.cosCalls).toBe(0);
  });

  test("echo cap exhausted ⇒ scored=false echo_skip_daily_cap, no model call", async () => {
    await post(env(new Map(), { CLEF_ECHO_SKIP_SAMPLE_PERCENT: "100", CLEF_ECHO_SKIP_DAILY_CAP: "0" }), ownEcho());
    expect(aiCalls).toBe(0);
    expect(clefRows().some((r) => r.reason === "echo_skip_daily_cap" && r.scored === false)).toBe(true);
  });

  test("global clef-daily-cap exhausted ⇒ scored=false rule_skip:clef_daily_cap", async () => {
    const store = new Map<string, string>([[clefDailyCapKey(), "1"]]);
    await post(env(store, { CLEF_ECHO_SKIP_SAMPLE_PERCENT: "100", CLEF_DAILY_CALL_CAP: "1" }), ownEcho());
    expect(aiCalls).toBe(0);
    expect(clefRows().some((r) => r.reason === "rule_skip:clef_daily_cap" && r.scored === false)).toBe(true);
  });

  test("untracked_property_edit drop is scored too (echo_reason carried)", async () => {
    const payload = {
      id: "ev-fake-prop-1",
      type: "page.properties_updated",
      authors: [{ id: "33333333-3333-4333-8333-333333333333", type: "person" }],
      entity: { id: PAGE, type: "page" },
      data: {
        parent: { type: "data_source_id", data_source_id: "0dd00000-0000-4000-8000-000000000009" },
        updated_properties: ["fakeOther"],
      },
    };
    const { res, cosCalls } = await post(
      env(new Map(), {
        CLEF_ECHO_SKIP_SAMPLE_PERCENT: "100",
        TRACKED_DATA_SOURCE_IDS: "7aac0000-0000-4000-8000-000000000008",
      }),
      payload,
    );
    expect(res.status).toBe(200);
    expect(cosCalls).toBe(0);
    const scored = clefRows().filter((r) => r.scored === true);
    expect(scored.length).toBe(1);
    expect(scored[0]?.echo_reason).toBe("untracked_property_edit");
  });

  test("Clef mode off ⇒ no call", async () => {
    await post(env(new Map(), { CLEF_ECHO_SKIP_SAMPLE_PERCENT: "100", CLEF_DEFAULT_MODE: "off" }), ownEcho());
    expect(aiCalls).toBe(0);
  });

  test("direct call: logger failure is swallowed (never throws)", async () => {
    const e = env(new Map(), { CLEF_ECHO_SKIP_SAMPLE_PERCENT: "100" });
    const parsed = ownEcho();
    const ctx = buildGateContext(parsed, "comment.created", JSON.stringify(parsed), e);
    const seen: ClefShadowLogEntry[] = [];
    await runEchoSkipClefShadow(e, ctx, parsed, { decision: "drop", reason: "own_echo", rule: "fleet_bot_author" }, {
      flush: false,
      log: async (entry) => {
        seen.push(entry);
        throw new Error("log down");
      },
    });
    expect(seen.length).toBe(1);
    expect(seen[0]?.echo_reason).toBe("own_echo");
  });
});
