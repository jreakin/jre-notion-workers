import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  aggregateRuleDecision,
  itemDedupeKey,
  noteItemEvent,
  resetClefPageEventCountsForTests,
  runClefShadowWakeGate,
} from "../src/wake-gate/clef-wake-gate.js";
import { decideCommentsEchoGate } from "../src/wake-gate/comments-echo-gate.js";
import { clefHardOverrideReason } from "../src/wake-gate/clef-overrides.js";
import { needsJohnPropertyChanged, submittedPropertyChanged } from "../src/wake-gate/gate-context-safety.js";
import type { Env } from "../src/env.js";
import type { GateEventContext, WakeGateDecision } from "../src/wake-gate/gate-event-types.js";

const JOHN = "2e7d872b-594c-8161-92a2-00024b29e816";
const BOT = "3d87d7f5-6298-8165-8af9-0027a153ccbd";
const PAGE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function ctx(over: Partial<GateEventContext> = {}): GateEventContext {
  return {
    notionType: "page.properties_updated",
    rawBody: "{}",
    pageId: PAGE,
    johnUserIds: new Set([JOHN]),
    fleetCommentsBotIds: new Set([BOT]),
    submittedPropertyIds: new Set(["SUBM"]),
    needsJohnPropertyIds: new Set(["NJ%3D"]),
    nonSubmittedPropertyIds: new Set(),
    updatedPropertyIds: ["Stat"],
    isCommentEvent: false,
    propertiesAvailable: true,
    properties: { needsJohn: false, sensitive: false },
    ...over,
  };
}

function d(gate: string, decision: WakeGateDecision["decision"], reason: string): WakeGateDecision {
  return { gate_name: gate, decision, reason, inputs: {}, ts: "", mode: "shadow" };
}

function env(over: Partial<Env> = {}): Env {
  return {
    RELAY_KV: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
      getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
    } as unknown as KVNamespace,
    COS_WEBHOOK_URL: "u",
    COS_WEBHOOK_AUTHORIZATION: "a",
    SETUP_SECRET: "s",
    CLEF_DEFAULT_MODE: "shadow",
    ...over,
  };
}

describe("properties_updated: skip when neither Submitted nor Needs John changed (shadow)", () => {
  test("other property only → echo gate would_skip", () => {
    const r = decideCommentsEchoGate(ctx());
    expect(r.decision).toBe("would_skip");
    expect(r.reason).toBe("no_submitted_or_needs_john_change");
  });
  test("Submitted id listed → wake submitted_changed", () => {
    const r = decideCommentsEchoGate(ctx({ updatedPropertyIds: ["Stat", "SUBM"] }));
    expect(r.reason).toBe("submitted_changed");
  });
  test("Needs John id listed (URL-encoded either side) → wake + hard override", () => {
    const c = ctx({ updatedPropertyIds: ["NJ="] });
    expect(decideCommentsEchoGate(c).reason).toBe("needs_john_changed");
    expect(clefHardOverrideReason(c, {}, true, [])).toBe("needs_john_changed");
  });
  test("inert when NEEDS_JOHN ids unset, SUBMITTED unset, or ids not listed (old wake)", () => {
    expect(decideCommentsEchoGate(ctx({ needsJohnPropertyIds: new Set() })).decision).toBe("would_wake");
    expect(decideCommentsEchoGate(ctx({ needsJohnPropertyIds: undefined })).decision).toBe("would_wake");
    expect(decideCommentsEchoGate(ctx({ submittedPropertyIds: new Set() })).decision).toBe("would_wake");
    expect(decideCommentsEchoGate(ctx({ updatedPropertyIds: [] })).decision).toBe("would_wake");
    expect(submittedPropertyChanged(ctx({ updatedPropertyIds: [] }))).toBe(true);
  });
  test("John comment still wakes; non-properties events unaffected", () => {
    const c = ctx({ notionType: "comment.created", isCommentEvent: true, authorId: JOHN, webhookAuthorIds: [JOHN] });
    expect(decideCommentsEchoGate(c).decision).toBe("would_wake");
  });
  test("aggregate: not_fleet_locks wake does not outvote an explicit skip; other wakes still do", () => {
    const skip = d("notion_comments_echo_drop", "would_skip", "no_submitted_or_needs_john_change");
    expect(aggregateRuleDecision([skip, d("fleet_locks_adopted_change", "would_wake", "not_fleet_locks")])).toBe("would_skip");
    expect(aggregateRuleDecision([skip, d("fleet_locks_adopted_change", "would_wake", "fleet_locks_data_source_unset")])).toBe("would_wake");
    expect(aggregateRuleDecision([skip, d("fleet_locks_adopted_change", "would_wake", "notion_page_unreadable")])).toBe("would_wake");
    expect(aggregateRuleDecision([skip, d("fleet_locks_adopted_change", "would_wake", "adopted_change")])).toBe("would_wake");
    expect(aggregateRuleDecision([d("x", "would_wake", "not_fleet_locks")])).toBe("would_wake");
    expect(aggregateRuleDecision([skip, d("y", "would_log_only", "z")])).toBe("would_log_only");
  });
});

describe("pre-Clef dedupe (comment id / page when ids configured)", () => {
  let logs: string[] = [];
  let orig: typeof console.log;
  beforeEach(() => {
    logs = [];
    orig = console.log;
    console.log = ((l: unknown) => logs.push(String(l))) as typeof console.log;
    resetClefPageEventCountsForTests();
  });
  afterEach(() => {
    console.log = orig;
  });
  const clefRows = () =>
    logs.filter((l) => l.includes("clef_wake_shadow")).map((l) => JSON.parse(l) as Record<string, unknown>);
  const wake = [d("fleet_locks_adopted_change", "would_wake", "not_page_event")];
  const COMMENT_A = "cccccccccccccccccccccccccccccc01";
  const COMMENT_B = "cccccccccccccccccccccccccccccc02";
  const OTHER = "4e7d872b-594c-8161-92a2-00024b29e816";
  const comment = (commentId: string) =>
    ctx({
      notionType: "comment.created",
      isCommentEvent: true,
      authorId: OTHER,
      webhookAuthorIds: [OTHER],
      updatedPropertyIds: [],
      commentId,
    });
  const commentBody = { data: { text: "hello there" } };

  test("keys: comment id; page only when both id sets configured; window counts from first; 0 disables", () => {
    const e = env();
    expect(itemDedupeKey(comment(COMMENT_A), "comment.created")).toContain("comment:");
    expect(itemDedupeKey(comment(COMMENT_A), "comment.created")).not.toBe(
      itemDedupeKey(comment(COMMENT_B), "comment.created"),
    );
    expect(itemDedupeKey(ctx({ notionType: "comment.created", isCommentEvent: true }), "comment.created")).toBeNull();
    expect(itemDedupeKey(ctx(), "page.properties_updated")).toContain("page:");
    expect(itemDedupeKey(ctx({ needsJohnPropertyIds: new Set() }), "page.properties_updated")).toBeNull();
    expect(itemDedupeKey(ctx({ submittedPropertyIds: new Set() }), "page.properties_updated")).toBeNull();
    expect(noteItemEvent(e, "k", 0)).toBe(1);
    expect(noteItemEvent(e, "k", 1000)).toBe(2);
    expect(noteItemEvent(e, "k", 600_000)).toBe(1);
    expect(noteItemEvent(e, null, 0)).toBe(1);
    const off = env({ CLEF_ITEM_DEDUPE_WINDOW_S: "0" });
    expect(noteItemEvent(off, "z", 0)).toBe(1);
    expect(noteItemEvent(off, "z", 1)).toBe(1);
  });

  test("a DIFFERENT comment on the same page inside the window is not deduped", async () => {
    const e = env();
    await runClefShadowWakeGate(e, comment(COMMENT_A), "comment.created", commentBody, true, wake);
    await runClefShadowWakeGate(e, comment(COMMENT_B), "comment.created", commentBody, true, wake);
    const rows = clefRows();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => !String(r.reason).startsWith("comment_content"))).toBe(true);
    expect(rows.some((r) => r.reason === "dedupe_repeat_item")).toBe(false);
  });

  test("same comment delivered twice: repeat logged saved_wake and sent to the false-skip check", async () => {
    let calls = 0;
    const e = env({
      AI_GATEWAY_ID: "g",
      CLEF_RULE_SKIP_SAMPLE_PERCENT: "100",
      AI: {
        run: async () => {
          calls++;
          return {
            answers: {
              q_action: { type: "noul", noul: 0.9 },
              q_dup: { type: "noul", noul: 0.1 },
              q_when: { type: "choice", choice: "now" },
            },
          };
        },
      } as unknown as Ai,
    });
    await runClefShadowWakeGate(e, comment(COMMENT_A), "comment.created", commentBody, true, wake);
    await runClefShadowWakeGate(e, comment(COMMENT_A), "comment.created", commentBody, true, wake);
    const rows = clefRows();
    const dedupe = rows.find((r) => r.reason === "dedupe_repeat_item");
    expect(dedupe?.saved_wake).toBe(true);
    expect(dedupe?.item_event_count).toBe(2);
    const scored = rows.find((r) => r.decision === "rule_skip" && r.dedupe_repeat === true);
    expect(scored).toBeDefined();
    expect(String(scored?.reason)).toMatch(/^rule_skip:/);
    expect(calls).toBeLessThanOrEqual(2);
  });

  test("Needs John with env ids UNSET: hard override, never deduped", async () => {
    const nj = ctx({
      submittedPropertyIds: new Set(),
      needsJohnPropertyIds: new Set(),
      nonSubmittedPropertyIds: new Set(["Stat"]),
      updatedPropertyIds: ["Stat"],
      properties: { needsJohn: true, sensitive: false },
    });
    expect(needsJohnPropertyChanged(nj)).toBe(true);
    expect(clefHardOverrideReason(nj, {}, true, [])).toBe("needs_john_changed");
    await runClefShadowWakeGate(env(), nj, "page.properties_updated", {}, true, wake);
    await runClefShadowWakeGate(env(), nj, "page.properties_updated", {}, true, wake);
    expect(clefRows().map((r) => r.reason)).toEqual(["needs_john_changed", "needs_john_changed"]);
  });

  test("hard overrides (John comment) are never deduped", async () => {
    const john = ctx({
      notionType: "comment.created",
      isCommentEvent: true,
      authorId: JOHN,
      webhookAuthorIds: [JOHN],
      commentId: COMMENT_A,
    });
    await runClefShadowWakeGate(env(), john, "comment.created", {}, true, wake);
    await runClefShadowWakeGate(env(), john, "comment.created", {}, true, wake);
    expect(clefRows().map((r) => r.reason)).toEqual(["john_authored", "john_authored"]);
  });
});
