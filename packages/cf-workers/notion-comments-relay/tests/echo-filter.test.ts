import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Env } from "../src/env.js";
import {
  decideEchoFilter,
  echoFilterRuleSkipRow,
  fetchCommentText,
  LEGACY_ECHO_GATE,
  LEGACY_ECHO_REASON,
  resolveEchoCommentText,
} from "../src/wake-gate/echo-filter.js";
import {
  DEFAULT_LOCK39_LANE_NAMES,
  echoFilterConfigFromEnv,
  FLEET_ARTIFACTS_DATA_SOURCE_ID,
  FLEET_BOT_AUTHOR_IDS,
  GROKBOT_FLEET_COMMENTS_BOT_ID,
  NOTION_SYSTEM_BOT_ID,
} from "../src/wake-gate/echo-filter-config.js";
import { buildGateContext } from "../src/wake-gate/gate-orchestration.js";
import { flushGateLogRing, isHighSignal, resetGateLogRingForTests } from "../src/gate-log-ring.js";
import { resetSoftDailyCountersForTests } from "../src/soft-daily-counter.js";
import { AD_DOCS_DATA_SOURCE_ID } from "../src/wake-gate/wake-gate-types.js";

const JOHN = "2e7d872b-594c-8161-92a2-00024b29e816";
const HUMAN = "12121212-3434-5656-7878-909090909090";
const ZOHO_BOT = "99999999-8888-7777-6666-555555555555";
const JRE_WORKERS = "3167d7f5-6298-81d7-b2bd-00271cbdf192";
const FLEET_LOCKS_DS = "6e0a45b3-eb3f-448f-b215-49e002bfeff3";
const ENTERPRISE_ARTIFACTS_DS = "74fc2205-005a-43b7-b563-0cb658d906d3";
const UNTRACKED_DS = "bbbbbbbb-1111-2222-3333-444444444444";
const MOM_MEDICAL = "3547d7f5-6298-8070-9aee-000b5657c83a";
const STEWARD_LIST = [FLEET_LOCKS_DS, AD_DOCS_DATA_SOURCE_ID, FLEET_ARTIFACTS_DATA_SOURCE_ID, ENTERPRISE_ARTIFACTS_DS].join(",");
const TEXT_SENTINEL = "SENTINEL_COMMENT_TEXT_DO_NOT_LOG";
const LOCK39_TEXT = "Chief of Staff Agent for John Eakin — triaged, moving to Done";

const baseEnv = {
  JOHN_NOTION_USER_IDS: JOHN,
  FLEET_COMMENTS_BOT_NOTION_USER_IDS: GROKBOT_FLEET_COMMENTS_BOT_ID,
  FLEET_LOCKS_DATA_SOURCE_ID: FLEET_LOCKS_DS,
  SUBMITTED_PROPERTY_IDS: ";Xo<",
} as Partial<Env>;
const tracked = { ...baseEnv, TRACKED_DATA_SOURCE_IDS: STEWARD_LIST } as Partial<Env>;

let seq = 0;
/** Notion comment webhook: no body in the payload (the real shape) unless `text` is given. */
function comment(
  authors: Array<{ id: string; type?: string }>,
  opts: { text?: string; type?: string; rich?: unknown[] } = {},
): Record<string, unknown> {
  seq += 1;
  const data: Record<string, unknown> = { page_id: `page-${seq}`, parent: { id: `page-${seq}`, type: "page" } };
  if (opts.text !== undefined || opts.rich) {
    data.rich_text = [...(opts.rich ?? []), ...(opts.text !== undefined ? [{ type: "text", plain_text: opts.text }] : [])];
  }
  return {
    id: `evt-c-${seq}`,
    type: opts.type ?? "comment.created",
    authors,
    entity: { id: `comment-${seq}`, type: "comment" },
    data,
  };
}

function propsUpdated(
  parent: Record<string, unknown> | null,
  opts: { updated?: string[]; authors?: Array<{ id: string; type?: string }> } = {},
): Record<string, unknown> {
  seq += 1;
  return {
    id: `evt-p-${seq}`,
    type: "page.properties_updated",
    authors: opts.authors ?? [{ id: HUMAN, type: "person" }],
    entity: { id: `page-p-${seq}`, type: "page" },
    data: { ...(parent ? { parent } : {}), updated_properties: opts.updated ?? ["abc"] },
  };
}

function pageMoved(authors: Array<{ id: string; type?: string }>): Record<string, unknown> {
  seq += 1;
  return {
    id: `evt-m-${seq}`,
    type: "page.moved",
    authors,
    entity: { id: `page-m-${seq}`, type: "page" },
    data: { parent: { id: UNTRACKED_DS, type: "data_source" } },
  };
}

function decide(parsed: Record<string, unknown>, env: Partial<Env> = baseEnv, text?: string | null) {
  const type = parsed.type as string;
  const ctx = buildGateContext(parsed, type, JSON.stringify(parsed), env as Env);
  return decideEchoFilter(parsed, ctx, echoFilterConfigFromEnv(env), text);
}

describe("own_echo (fleet bot authors; comment.* and page.moved only)", () => {
  test.each([...FLEET_BOT_AUTHOR_IDS])("fleet bot %s comment → own_echo", (id) => {
    expect(decide(comment([{ id, type: "bot" }]))).toMatchObject({ decision: "drop", reason: "own_echo" });
  });

  test("other integrations (Zoho / BetterStack / ...) are not fleet → pass", () => {
    expect(decide(comment([{ id: ZOHO_BOT, type: "bot" }]), baseEnv, "Synced")).toEqual({
      decision: "pass",
      reason: "comment_passed",
    });
  });

  test("Notion system bot is never an echo, even if listed in FLEET_COMMENTS_BOT_NOTION_USER_IDS", () => {
    const env = { ...baseEnv, FLEET_COMMENTS_BOT_NOTION_USER_IDS: `${GROKBOT_FLEET_COMMENTS_BOT_ID},${NOTION_SYSTEM_BOT_ID}` };
    expect(decide(comment([{ id: NOTION_SYSTEM_BOT_ID, type: "bot" }]), env, "x").decision).toBe("pass");
    expect(decide(pageMoved([{ id: NOTION_SYSTEM_BOT_ID, type: "bot" }]), env).decision).toBe("pass");
  });

  test("mixed fleet + human authors pass", () => {
    expect(decide(comment([{ id: JRE_WORKERS, type: "bot" }, { id: HUMAN, type: "person" }]), baseEnv, "hi").decision).toBe(
      "pass",
    );
  });

  test("comment.updated by a fleet bot → own_echo", () => {
    expect(decide(comment([{ id: JRE_WORKERS, type: "bot" }], { type: "comment.updated" })).reason).toBe("own_echo");
  });

  test("fleet-authored comment.deleted → own_echo", () => {
    expect(decide(comment([{ id: JRE_WORKERS, type: "bot" }], { type: "comment.deleted" }))).toMatchObject({
      decision: "drop",
      reason: "own_echo",
    });
  });

  test("John-authored comment.deleted → KEEP (conservative)", () => {
    expect(decide(comment([{ id: JOHN, type: "person" }], { type: "comment.deleted", text: LOCK39_TEXT }))).toEqual({
      decision: "pass",
      reason: "john_deleted_keep",
    });
  });

  test("page.moved by a fleet bot → own_echo; by a human → pass", () => {
    expect(decide(pageMoved([{ id: JRE_WORKERS, type: "bot" }]))).toMatchObject({ decision: "drop", reason: "own_echo" });
    expect(decide(pageMoved([{ id: HUMAN, type: "person" }]))).toEqual({ decision: "pass", reason: "not_fleet_author" });
  });

  test("properties_updated by a fleet bot is never an author drop", () => {
    const p = propsUpdated({ type: "data_source", id: FLEET_ARTIFACTS_DATA_SOURCE_ID }, { authors: [{ id: JRE_WORKERS, type: "bot" }] });
    expect(decide(p, tracked)).toEqual({ decision: "pass", reason: "tracked_parent" });
  });
});

describe("agent_prefix (LOCK-39 full form beats the John keep)", () => {
  test.each([
    LOCK39_TEXT,
    "**Chief of Staff Agent for John Eakin:** done",
    "   dr eggbot agent for shadow seeker - review attached",
    "Bot Computer Harness Agent for John Eakin – PR #63 opened",
    "QUORUM REPORT PM AGENT FOR JOHN EAKIN —",
  ])("John-authored %p → agent_prefix", (text) => {
    expect(decide(comment([{ id: JOHN, type: "person" }]), baseEnv, text)).toEqual({
      decision: "drop",
      reason: "agent_prefix",
      rule: "lock39_full_prefix",
    });
  });

  test.each([
    "Chief of Staff Agent for Bob — hi",
    "Random Lane Agent for John Eakin — hi",
    "Please ask Chief of Staff Agent for John Eakin — later",
  ])("non-matching %p passes", (text) => {
    expect(decide(comment([{ id: JOHN, type: "person" }]), baseEnv, text).decision).toBe("pass");
  });

  test("short tags never drop human authors (John or anyone else)", () => {
    expect(decide(comment([{ id: JOHN, type: "person" }]), baseEnv, "CoS: can you take this?")).toEqual({
      decision: "pass",
      reason: "john_authored",
    });
    for (const t of ["BCH: PR opened", "AS: reviewed", "[Steward] flushed", "EC → handed off"]) {
      expect(decide(comment([{ id: HUMAN, type: "person" }]), baseEnv, t)).toEqual({ decision: "pass", reason: "comment_passed" });
    }
  });

  test("John @mentioning an agent passes (mention keep is John-only)", () => {
    const mention = { type: "mention", plain_text: "@Chief of Staff", mention: { type: "user", user: { id: JRE_WORKERS } } };
    const c = comment([{ id: JOHN, type: "person" }], { rich: [mention], text: " please pick this up" });
    expect(decide(c)).toEqual({ decision: "pass", reason: "john_authored" });
  });

  test("a fleet bot comment that @mentions John is still own_echo", () => {
    const mention = { type: "mention", plain_text: "@John", mention: { type: "user", user: { id: JOHN } } };
    expect(decide(comment([{ id: GROKBOT_FLEET_COMMENTS_BOT_ID, type: "bot" }], { rich: [mention], text: " needs you" })).reason).toBe(
      "own_echo",
    );
  });

  test("body unavailable (fetch failed ⇒ null) fails open", () => {
    expect(decide(comment([{ id: JOHN, type: "person" }]), baseEnv, null)).toEqual({ decision: "pass", reason: "john_authored" });
  });

  test("ECHO_FILTER_LANE_NAMES replaces the default lane list", () => {
    const env = { ...baseEnv, ECHO_FILTER_LANE_NAMES: "Ops Bot" };
    expect(decide(comment([{ id: JOHN }]), env, "Ops Bot Agent for John Eakin: synced").reason).toBe("agent_prefix");
    expect(decide(comment([{ id: JOHN }]), env, LOCK39_TEXT).reason).toBe("john_authored");
    expect(DEFAULT_LOCK39_LANE_NAMES).toContain("Quorum Report Launch Lead" as never);
  });
});

describe("untracked_property_edit (TRACKED_DATA_SOURCE_IDS)", () => {
  test("allowlist unset → fail open", () => {
    expect(decide(propsUpdated({ type: "data_source", id: UNTRACKED_DS }))).toEqual({ decision: "pass", reason: "allowlist_unset" });
  });

  test("untracked data source → drop with parent data_source_id", () => {
    expect(decide(propsUpdated({ type: "data_source_id", data_source_id: UNTRACKED_DS }), tracked)).toEqual({
      decision: "drop",
      reason: "untracked_property_edit",
      rule: "untracked_parent",
      parentDataSourceId: UNTRACKED_DS,
    });
  });

  test("page parent (not a DB) → untracked drop", () => {
    expect(decide(propsUpdated({ type: "page_id", page_id: "p-1" }), tracked)).toMatchObject({
      decision: "drop",
      reason: "untracked_property_edit",
      rule: "page_parent",
    });
  });

  test("no parent at all → pass (parent_unknown, fail open)", () => {
    expect(decide(propsUpdated(null), tracked)).toEqual({ decision: "pass", reason: "parent_unknown" });
  });

  test("tracked via data.parent id (dashless) or data_source_id", () => {
    expect(decide(propsUpdated({ type: "data_source", id: ENTERPRISE_ARTIFACTS_DS.replace(/-/g, "") }), tracked).reason).toBe(
      "tracked_parent",
    );
    expect(decide(propsUpdated({ type: "database_id", database_id: "x", data_source_id: FLEET_LOCKS_DS }), tracked).reason).toBe(
      "tracked_parent",
    );
  });

  test("order: untracked drop wins over a Submitted edit", () => {
    expect(decide(propsUpdated({ type: "data_source", id: UNTRACKED_DS }, { updated: [";Xo<"] }), tracked).decision).toBe("drop");
  });

  test("Submitted edit on Fleet: Artifacts → pass submitted_changed (URL-encoded id too)", () => {
    const parent = { type: "data_source", id: FLEET_ARTIFACTS_DATA_SOURCE_ID };
    expect(decide(propsUpdated(parent, { updated: [";Xo<"] }), tracked)).toEqual({ decision: "pass", reason: "submitted_changed" });
    expect(decide(propsUpdated(parent, { updated: ["%3BXo%3C"] }), tracked).reason).toBe("submitted_changed");
  });

  test("TRACKED_PARENT_IDS is an alias; Fleet Locks + AD Docs always added", () => {
    const env = { ...baseEnv, TRACKED_PARENT_IDS: ENTERPRISE_ARTIFACTS_DS };
    expect(decide(propsUpdated({ type: "data_source", id: ENTERPRISE_ARTIFACTS_DS }), env).reason).toBe("tracked_parent");
    expect(decide(propsUpdated({ type: "data_source", id: AD_DOCS_DATA_SOURCE_ID }), env).reason).toBe("tracked_parent");
    expect(decide(propsUpdated({ type: "data_source", id: FLEET_LOCKS_DS }), env).reason).toBe("tracked_parent");
  });

  test("Mom - Medical is not tracked (open item; not in Steward's list)", () => {
    expect(decide(propsUpdated({ type: "data_source", id: MOM_MEDICAL }), tracked).decision).toBe("drop");
  });

  test("page.created on an untracked parent passes (out of scope)", () => {
    const p = { ...propsUpdated({ type: "data_source", id: UNTRACKED_DS }), type: "page.created" };
    expect(decide(p, tracked)).toEqual({ decision: "pass", reason: "not_filtered_type" });
  });

  test("wrangler [vars] TRACKED_DATA_SOURCE_IDS = Steward's list (no Mom - Medical)", () => {
    const toml = readFileSync(`${import.meta.dir}/../wrangler.toml`, "utf8");
    const line = toml.split("\n").find((l) => l.startsWith("TRACKED_DATA_SOURCE_IDS")) ?? "";
    for (const id of STEWARD_LIST.split(",")) expect(line).toContain(id);
    expect(line).not.toContain(MOM_MEDICAL);
  });

  test("ECHO_FILTER=off passes everything", () => {
    expect(decide(comment([{ id: JRE_WORKERS }]), { ...baseEnv, ECHO_FILTER: "off" })).toEqual({
      decision: "pass",
      reason: "filter_disabled",
    });
  });
});

describe("comment body fetch (mocked; fail open)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("ok: GET /v1/comments/{id} with the token, returns plain text", async () => {
    const seen: string[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(String(url));
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer test-notion-token");
      return Response.json({ object: "comment", rich_text: [{ plain_text: "Chief of Staff " }, { plain_text: "Agent for John Eakin — x" }] });
    }) as unknown as typeof fetch;
    expect(await fetchCommentText("test-notion-token", "comment-1")).toEqual({
      text: "Chief of Staff Agent for John Eakin — x",
      outcome: "ok",
    });
    expect(seen).toEqual(["https://api.notion.com/v1/comments/comment-1"]);
  });

  test("timeout → text null (fail open)", async () => {
    globalThis.fetch = mock(
      (_u: unknown, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }),
    ) as unknown as typeof fetch;
    expect(await fetchCommentText("t", "c", { timeoutMs: 20 })).toEqual({ text: null, outcome: "timeout" });
  });

  test("network error / HTTP error / no token → text null (fail open)", async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError("network down");
    }) as unknown as typeof fetch;
    expect(await fetchCommentText("t", "c")).toEqual({ text: null, outcome: "error" });
    globalThis.fetch = mock(async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    expect(await fetchCommentText("t", "c")).toEqual({ text: null, outcome: "http_500" });
    expect(await fetchCommentText(undefined, "c")).toEqual({ text: null, outcome: "no_token" });
  });

  test("timeout on a John comment ⇒ decision passes (wake)", async () => {
    globalThis.fetch = mock(
      (_u: unknown, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }),
    ) as unknown as typeof fetch;
    const c = comment([{ id: JOHN, type: "person" }]);
    const env = { ...baseEnv, NOTION_API_TOKEN: "t" };
    const ctx = buildGateContext(c, "comment.created", JSON.stringify(c), env as Env);
    const cfg = echoFilterConfigFromEnv(env);
    const r = await resolveEchoCommentText(env, c, ctx, cfg, { timeoutMs: 20 });
    expect(r).toEqual({ text: null, outcome: "timeout" });
    expect(decideEchoFilter(c, ctx, cfg, r.text)).toEqual({ decision: "pass", reason: "john_authored" });
  });

  test("no fetch for fleet authors or payloads that carry text", async () => {
    const calls: unknown[] = [];
    globalThis.fetch = mock(async (u: unknown) => {
      calls.push(u);
      return new Response("{}");
    }) as unknown as typeof fetch;
    const env = { ...baseEnv, NOTION_API_TOKEN: "t" };
    for (const c of [comment([{ id: JRE_WORKERS }]), comment([{ id: JOHN }], { text: "hello" })]) {
      const ctx = buildGateContext(c, "comment.created", JSON.stringify(c), env as Env);
      const r = await resolveEchoCommentText(env, c, ctx, echoFilterConfigFromEnv(env));
      expect(r.text).toBeUndefined();
    }
    expect(calls).toHaveLength(0);
  });
});

describe("rule_skip row shape", () => {
  test("IDs + reason codes only; deterministic; high-signal; legacy reason on own_echo", () => {
    const c = comment([{ id: GROKBOT_FLEET_COMMENTS_BOT_ID, type: "bot" }], { text: TEXT_SENTINEL });
    const ctx = buildGateContext(c, "comment.created", JSON.stringify(c), baseEnv as Env);
    const v = decideEchoFilter(c, ctx, echoFilterConfigFromEnv(baseEnv));
    if (v.decision !== "drop") throw new Error("expected drop");
    const row = echoFilterRuleSkipRow(ctx, v);
    expect(row).toMatchObject({
      stream: "clef_wake_shadow",
      source: "echo_filter",
      decision: "rule_skip",
      rule: "fleet_bot_author",
      reason: "rule_skip:own_echo",
      notion_type: "comment.created",
      comment_id: ctx.commentId,
      scored: false,
      model: null,
      mode: "deterministic",
      legacy_gate: LEGACY_ECHO_GATE,
      legacy_reason: LEGACY_ECHO_REASON,
    });
    expect(JSON.stringify(row)).not.toContain(TEXT_SENTINEL);
    expect(isHighSignal(row)).toBe(true);
  });
});

// ---------- PROOF: worker path → gate_log ----------

const TOKEN_KEY = "notion_verification_token";
const COALESCE_BUF_KEY = "coalesce_buffer";

function makeEnv(store: Map<string, string>, extra: Partial<Env> = {}): Env {
  const kv = {
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
  return {
    RELAY_KV: kv,
    COS_WEBHOOK_URL: "https://cos.example/webhook",
    COS_WEBHOOK_AUTHORIZATION: "Bearer cos",
    SETUP_SECRET: "setup",
    NOTION_VERIFICATION_TOKEN: "secret_test_token",
    NOTION_API_TOKEN: "test-notion-token",
    CLEF_RING: "1",
    WAKE_GATE_KV_RING: "1",
    CLEF_DEFAULT_MODE: "off",
    ...tracked,
    ...extra,
  } as Env;
}

async function post(env: Env, payload: Record<string, unknown>): Promise<Response> {
  const body = JSON.stringify(payload);
  const sig = `sha256=${createHmac("sha256", "secret_test_token").update(body).digest("hex")}`;
  const { default: worker } = await import("../src/index.js");
  const res = await worker.fetch(
    new Request("https://relay/", {
      method: "POST",
      headers: { "X-Notion-Signature": sig, "content-type": "application/json", "user-agent": "notion" },
      body,
    }),
    env,
    { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}) } as unknown as ExecutionContext,
  );
  // Background shadow gates (pass path) get a tick; the 20 s coalesce timer is not awaited.
  await new Promise((r) => setTimeout(r, 20));
  return res;
}

/** Every row stored in the gate_log KV ring (gate_log:v1:*), after a forced flush. */
async function gateLogRows(env: Env, store: Map<string, string>): Promise<Record<string, unknown>[]> {
  await flushGateLogRing(env, { force: true });
  const rows: Record<string, unknown>[] = [];
  for (const [k, v] of store) {
    if (k.startsWith("gate_log:v1:")) rows.push(...((JSON.parse(v) as { rows: Record<string, unknown>[] }).rows ?? []));
  }
  return rows;
}

const echoRuleSkips = (rows: Record<string, unknown>[]) =>
  rows.filter((r) => r.source === "echo_filter" && r.decision === "rule_skip");

describe("PROOF: echo_filter drops land as rule_skip in gate_log", () => {
  const realFetch = globalThis.fetch;
  const origLog = console.log;
  let logs: string[] = [];
  let notionCalls: string[] = [];

  beforeEach(() => {
    resetGateLogRingForTests();
    resetSoftDailyCountersForTests();
    logs = [];
    notionCalls = [];
    console.log = ((l: unknown) => logs.push(String(l))) as typeof console.log;
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.startsWith("https://api.notion.com/v1/comments/")) {
        notionCalls.push(u);
        return Response.json({ object: "comment", rich_text: [{ plain_text: LOCK39_TEXT }] });
      }
      if (u.startsWith("https://cos.example")) throw new Error("must not forward in these tests");
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    console.log = origLog;
    globalThis.fetch = realFetch;
    resetGateLogRingForTests();
  });

  async function expectDropProof(payload: Record<string, unknown>, expected: Record<string, unknown>) {
    const store = new Map([[TOKEN_KEY, "secret_test_token"]]);
    const env = makeEnv(store);
    const res = await post(env, payload);
    expect(res.status).toBe(200);
    expect(store.get(COALESCE_BUF_KEY)).toBeUndefined(); // dropped before coalesce/enqueue
    const rows = await gateLogRows(env, store);
    expect(rows).toHaveLength(1); // exactly ONE gate_log row per drop
    const skips = echoRuleSkips(rows);
    expect(skips).toHaveLength(1);
    expect(skips[0]).toMatchObject({ stream: "clef_wake_shadow", scored: false, model: null, ...expected });
    origLog(`[proof] gate_log rule_skip: ${JSON.stringify(skips[0])}`);
    return skips[0];
  }

  test("PROOF 1: fleet-bot echo comment → rule_skip own_echo in gate_log", async () => {
    const c = comment([{ id: GROKBOT_FLEET_COMMENTS_BOT_ID, type: "bot" }]);
    await expectDropProof(c, {
      reason: "rule_skip:own_echo",
      rule: "fleet_bot_author",
      notion_type: "comment.created",
      comment_id: (c.entity as { id: string }).id,
    });
    expect(notionCalls).toHaveLength(0); // no body fetch for fleet authors
  });

  test("PROOF 2: LOCK-39 full-form prefix echo authored by John → rule_skip agent_prefix in gate_log", async () => {
    const c = comment([{ id: JOHN, type: "person" }]);
    await expectDropProof(c, {
      reason: "rule_skip:agent_prefix",
      rule: "lock39_full_prefix",
      notion_type: "comment.created",
      comment_id: (c.entity as { id: string }).id,
    });
    expect(notionCalls).toEqual([`https://api.notion.com/v1/comments/${(c.entity as { id: string }).id}`]);
    for (const l of logs) expect(l).not.toContain("triaged, moving to Done"); // body never logged
  });

  test("PROOF 3: untracked-parent properties_updated → rule_skip untracked_property_edit in gate_log", async () => {
    const p = propsUpdated({ type: "data_source", id: UNTRACKED_DS });
    await expectDropProof(p, {
      reason: "rule_skip:untracked_property_edit",
      rule: "untracked_parent",
      notion_type: "page.properties_updated",
      parent_data_source_id: UNTRACKED_DS,
      page_id: (p.entity as { id: string }).id,
    });
  });

  test("PROOF 4: page.moved fleet-bot echo → rule_skip own_echo in gate_log", async () => {
    const m = pageMoved([{ id: JRE_WORKERS, type: "bot" }]);
    await expectDropProof(m, {
      reason: "rule_skip:own_echo",
      rule: "fleet_bot_author",
      notion_type: "page.moved",
      page_id: (m.entity as { id: string }).id,
    });
  });

  async function expectReachesGate(payload: Record<string, unknown>, passReason: string) {
    const store = new Map([[TOKEN_KEY, "secret_test_token"]]);
    const env = makeEnv(store);
    const res = await post(env, payload);
    expect(res.status).toBe(200);
    expect(JSON.parse(store.get(COALESCE_BUF_KEY) ?? "[]")).toHaveLength(1); // enqueued for CoS
    const rows = await gateLogRows(env, store);
    expect(echoRuleSkips(rows)).toHaveLength(0);
    const pass = rows.find((r) => r.stream === "echo_filter");
    expect(pass).toMatchObject({ decision: "pass", reason: passReason });
    origLog(`[proof] reaches gate: ${JSON.stringify(pass)}`);
  }

  test("NEGATIVE 1: properties_updated authored by the Notion system bot still reaches the gate", async () => {
    const p = propsUpdated(
      { type: "data_source", id: FLEET_ARTIFACTS_DATA_SOURCE_ID },
      { authors: [{ id: NOTION_SYSTEM_BOT_ID, type: "bot" }] },
    );
    await expectReachesGate(p, "tracked_parent");
  });

  test("NEGATIVE 2: Submitted-property edit (Fleet: Artifacts) still reaches the gate", async () => {
    const p = propsUpdated({ type: "data_source", id: FLEET_ARTIFACTS_DATA_SOURCE_ID }, { updated: [";Xo<"] });
    await expectReachesGate(p, "submitted_changed");
  });

  test("fail open: comment body fetch error on a John comment → reaches the gate", async () => {
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      if (String(url).startsWith("https://api.notion.com/v1/comments/")) throw new TypeError("network down");
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    const store = new Map([[TOKEN_KEY, "secret_test_token"]]);
    const env = makeEnv(store);
    await post(env, comment([{ id: JOHN, type: "person" }]));
    expect(JSON.parse(store.get(COALESCE_BUF_KEY) ?? "[]")).toHaveLength(1);
    const rows = await gateLogRows(env, store);
    expect(rows.find((r) => r.stream === "echo_filter")).toMatchObject({
      decision: "pass",
      reason: "john_authored",
      body_fetch: "error",
    });
  });

  test("drops never produce a forward: flush-coalesce after drops sends nothing", async () => {
    const store = new Map([[TOKEN_KEY, "secret_test_token"]]);
    const env = makeEnv(store);
    await post(env, comment([{ id: JRE_WORKERS, type: "bot" }]));
    await post(env, pageMoved([{ id: JRE_WORKERS, type: "bot" }]));
    const { default: worker } = await import("../src/index.js");
    const res = await worker.fetch(
      new Request("https://relay/setup/flush-coalesce", { method: "POST", headers: { "X-Setup-Secret": "setup" } }),
      env,
      { waitUntil() {} } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(200);
    // The fetch mock throws on any COS call, so reaching here with no forward_history means no forward.
    expect(store.get("forward_history")).toBeUndefined();
  });
});
