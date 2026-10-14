import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { Env } from "../src/env.js";
import {
  GROKBOT_FLEET_COMMENTS_BOT_ID,
  decideCosPrefilter,
  isAckOnly,
  lanePrefixRe,
} from "../src/wake-gate/cos-prefilter.js";
import type { GateEventContext } from "../src/wake-gate/gate-event-types.js";
import { buildGateContext, opaqueEventKey } from "../src/wake-gate/gate-orchestration.js";
import { gradeRelayWindow } from "../src/wake-gate/grade-relay.js";

const JOHN = "2e7d872b-594c-8161-92a2-00024b29e816";
const BOT = GROKBOT_FLEET_COMMENTS_BOT_ID;
const OTHER = "4e7d872b-594c-8161-92a2-00024b29e816";
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
  test.each(["thanks", "Thanks!", "thank you 🙏", "ok", "OK.", "okay thanks", "+1", "+ 1", "👍", "👍🏽🎉", "done", "Done ✅", "got it, thanks", "ok ok", "ty", "noted."])(
    "%p is an ack",
    (t) => expect(isAckOnly(t)).toBe(true),
  );
  test.each(["", "   ", "ok?", "done?", "ok but change the title", "thanks — please also send the deck", "not done", "no", "stop", "ship it", "+2 on the second option", "x".repeat(70)])(
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
  test.each(["CoS: posted the summary", "cos — handled", "[BCH] PR opened", "**Chief of Staff:** done", "AS - reviewed", "dr eggbot: day-2 notes"])(
    "lane prefix %p → self_echo_lane",
    (t) => expect(decide(ctx(), txt(t))).toEqual({ decision: "would_drop", reason: "self_echo_lane" }),
  );
  test.each(["Cosine similarity is off", "As discussed, please send it", "BCHX: unrelated", "Can CoS: look at this", "Clefs are hard"])(
    "%p is not a lane prefix",
    (t) => expect(decide(ctx(), txt(t)).decision).toBe("pass"),
  );
  test("COS_PREFILTER_LANE_PREFIXES adds prefixes", () => {
    expect(lanePrefixRe({ COS_PREFILTER_LANE_PREFIXES: "Ops Bot" }).test("Ops Bot: synced")).toBe(true);
    expect(lanePrefixRe({}).test("Ops Bot: synced")).toBe(false);
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
    expect(decide(ctx("comment.created", { needsJohnNow: true }), txt("ok")).reason).toBe("override:needs_john");
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
      FLEET_COMMENTS_BOT_NOTION_USER_IDS: BOT, ...over,
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

describe("worker: shadow vs live", () => {
  let logs: string[] = [];
  let orig: typeof console.log;
  beforeEach(() => { logs = []; orig = console.log; console.log = ((l: unknown) => logs.push(String(l))) as typeof console.log; });
  afterEach(() => { console.log = orig; });
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
