import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  aggregateRuleDecision,
  noteItemEvent,
  resetClefPageEventCountsForTests,
  runClefShadowWakeGate,
} from "../src/wake-gate/clef-wake-gate.js";
import { decideCommentsEchoGate } from "../src/wake-gate/comments-echo-gate.js";
import { clefHardOverrideReason } from "../src/wake-gate/clef-overrides.js";
import { submittedPropertyChanged } from "../src/wake-gate/gate-context-safety.js";
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

describe("pre-Clef same-item dedupe", () => {
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
  const clefRows = () => logs.filter((l) => l.includes("clef_wake_shadow")).map((l) => JSON.parse(l) as Record<string, unknown>);
  const wake = [d("fleet_locks_adopted_change", "would_wake", "not_page_event")];
  const c = () => ctx({ submittedPropertyIds: new Set(), needsJohnPropertyIds: new Set(), nonSubmittedPropertyIds: new Set(["Stat"]) });

  test("noteItemEvent counts within window from first event, resets after; unknown never deduped; 0 disables", () => {
    const e = env();
    expect(noteItemEvent(e, PAGE, "comment.created", 0)).toBe(1);
    expect(noteItemEvent(e, PAGE, "comment.created", 1000)).toBe(2);
    expect(noteItemEvent(e, PAGE, "page.properties_updated", 1000)).toBe(1);
    expect(noteItemEvent(e, PAGE, "comment.created", 600_000)).toBe(1);
    expect(noteItemEvent(e, "unknown", "comment.created", 0)).toBe(1);
    expect(noteItemEvent(e, "unknown", "comment.created", 1)).toBe(1);
    const off = env({ CLEF_ITEM_DEDUPE_WINDOW_S: "0" });
    expect(noteItemEvent(off, PAGE, "x", 0)).toBe(1);
    expect(noteItemEvent(off, PAGE, "x", 1)).toBe(1);
  });

  test("second wake-path event for the same item: no Clef call, logged dedupe_repeat_item + saved_wake", async () => {
    let calls = 0;
    const e = env({ AI_GATEWAY_ID: "g", AI: { run: async () => { calls++; return { answers: {} }; } } as unknown as Ai });
    await runClefShadowWakeGate(e, c(), "page.properties_updated", {}, true, wake);
    await runClefShadowWakeGate(e, c(), "page.properties_updated", {}, true, wake);
    await runClefShadowWakeGate(e, c(), "page.properties_updated", {}, true, wake);
    // First event takes the normal path (Clef, or a cap/mode reason if other suites left state); repeats never call Clef.
    expect(calls).toBeLessThanOrEqual(1);
    const rows = clefRows();
    expect(rows.length).toBe(3);
    expect(rows[0]?.reason).not.toBe("dedupe_repeat_item");
    expect(rows[0]?.saved_wake).toBeUndefined();
    expect(rows[1]?.reason).toBe("dedupe_repeat_item");
    expect(rows[1]?.saved_wake).toBe(true);
    expect(rows[2]?.item_event_count).toBe(3);
    expect(String(rows[1]?.item_id)).toMatch(/^opaque:/);
  });

  test("hard overrides (John comment) are never deduped", async () => {
    const john = ctx({ notionType: "comment.created", isCommentEvent: true, authorId: JOHN, webhookAuthorIds: [JOHN] });
    await runClefShadowWakeGate(env(), john, "comment.created", {}, true, wake);
    await runClefShadowWakeGate(env(), john, "comment.created", {}, true, wake);
    expect(clefRows().map((r) => r.reason)).toEqual(["john_authored", "john_authored"]);
  });
});
