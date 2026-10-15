import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { Env } from "../src/env.js";
import {
  GROKBOT_FLEET_COMMENTS_BOT_ID,
  PREFILTER_FETCH_MS,
  cosPrefilterLive,
  decideCosPrefilter,
  decideCosPrefilterAfterFetch,
  isAckOnly,
  lanePrefixRe,
} from "../src/wake-gate/cos-prefilter.js";
import type { GateEventContext } from "../src/wake-gate/gate-event-types.js";
import { buildGateContext, opaqueEventKey } from "../src/wake-gate/gate-orchestration.js";
import { PREFILTER_MUST_WAKE, gradeRelayWindow } from "../src/wake-gate/grade-relay.js";
import { MUST_WAKE_OVERRIDE_NAMES, clefHardOverrideReason } from "../src/wake-gate/clef-overrides.js";
import { resetPageFetchCache } from "../src/wake-gate/page-fetch-cache.js";
import { legacyClefHardOverrideReason } from "./legacy-clef-overrides.js";

const JOHN = "2e7d872b-594c-8161-92a2-00024b29e816";
const BOT = GROKBOT_FLEET_COMMENTS_BOT_ID;
const OTHER = "4e7d872b-594c-8161-92a2-00024b29e816";
const CFG_BOT = "5e7d872b-594c-8161-92a2-00024b29e816";
const SUB = "subm";
const NJ = "njid";

function ctx(type = "comment.created", over: Partial<GateEventContext> = {}): GateEventContext {
  return {
    notionType: type, rawBody: "{}", pageId: "p", johnUserIds: new Set([JOHN]), fleetCommentsBotIds: new Set([BOT]),
    submittedPropertyIds: new Set(), needsJohnPropertyIds: new Set(), nonSubmittedPropertyIds: new Set(),
    updatedPropertyIds: [], isCommentEvent: type.startsWith("comment."), authorId: OTHER, webhookAuthorIds: [OTHER],
    propertiesAvailable: true, properties: { needsJohn: false }, ...over,
  };
}
const txt = (t: string) => ({ data: { text: t } });
const decide = (c: GateEventContext, p: Record<string, unknown>) => decideCosPrefilter(c, p, {});

describe("ack-only", () => {
  test.each(["thanks", "Thanks!", "thank you 🙏", "ok", "OK.", "okay thanks", "+1", "+ 1", "👍", "👍🏽🎉", "🙏", "✅", "❤️", "👌🙌", "got it, thanks", "ok 👍", "ok ok", "ty", "noted."])(
    "%p is an ack",
    (t) => expect(isAckOnly(t)).toBe(true),
  );
  test.each(["", "   ", "ok?", "done?", "ok but change the title", "done", "Done ✅", "will do", "all done", "done thanks", "👎", "❌", "🛑", "⚠️", "❓", "ok 👎", "👍❌", "🤔", "thanks — please also send the deck", "not done", "no", "stop", "ship it", "+2 on the second option", "x".repeat(70)])(
    "%p is not an ack",
    (t) => expect(isAckOnly(t)).toBe(false),
  );
  test("null (no text in payload) is not an ack", () => expect(isAckOnly(null)).toBe(false));
  test("comment with ack text from a non-John author → would_drop ack_only", () => {
    expect(decide(ctx(), txt("thanks!"))).toEqual({ decision: "would_drop", reason: "ack_only" });
  });
  test("rich_text ack and rich_text with a mention node", () => {
    expect(decide(ctx(), { data: { rich_text: [{ plain_text: "👍" }] } }).decision).toBe("would_drop");
    const withMention = { data: { rich_text: [{ type: "mention", mention: { user: { id: OTHER } } }, { plain_text: " thanks" }] } };
    expect(decide(ctx(), withMention).decision).toBe("pass");
  });
  test("comment.updated ack also drops; comment.deleted never does", () => {
    expect(decide(ctx("comment.updated"), txt("ok")).decision).toBe("would_drop");
    expect(decide(ctx("comment.deleted"), txt("ok")).decision).toBe("pass");
  });
  test("no text → pass comment_text_unavailable", () => {
    expect(decide(ctx(), { data: {} })).toEqual({ decision: "pass", reason: "comment_text_unavailable" });
  });
});

describe("self-echo", () => {
  test("Fleet Comments bot author → self_echo_bot (built-in id even if env list is empty)", () => {
    const c = ctx("comment.created", { authorId: BOT, webhookAuthorIds: [BOT], fleetCommentsBotIds: new Set() });
    expect(decide(c, txt("Here is the full plan for next week"))).toEqual({ decision: "would_drop", reason: "self_echo_bot" });
  });
  test("mixed authors (bot + human) are not a pure self-echo", () => {
    const c = ctx("comment.created", { authorId: BOT, webhookAuthorIds: [BOT, OTHER] });
    expect(decide(c, txt("please review the attached")).decision).toBe("pass");
  });
  const botCtx = (id = CFG_BOT) =>
    ctx("comment.created", { authorId: id, webhookAuthorIds: [id], fleetCommentsBotIds: new Set([BOT, CFG_BOT]) });
  test.each(["CoS: posted the summary", "cos — handled", "[CoS] PR opened", "**Chief of Staff:** synced", "[chief of staff] noted"])(
    "configured-bot comment with CoS lane prefix %p → self_echo_lane",
    (t) => expect(decide(botCtx(), txt(t))).toEqual({ decision: "would_drop", reason: "self_echo_lane" }),
  );
  test.each(["CoS: can you look at the deck", "Chief of Staff — please send it", "[CoS] follow up?", "cos — handled"])(
    "human comment %p with a lane prefix passes",
    (t) => expect(decide(ctx(), txt(t)).decision).toBe("pass"),
  );
  test.each(["[BCH] PR opened", "AS - reviewed", "dr eggbot: day-2 notes", "Clef: scored"])(
    "other lanes' prefixes %p are not CoS self-echo, even from a bot",
    (t) => expect(decide(botCtx(), txt(t)).decision).toBe("pass"),
  );
  test("configured (non-Fleet-Comments) bot without a lane prefix passes", () => {
    expect(decide(botCtx(), txt("Please review the attached plan")).decision).toBe("pass");
  });
  test.each(["Cosine similarity is off", "As discussed, please send it", "Can CoS: look at this", "Clefs are hard"])(
    "%p is not a lane prefix",
    (t) => expect(decide(botCtx(), txt(t)).decision).toBe("pass"),
  );
  test("COS_PREFILTER_LANE_PREFIXES adds prefixes", () => {
    expect(lanePrefixRe({ COS_PREFILTER_LANE_PREFIXES: "Ops Bot" }).test("Ops Bot: synced")).toBe(true);
    expect(lanePrefixRe({}).test("Ops Bot: synced")).toBe(false);
    expect(lanePrefixRe({}).test("BCH: synced")).toBe(false);
  });
});

describe("non-actionable property edits (reuses the properties_updated rule)", () => {
  const ids = { submittedPropertyIds: new Set([SUB]), needsJohnPropertyIds: new Set([NJ]) };
  test("neither Submitted nor Needs John changed → would_drop", () => {
    const c = ctx("page.properties_updated", { ...ids, isCommentEvent: false, updatedPropertyIds: ["other"] });
    expect(decide(c, {})).toEqual({ decision: "would_drop", reason: "non_actionable_property" });
  });
  test("Submitted / Needs John changes wake", () => {
    for (const id of [SUB, NJ]) {
      const c = ctx("page.properties_updated", { ...ids, isCommentEvent: false, updatedPropertyIds: ["other", id] });
      expect(decide(c, {}).decision).toBe("pass");
    }
  });
  test("rule inert until both id sets are configured, or when no ids are listed", () => {
    const c1 = ctx("page.properties_updated", { isCommentEvent: false, updatedPropertyIds: ["other"], submittedPropertyIds: new Set([SUB]) });
    expect(decide(c1, {}).decision).toBe("pass");
    const c2 = ctx("page.properties_updated", { ...ids, isCommentEvent: false, updatedPropertyIds: [] });
    expect(decide(c2, {}).decision).toBe("pass");
  });
});

describe("hard overrides always win", () => {
  test("JOHN_NOTION_USER_IDS empty → fail open, nothing drops (matches Clef john_ids_unset)", () => {
    const none = { johnUserIds: new Set<string>() };
    expect(decide(ctx("comment.created", none), txt("thanks"))).toEqual({ decision: "pass", reason: "override:john_ids_unset" });
    const botC = ctx("comment.created", { ...none, authorId: BOT, webhookAuthorIds: [BOT] });
    expect(decide(botC, txt("CoS: done")).reason).toBe("override:john_ids_unset");
    const e = { FLEET_COMMENTS_BOT_NOTION_USER_IDS: BOT } as Env;
    expect(decide(buildGateContext(ackComment(), "comment.created", "{}", e), ackComment()).reason).toBe("override:john_ids_unset");
  });
  test.each([
    ["needs_john_or_sensitive", { properties: { sensitive: true } }, {}],
    ["notion_page_unreadable", { properties: { adDocsParseOk: false } }, {}],
    ["irreversible_action_field", { properties: { kind: "Publish" } }, {}],
    ["notion_fetch_failed", { notionFetchFailReason: "notion_fetch_failed" }, {}],
    ["bot_mention", {}, { rich_text: [{ type: "mention", mention: { type: "user", user: { id: BOT, type: "bot" } } }] }],
  ] as const)("shared must-wake override %p beats an ack", (name, over, extra) => {
    const c = ctx("comment.created", over as Partial<GateEventContext>);
    expect(decide(c, { data: { text: "thanks", ...extra } }).reason).toBe(`override:${name}`);
  });
  test("the Clef gate uses the same shared list", () => {
    const c = ctx("comment.created", { properties: { kind: "Publish" } });
    expect(clefHardOverrideReason(c, txt("thanks"), true, [])).toBe("irreversible_action_field");
    for (const n of MUST_WAKE_OVERRIDE_NAMES) expect(PREFILTER_MUST_WAKE.has(n)).toBe(true);
  });
  test("John-authored ack is never dropped", () => {
    const c = ctx("comment.created", { authorId: JOHN, webhookAuthorIds: [JOHN] });
    expect(decide(c, txt("ok"))).toEqual({ decision: "pass", reason: "override:john_authored" });
  });
  test("John @mention (node or plain text) beats ack and self-echo", () => {
    const mention = { data: { rich_text: [{ type: "mention", mention: { user: { id: JOHN } } }, { plain_text: " thanks" }] } };
    expect(decide(ctx(), mention).reason).toBe("override:john_mention");
    const botC = ctx("comment.created", { authorId: BOT, webhookAuthorIds: [BOT] });
    expect(decide(botC, mention).reason).toBe("override:john_mention");
    expect(decide(botC, txt("CoS: @John please approve")).reason).toBe("override:john_mention");
  });
  test("Needs John set on the page beats a non-actionable property edit and an ack", () => {
    const c = ctx("page.properties_updated", {
      submittedPropertyIds: new Set([SUB]), needsJohnPropertyIds: new Set([NJ]), isCommentEvent: false,
      updatedPropertyIds: ["other"], properties: { needsJohn: true },
    });
    expect(decide(c, {}).decision).toBe("pass");
    expect(decide(ctx("comment.created", { needsJohnNow: true }), txt("ok")).reason).toBe("override:needs_john_or_sensitive");
  });
  test("Submitted changed (opaque update, no ids listed) passes", () => {
    const c = ctx("page.properties_updated", { isCommentEvent: false, updatedPropertyIds: [] });
    expect(decide(c, {}).reason).toBe("override:submitted_changed");
  });
});

describe("event key", () => {
  test("opaque, stable, prefers the event id", () => {
    const a = opaqueEventKey({ id: "evt-1" }, "x");
    expect(a).toBe(opaqueEventKey({ id: "evt-1" }, "y"));
    expect(a).not.toBe(opaqueEventKey({ id: "evt-2" }, "x"));
    expect(a).not.toContain("evt");
    const e = { JOHN_NOTION_USER_IDS: JOHN } as Env;
    expect(buildGateContext({ id: "evt-1" }, "comment.created", "{}", e).eventKey).toBe(a);
  });
});

describe("gradeRelayWindow: prefilter", () => {
  const drop = (k: string, reason = "ack_only") => ({ stream: "cos_prefilter", event_key: k, decision: "would_drop", reason, mode: "shadow" });
  const clef = (k: string, over: Record<string, unknown>) => ({ stream: "clef_wake_shadow", ts: "2026-10-14T10:00:00Z", event_key: k, ...over });
  test("drops Clef agrees with pass; coverage reported per reason", () => {
    const g = gradeRelayWindow([
      drop("a"), clef("a", { reason: "clef_ok", clef_decision: "would_skip", rule_decision: "would_wake" }),
      drop("b", "self_echo_bot"), clef("b", { reason: "fleet_bot_author", rule_decision: "would_wake" }),
      { stream: "cos_prefilter", event_key: "c", decision: "pass", reason: "actionable_comment" },
    ]);
    expect(g.pass).toBe(true);
    expect(g.prefilter).toMatchObject({ events: 3, would_drop: 2, scored_by_reason: { ack_only: 1 }, unscored_by_reason: { self_echo_bot: 1 } });
  });
  test("Clef would_wake on a dropped event → prefilter_false_drop (wake path and scored skip check)", () => {
    const g1 = gradeRelayWindow([drop("a"), clef("a", { reason: "clef_ok", clef_decision: "would_wake", rule_decision: "would_wake" })]);
    expect(g1.fail_reasons).toEqual(["prefilter_false_drop"]);
    const g2 = gradeRelayWindow([
      drop("b", "self_echo_lane"),
      clef("b", { decision: "rule_skip", reason: "rule_skip:clef_ok", scored: true, candidate_false_skip: true }),
    ]);
    expect(g2.fail_reasons).toContain("prefilter_false_drop");
    expect(g2.prefilter.false_drops_by_reason).toEqual({ self_echo_lane: 1 });
  });
  test("a drop on an event Clef marked as a hard override → prefilter_dropped_override", () => {
    for (const reason of ["john_mention", "submitted_changed", "needs_john_changed;clef_mode_x"]) {
      const g = gradeRelayWindow([drop("a"), clef("a", { reason, rule_decision: "would_wake", clef_decision: "would_wake" })]);
      expect(g.fail_reasons).toEqual(["prefilter_dropped_override"]);
    }
  });
});

// End-to-end through the worker: shadow forwards, live drops.
const SECRET = "secret_test_token";
function kvEnv(over: Partial<Env> = {}): { env: Env; store: Map<string, string> } {
  const store = new Map<string, string>();
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v); },
    delete: async (k: string) => { store.delete(k); },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async (k: string) => ({ value: store.get(k) ?? null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
  return {
    store,
    env: {
      RELAY_KV: kv, COS_WEBHOOK_URL: "https://cos.example/webhook", COS_WEBHOOK_AUTHORIZATION: "Bearer cos",
      SETUP_SECRET: "setup", NOTION_VERIFICATION_TOKEN: SECRET, JOHN_NOTION_USER_IDS: JOHN,
      FLEET_COMMENTS_BOT_NOTION_USER_IDS: BOT, NOTION_API_TOKEN: "t", ...over,
    },
  };
}
async function post(env: Env, payload: Record<string, unknown>): Promise<Response> {
  const body = JSON.stringify(payload);
  const sig = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
  const { default: worker } = await import("../src/index.js");
  return worker.fetch(
    new Request("https://relay/", { method: "POST", headers: { "X-Notion-Signature": sig, "content-type": "application/json" }, body }),
    env,
    { waitUntil() {} } as unknown as ExecutionContext,
  );
}
const ackComment = (authorId = OTHER) => ({
  id: "evt-ack", type: "comment.created", authors: [{ id: authorId, type: "person" }],
  entity: { id: "comment-1", type: "comment" }, data: { page_id: "page-1", text: "thanks!" },
});

const page = (needsJohn: boolean) => ({
  object: "page", id: "page-1", parent: { type: "page_id", page_id: "x" },
  properties: { "Needs John": { id: "nj", type: "checkbox", checkbox: needsJohn } },
});
let pageResponse: (init?: RequestInit) => Response | Promise<Response> = () => Response.json(page(false));
let notionFetches = 0;

describe("worker: shadow vs live", () => {
  let logs: string[] = [];
  let orig: typeof console.log;
  let origFetch: typeof fetch;
  beforeEach(() => {
    logs = []; orig = console.log; console.log = ((l: unknown) => logs.push(String(l))) as typeof console.log;
    origFetch = globalThis.fetch; notionFetches = 0; pageResponse = () => Response.json(page(false));
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url instanceof Request ? url.url : url).startsWith("https://api.notion.com/")) { notionFetches += 1; return pageResponse(init); }
      return new Response("ok");
    }) as typeof fetch;
  });
  afterEach(() => { console.log = orig; globalThis.fetch = origFetch; });
  const prefilterRows = () => logs.filter((l) => l.includes('"stream":"cos_prefilter"')).map((l) => JSON.parse(l));

  test("SHADOW (default): logs would_drop, still buffers the forward", async () => {
    const { env, store } = kvEnv();
    expect((await post(env, ackComment())).status).toBe(200);
    expect(prefilterRows()).toMatchObject([{ decision: "would_drop", reason: "ack_only", mode: "shadow", dropped: false }]);
    expect(store.get("coalesce_buffer")).toContain("comment.created");
    expect(logs.join("\n")).not.toContain("thanks!");
  });
  test("LIVE (COS_PREFILTER_LIVE=1): drops the forward", async () => {
    const { env, store } = kvEnv({ COS_PREFILTER_LIVE: "1" });
    expect((await post(env, ackComment())).status).toBe(200);
    expect(prefilterRows()).toMatchObject([{ decision: "would_drop", mode: "live", dropped: true }]);
    expect(store.get("coalesce_buffer")).toBeUndefined();
    expect(logs.some((l) => l.includes("dropped_cos_prefilter"))).toBe(true);
  });
  test("LIVE: John's ack still forwards", async () => {
    const { env, store } = kvEnv({ COS_PREFILTER_LIVE: "1" });
    await post(env, ackComment(JOHN));
    expect(prefilterRows()).toMatchObject([{ decision: "pass", reason: "override:john_authored" }]);
    expect(store.get("coalesce_buffer")).toContain("comment.created");
  });
});

describe("worker: decision after the page fetch", () => {
  let logs: string[] = [];
  let orig: typeof console.log;
  let origFetch: typeof fetch;
  beforeEach(() => {
    logs = []; orig = console.log; console.log = ((l: unknown) => logs.push(String(l))) as typeof console.log;
    origFetch = globalThis.fetch; notionFetches = 0; pageResponse = () => Response.json(page(false));
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url instanceof Request ? url.url : url).startsWith("https://api.notion.com/")) { notionFetches += 1; return pageResponse(init); }
      return new Response("ok");
    }) as typeof fetch;
  });
  afterEach(() => { console.log = orig; globalThis.fetch = origFetch; });
  const rows = (stream: string) => logs.filter((l) => l.includes(`"stream":"${stream}"`)).map((l) => JSON.parse(l));

  test("ack on a page with Needs John checked passes (real property from the fetch)", async () => {
    pageResponse = () => Response.json(page(true));
    const { env, store } = kvEnv({ COS_PREFILTER_LIVE: "1" });
    await post(env, ackComment());
    expect(notionFetches).toBe(1);
    expect(rows("cos_prefilter")).toMatchObject([{ decision: "pass", reason: "override:needs_john_or_sensitive" }]);
    expect(store.get("coalesce_buffer")).toContain("comment.created");
  });
  test("page fetch fails → pass (fail open)", async () => {
    pageResponse = () => new Response("nope", { status: 500 });
    const { env, store } = kvEnv({ COS_PREFILTER_LIVE: "1" });
    await post(env, ackComment());
    expect(rows("cos_prefilter")).toMatchObject([{ decision: "pass", reason: "override:notion_fetch_failed" }]);
    expect(store.get("coalesce_buffer")).toContain("comment.created");
  });
  test("page fetch times out at the short prefilter budget → pass (fail open), latency logged", async () => {
    pageResponse = (init) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    const { env, store } = kvEnv({ COS_PREFILTER_LIVE: "1" });
    const t0 = Date.now();
    await post(env, ackComment());
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(PREFILTER_FETCH_MS - 50);
    expect(took).toBeLessThan(PREFILTER_FETCH_MS + 1_000);
    expect(rows("cos_prefilter")).toMatchObject([
      { decision: "pass", reason: "override:notion_fetch_timeout", fetch_outcome: "timeout" },
    ]);
    const lat = logs.filter((l) => l.includes('"event":"notion_page_fetch"')).map((l) => JSON.parse(l));
    expect(lat).toMatchObject([{ caller: "cos_prefilter", timeout_ms: PREFILTER_FETCH_MS, outcome: "timeout" }]);
    expect(lat[0].ms).toBeGreaterThanOrEqual(PREFILTER_FETCH_MS - 50);
    expect(logs.join("\n")).not.toContain("page-1");
    expect(store.get("coalesce_buffer")).toContain("comment.created");
  });
  test("Notion 429 → pass (fail open), outcome http_429", async () => {
    pageResponse = () => new Response("slow down", { status: 429, headers: { "retry-after": "1" } });
    const { env, store } = kvEnv({ COS_PREFILTER_LIVE: "1" });
    await post(env, ackComment());
    expect(rows("cos_prefilter")).toMatchObject([
      { decision: "pass", reason: "override:notion_fetch_failed", fetch_outcome: "http_429" },
    ]);
    expect(logs.some((l) => l.includes('"outcome":"http_429"'))).toBe(true);
    expect(store.get("coalesce_buffer")).toContain("comment.created");
  });
  test("one Notion GET per page per request, shared by the prefilter and the shadow gates", async () => {
    resetPageFetchCache(); // the ad-docs comment-parent cache would otherwise skip the shadow fetch
    const { env } = kvEnv();
    const body = JSON.stringify(ackComment());
    const sig = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
    const { default: worker } = await import("../src/index.js");
    const pending: Promise<unknown>[] = [];
    await worker.fetch(
      new Request("https://relay/", { method: "POST", headers: { "X-Notion-Signature": sig, "content-type": "application/json" }, body }),
      env,
      { waitUntil(p: Promise<unknown>) { pending.push(p); } } as unknown as ExecutionContext,
    );
    expect(notionFetches).toBe(1); // prefilter fetched before the 200
    await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, 300))]);
    expect(logs.some((l) => l.includes("ad_docs_wake_gate_shadow"))).toBe(true); // shadow gate ran
    expect(notionFetches).toBe(1); // ... and reused it
    expect(rows("cos_prefilter")[0]).toMatchObject({ fetch_outcome: "ok", fetch_cached: 0 });
  });
  test("a second delivery of the same event fetches again (memo is per request)", async () => {
    const { env } = kvEnv();
    await post(env, ackComment());
    await post(env, ackComment());
    expect(notionFetches).toBe(2);
  });
  test("no NOTION_API_TOKEN → pass (fail open)", async () => {
    const { env } = kvEnv({ COS_PREFILTER_LIVE: "1", NOTION_API_TOKEN: undefined });
    await post(env, ackComment());
    expect(rows("cos_prefilter")).toMatchObject([{ decision: "pass", reason: "override:notion_token_missing" }]);
  });
  test("non-candidate events skip the extra fetch", async () => {
    const { env } = kvEnv();
    await post(env, { ...ackComment(), data: { page_id: "page-1", text: "please send the deck" } });
    // No prefilter fetch (the shadow gates may still fetch in waitUntil).
    expect(logs.some((l) => l.includes('"caller":"cos_prefilter"'))).toBe(false);
    expect(rows("cos_prefilter")).toMatchObject([{ decision: "pass", reason: "actionable_comment" }]);
    expect(rows("cos_prefilter")[0].fetch_outcome).toBeUndefined();
  });
  test("gate_log events: dropped first, no prefilter row (counts not inflated)", async () => {
    const GL = "6e7d872b-594c-8161-92a2-00024b29e816";
    const { env } = kvEnv({ GATE_LOG_DATA_SOURCE_IDS: GL });
    await post(env, { ...ackComment(), data: { page_id: "page-1", text: "thanks", parent: { data_source_id: GL } } });
    expect(logs.some((l) => l.includes("dropped_gate_log_event"))).toBe(true);
    expect(rows("cos_prefilter")).toEqual([]);
  });
  test("the Clef row and the prefilter row share an event_key", async () => {
    const { env } = kvEnv();
    const body = JSON.stringify(ackComment());
    const sig = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
    const { default: worker } = await import("../src/index.js");
    const pending: Promise<unknown>[] = [];
    await worker.fetch(
      new Request("https://relay/", { method: "POST", headers: { "X-Notion-Signature": sig, "content-type": "application/json" }, body }),
      env,
      { waitUntil(p: Promise<unknown>) { pending.push(p); } } as unknown as ExecutionContext,
    );
    // Shadow gates run in waitUntil; the Clef row is logged early (later steps may wait on AI / flush).
    await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, 300))]);
    const pre = rows("cos_prefilter");
    const clef = rows("clef_wake_shadow");
    expect(pre).toHaveLength(1);
    expect(clef.length).toBeGreaterThan(0);
    expect(pre[0].event_key).toMatch(/^ev:/);
    for (const r of clef) expect(r.event_key).toBe(pre[0].event_key);
    expect(pre[0].event_key).toBe(opaqueEventKey(ackComment(), body));
  });
});

describe("COS_PREFILTER_LIVE flag", () => {
  test.each(["1", "true", "TRUE", " true "])("%p → LIVE", (v) => expect(cosPrefilterLive({ COS_PREFILTER_LIVE: v })).toBe(true));
  test.each([undefined, "", "0", "false", "yes", "on", "2"])("%p → SHADOW", (v) =>
    expect(cosPrefilterLive({ COS_PREFILTER_LIVE: v })).toBe(false));
});

describe("decideCosPrefilterAfterFetch (unit)", () => {
  test("pass verdicts return without fetching", async () => {
    const c = ctx();
    expect(await decideCosPrefilterAfterFetch({} as Env, c, txt("please send"))).toMatchObject({ decision: "pass" });
    expect(c.notionFetchFailReason).toBeUndefined();
  });
});

describe("gradeRelayWindow: prefilter fetch failures", () => {
  test("counts fetches, failures, rate and outcome breakdown", () => {
    const row = (fetch_outcome?: string) => ({
      stream: "cos_prefilter", event_key: "k", decision: "pass", reason: "x", ...(fetch_outcome ? { fetch_outcome } : {}),
    });
    const g = gradeRelayWindow([row("ok"), row("ok"), row("timeout"), row("http_429"), row()]);
    expect(g.prefilter).toMatchObject({
      events: 5, fetches: 4, fetch_failures: 2, fetch_failure_rate: 0.5,
      fetch_failures_by_outcome: { timeout: 1, http_429: 1 },
    });
    expect(gradeRelayWindow([row()]).prefilter.fetch_failure_rate).toBe(0);
  });
});

describe("Clef overrides: reordered labels, same events", () => {
  // Every override input, alone and in pairs: the new order may pick a different label, but an event is
  // an override (non-null) exactly when it was before (540bd32 frozen copy).
  const BOTX = "7e7d872b-594c-8161-92a2-00024b29e816";
  const mentionJohn = { type: "mention", mention: { user: { id: JOHN } } };
  const mentionBot = { type: "mention", mention: { type: "user", user: { id: BOTX, type: "bot" } } };
  const features: Record<string, { c?: Partial<GateEventContext>; p?: Record<string, unknown>; type?: string }> = {
    john_author: { c: { authorId: JOHN, webhookAuthorIds: [JOHN] } },
    bot_author: { c: { authorId: BOT, webhookAuthorIds: [BOT] } },
    john_ids_unset: { c: { johnUserIds: new Set() } },
    bot_ids_unset: { c: { fleetCommentsBotIds: new Set() } },
    fetch_fail: { c: { notionFetchFailReason: "notion_fetch_timeout" } },
    no_text: { p: { data: {} } },
    john_mention: { p: { data: { rich_text: [mentionJohn, { plain_text: " hi" }] } } },
    bot_mention: { p: { data: { rich_text: [mentionBot, { plain_text: " hi" }] } } },
    needs_john: { c: { properties: { needsJohn: true } } },
    sensitive: { c: { properties: { sensitive: true } } },
    unreadable: { c: { properties: { adDocsParseOk: false } } },
    irreversible: { c: { properties: { kind: "Send" } } },
    source_repo: { c: { properties: { sourceRepo: "jre" } } },
    props_unavailable: { c: { propertiesAvailable: false, properties: {} } },
    adopted: { c: { fleetLocksFields: { statusName: "Adopted" } as GateEventContext["fleetLocksFields"] } },
    submitted: { type: "page.properties_updated", c: { isCommentEvent: false, updatedPropertyIds: [] } },
    nj_changed: {
      type: "page.properties_updated",
      c: { isCommentEvent: false, updatedPropertyIds: [NJ], needsJohnPropertyIds: new Set([NJ]), submittedPropertyIds: new Set([SUB]) },
    },
    plain: {},
  };
  const build = (names: string[]) => {
    let type = "comment.created";
    let over: Partial<GateEventContext> = {};
    let p: Record<string, unknown> = txt("thanks");
    for (const n of names) {
      const f = features[n]!;
      if (f.type) type = f.type;
      over = { ...over, ...f.c, properties: { ...(over.properties ?? { needsJohn: false }), ...(f.c?.properties ?? {}) } };
      if (f.c && "propertiesAvailable" in f.c) over.properties = {};
      if (f.p) p = f.p;
    }
    const c = ctx(type, { ...over, isCommentEvent: over.isCommentEvent ?? type.startsWith("comment.") });
    return { c, p };
  };
  const names = Object.keys(features);
  const combos: string[][] = names.map((n) => [n]);
  for (let i = 0; i < names.length; i += 1) for (let j = i + 1; j < names.length; j += 1) combos.push([names[i]!, names[j]!]);
  test.each(combos.map((c) => [c.join("+"), c] as const))("%s", (_label, combo) => {
    const { c, p } = build([...combo]);
    const now = clefHardOverrideReason(c, p, true, []);
    const before = legacyClefHardOverrideReason(c, p, true, []);
    expect(now === null).toBe(before === null);
  });
  test("labels did change for some combos (documented in the PR)", () => {
    const { c, p } = build(["props_unavailable", "bot_mention"]);
    expect(legacyClefHardOverrideReason(c, p, true, [])).toBe("properties_unavailable");
    expect(clefHardOverrideReason(c, p, true, [])).toBe("bot_mention");
  });
});
