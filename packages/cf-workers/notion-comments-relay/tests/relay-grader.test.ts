import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { itemDedupeKey, resetClefPageEventCountsForTests, runClefShadowWakeGate } from "../src/wake-gate/clef-wake-gate.js";
import { gradeRelayWindow, RELAY_ERROR_RATE_MAX } from "../src/wake-gate/grade-relay.js";
import { resetSoftDailyCountersForTests } from "../src/soft-daily-counter.js";
import type { Env } from "../src/env.js";
import type { GateEventContext, WakeGateDecision } from "../src/wake-gate/gate-event-types.js";

const JOHN = "2e7d872b-594c-8161-92a2-00024b29e816";
const BOT = "3d87d7f5-6298-8165-8af9-0027a153ccbd";
const OTHER = "4e7d872b-594c-8161-92a2-00024b29e816";
const PAGE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const COMMENT = "cccccccccccccccccccccccccccccc01";

function ctx(type = "comment.created", over: Partial<GateEventContext> = {}): GateEventContext {
  return {
    notionType: type, rawBody: "{}", pageId: PAGE, johnUserIds: new Set([JOHN]), fleetCommentsBotIds: new Set([BOT]),
    submittedPropertyIds: new Set(), needsJohnPropertyIds: new Set(), nonSubmittedPropertyIds: new Set(),
    updatedPropertyIds: [], isCommentEvent: type.startsWith("comment."), authorId: OTHER, webhookAuthorIds: [OTHER],
    commentId: COMMENT, propertiesAvailable: true, properties: { needsJohn: false, sensitive: false }, ...over,
  };
}
const wake: WakeGateDecision[] = [
  { gate_name: "fleet_locks_adopted_change", decision: "would_wake", reason: "not_page_event", inputs: {}, ts: "", mode: "shadow" },
];
const body = { data: { text: "please review" } };

function env(over: Partial<Env> = {}, aiAnswer: "wake" | "skip" = "wake"): Env {
  const store = new Map<string, string>();
  return {
    RELAY_KV: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => { store.set(k, v); },
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
      getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
    } as unknown as KVNamespace,
    COS_WEBHOOK_URL: "u", COS_WEBHOOK_AUTHORIZATION: "a", SETUP_SECRET: "s", CLEF_DEFAULT_MODE: "shadow",
    AI_GATEWAY_ID: "g",
    AI: {
      run: async () => ({
        answers: {
          q_action: { type: "noul", noul: aiAnswer === "wake" ? 0.9 : 0.01 },
          q_dup: { type: "noul", noul: aiAnswer === "wake" ? 0.1 : 0.95 },
          q_when: { type: "choice", choice: aiAnswer === "wake" ? "now" : "ignore" },
        },
      }),
    } as unknown as Ai,
    ...over,
  };
}

let logs: string[] = [];
let orig: typeof console.log;
beforeEach(() => {
  logs = [];
  orig = console.log;
  console.log = ((l: unknown) => logs.push(String(l))) as typeof console.log;
  resetClefPageEventCountsForTests();
  resetSoftDailyCountersForTests();
});
afterEach(() => { console.log = orig; });
const rows = () => logs.filter((l) => l.includes("clef_wake_shadow")).map((l) => JSON.parse(l) as Record<string, unknown>);

describe("dedupe repeats are scored 100%", () => {
  test("repeat is scored even with the rule-skip sampler at 0%", async () => {
    const e = env({ CLEF_RULE_SKIP_SAMPLE_PERCENT: "0" }, "skip");
    for (let i = 0; i < 3; i++) await runClefShadowWakeGate(e, ctx(), "comment.created", body, true, wake);
    const checks = rows().filter((r) => r.decision === "rule_skip" && r.dedupe_repeat === true);
    expect(checks.length).toBe(2);
    expect(checks.every((r) => r.scored === true)).toBe(true);
    const g = gradeRelayWindow(rows());
    expect([g.dedupe_repeats, g.dedupe_repeats_scored, g.dedupe_repeats_unscored]).toEqual([2, 2, 0]);
    expect(g.pass).toBe(true);
  });
  test("cap reached → repeat logged scored:false and the window fails unscored_dedupe_repeat", async () => {
    const e = env({ CLEF_RULE_SKIP_DAILY_CAP: "0" }, "skip");
    await runClefShadowWakeGate(e, ctx(), "comment.created", body, true, wake);
    await runClefShadowWakeGate(e, ctx(), "comment.created", body, true, wake);
    const check = rows().find((r) => r.decision === "rule_skip");
    expect(check?.scored).toBe(false);
    const g = gradeRelayWindow(rows());
    expect(g.dedupe_repeats_unscored).toBe(1);
    expect(g.fail_reasons).toContain("unscored_dedupe_repeat");
  });
  test("scored repeat where Clef says wake → false skip fails the window", async () => {
    const e = env({}, "wake");
    await runClefShadowWakeGate(e, ctx(), "comment.created", body, true, wake);
    await runClefShadowWakeGate(e, ctx(), "comment.created", body, true, wake);
    const g = gradeRelayWindow(rows());
    expect(g.false_skips).toBe(1);
    expect(g.fail_reasons).toContain("false_skip");
    expect(Object.values(g.saved_wakes_by_item)).toEqual([1]);
  });
});

describe("comment.updated is never deduped", () => {
  test("key is null and a second edit inside the window takes the normal path", async () => {
    expect(itemDedupeKey(ctx("comment.updated"), "comment.updated")).toBeNull();
    expect(itemDedupeKey(ctx("comment.created"), "comment.created")).not.toBeNull();
    const e = env();
    await runClefShadowWakeGate(e, ctx("comment.updated"), "comment.updated", body, true, wake);
    await runClefShadowWakeGate(e, ctx("comment.updated"), "comment.updated", body, true, wake);
    expect(rows().some((r) => r.reason === "dedupe_repeat_item")).toBe(false);
  });
});

describe("gradeRelayWindow", () => {
  const ok = (ts = "2026-10-14T10:00:00Z") => ({ stream: "clef_wake_shadow", ts, reason: "clef_ok", rule_decision: "would_wake" });
  const err = (reason: string, ts = "2026-10-14T10:00:00Z") => ({ stream: "clef_wake_shadow", ts, reason, rule_decision: "would_wake" });
  test("error rate per day; > 2% fails; mode suffix still counts as a call", () => {
    const g1 = gradeRelayWindow([...Array.from({ length: 99 }, () => ok()), err("clef_error:AiGatewayError")]);
    expect(RELAY_ERROR_RATE_MAX).toBe(0.02);
    expect(g1.days[0]).toEqual({ day: "2026-10-14", clef_calls: 100, clef_errors: 1, error_rate: 0.01, over_threshold: false });
    expect(g1.pass).toBe(true);
    const g2 = gradeRelayWindow([...Array.from({ length: 30 }, () => ({ ...ok(), reason: "clef_ok;clef_mode_x" })), err("clef_timeout")]);
    expect(g2.fail_reasons).toEqual(["error_rate_over_threshold"]);
  });
  test("any clef_ai_unbound fails", () => {
    expect(gradeRelayWindow([...Array.from({ length: 500 }, () => ok()), err("clef_ai_unbound")]).fail_reasons).toContain("config_error");
  });
  test("rule skips: scored vs unscored counted; unsampled rule skips don't fail; scored false skip does", () => {
    const base = { stream: "clef_wake_shadow", ts: "2026-10-14T10:00:00Z", rule_decision: "would_skip", reason: "clef_skipped_rule_not_wake" };
    const check = (fs: boolean) => ({ ...base, decision: "rule_skip", reason: "rule_skip:clef_ok", scored: true, candidate_false_skip: fs });
    const g = gradeRelayWindow([base, base, base, check(false)]);
    expect([g.rule_skips, g.rule_skips_scored, g.rule_skips_unscored, g.pass]).toEqual([3, 1, 2, true]);
    expect(gradeRelayWindow([base, check(true)]).fail_reasons).toEqual(["false_skip"]);
  });
  test("excluded repeats are neither scored nor unscored; other streams ignored", () => {
    const g = gradeRelayWindow([
      { stream: "clef_wake_shadow", reason: "dedupe_repeat_item", saved_wake: true, item_id: "opaque:1" },
      { stream: "clef_wake_shadow", decision: "rule_skip", dedupe_repeat: true, excluded: true, scored: false },
      { stream: "clef_email_shadow", reason: "clef_ai_unbound" },
    ]);
    expect([g.dedupe_repeats_unscored, g.ai_unbound, g.pass]).toEqual([0, 0, true]);
  });
});
