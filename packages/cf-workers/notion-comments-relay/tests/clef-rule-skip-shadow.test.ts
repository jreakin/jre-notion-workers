import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runClefShadowWakeGate, resetClefPageEventCountsForTests } from "../src/wake-gate/clef-wake-gate.js";
import {
  RULE_SKIP_COUNTER_NAME,
  readRuleSkipDailyCap,
  ruleSkipSampled,
} from "../src/wake-gate/clef-rule-skip-shadow.js";
import { resetSoftDailyCountersForTests, softCounterKey } from "../src/soft-daily-counter.js";
import type { Env } from "../src/env.js";
import type { GateEventContext, WakeGateDecision } from "../src/wake-gate/gate-event-types.js";

const PAGE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function ctx(): GateEventContext {
  return {
    notionType: "comment.created",
    rawBody: "{}",
    pageId: PAGE,
    johnUserIds: new Set(),
    fleetCommentsBotIds: new Set(),
    submittedPropertyIds: new Set(),
    nonSubmittedPropertyIds: new Set(),
    updatedPropertyIds: [],
    isCommentEvent: true,
    propertiesAvailable: true,
    properties: { needsJohn: false, sensitive: false },
  };
}

const skip: WakeGateDecision[] = [
  { gate_name: "comments_echo", decision: "would_skip", reason: "bot_echo", inputs: {}, ts: "", mode: "shadow" },
];

function aiReturning(qAction: number, qWhen: string, qDup = 0): Ai {
  return {
    run: async () => ({
      answers: {
        q_action: { type: "noul", noul: qAction },
        q_dup: { type: "noul", noul: qDup },
        q_when: { type: "choice", choice: qWhen },
      },
    }),
  } as unknown as Ai;
}

describe("rule-skip Clef shadow", () => {
  let logs: Record<string, unknown>[] = [];
  let origLog: typeof console.log;
  let store: Map<string, string>;
  let puts: number;
  let aiCalls: number;

  beforeEach(() => {
    logs = [];
    store = new Map();
    puts = 0;
    aiCalls = 0;
    origLog = console.log;
    console.log = ((l: unknown) => {
      try {
        logs.push(JSON.parse(String(l)) as Record<string, unknown>);
      } catch {}
    }) as typeof console.log;
    resetClefPageEventCountsForTests();
    resetSoftDailyCountersForTests();
  });
  afterEach(() => {
    console.log = origLog;
  });

  function env(o: Partial<Env> = {}): Env {
    return {
      RELAY_KV: {
        get: async (k: string) => store.get(k) ?? null,
        put: async (k: string, v: string) => {
          puts += 1;
          store.set(k, v);
        },
      } as unknown as KVNamespace,
      COS_WEBHOOK_URL: "u",
      COS_WEBHOOK_AUTHORIZATION: "a",
      SETUP_SECRET: "s",
      CLEF_DEFAULT_MODE: "shadow",
      CLEF_RULE_SKIP_SAMPLE_PERCENT: "100",
      ...o,
    };
  }
  const ruleSkipRows = () => logs.filter((l) => l.decision === "rule_skip");

  async function run(e: Env, decisions = skip) {
    await runClefShadowWakeGate(e, ctx(), "comment.created", {}, true, decisions);
  }

  test("rule skip + Clef wake → candidate_false_skip=true, mirrored fields", async () => {
    await run(env({ AI: aiReturning(0.95, "now") }));
    const base = logs.find((l) => l.reason === "clef_skipped_rule_not_wake");
    expect(base).toBeDefined();
    const [row] = ruleSkipRows();
    expect(row).toBeDefined();
    expect(row!.stream).toBe("clef_wake_shadow");
    expect(row!.gate).toBe("clef_wake");
    expect(row!.rule_decision).toBe("would_skip");
    expect(row!.clef_decision).toBe("would_wake");
    expect(row!.candidate_false_skip).toBe(true);
    expect(row!.reason).toBe("rule_skip:clef_ok");
    expect(String(row!.item_id)).toStartWith("opaque:");
    for (const k of Object.keys(base!)) expect(Object.keys(row!)).toContain(k);
  });

  test("rule skip + Clef non-wake → candidate_false_skip=false", async () => {
    await run(env({ AI: aiReturning(0.01, "ignore", 0.99) }));
    const [row] = ruleSkipRows();
    expect(row!.clef_decision).toBe("would_skip");
    expect(row!.candidate_false_skip).toBe(false);
  });

  test("rule wake path does not run rule-skip shadow", async () => {
    await run(env({ AI: aiReturning(0.95, "now") }), [{ ...skip[0]!, decision: "would_wake" }]);
    expect(ruleSkipRows()).toHaveLength(0);
  });

  test("Clef error is fail-open (logged, no throw)", async () => {
    const e = env({ AI: { run: async () => { aiCalls += 1; throw new Error("boom"); } } as unknown as Ai });
    await run(e);
    expect(aiCalls).toBe(1);
    expect(String(ruleSkipRows()[0]!.reason)).toStartWith("rule_skip:");
  });

  test("KV throwing everywhere still does not throw", async () => {
    const e = env({
      AI: aiReturning(0.95, "now"),
      RELAY_KV: { get: async () => { throw new Error("kv"); }, put: async () => { throw new Error("kv"); } } as unknown as KVNamespace,
    });
    await run(e);
    expect(logs.some((l) => l.reason === "clef_skipped_rule_not_wake")).toBe(true);
  });

  test("mode off → no Clef call, no extra row", async () => {
    const e = env({ CLEF_DEFAULT_MODE: "off", AI: { run: async () => { aiCalls += 1; return {}; } } as unknown as Ai });
    await run(e);
    expect(aiCalls).toBe(0);
    expect(ruleSkipRows()).toHaveLength(0);
  });

  test("sample 0 → no Clef call", async () => {
    const e = env({ CLEF_RULE_SKIP_SAMPLE_PERCENT: "0", AI: { run: async () => { aiCalls += 1; return {}; } } as unknown as Ai });
    await run(e);
    expect(aiCalls).toBe(0);
  });

  test("daily cap stops Clef calls; counter writes are batched", async () => {
    const e = env({ CLEF_RULE_SKIP_DAILY_CAP: "25", AI: { run: async () => { aiCalls += 1; return {}; } } as unknown as Ai });
    for (let i = 0; i < 40; i += 1) await run(e);
    expect(aiCalls).toBe(25);
    expect(ruleSkipRows().filter((r) => r.reason === "rule_skip_daily_cap")).toHaveLength(15);
    expect(puts).toBeLessThanOrEqual(3); // 25 calls → persisted at 10, 20, 25
    expect(store.get(softCounterKey(RULE_SKIP_COUNTER_NAME))).toBe("25");
  });

  test("cap is honored from KV across isolates", async () => {
    store.set(softCounterKey(RULE_SKIP_COUNTER_NAME), "200");
    const e = env({ AI: { run: async () => { aiCalls += 1; return {}; } } as unknown as Ai });
    await run(e);
    expect(aiCalls).toBe(0);
  });

  test("defaults + sampling helper", () => {
    expect(readRuleSkipDailyCap(env())).toBe(200);
    expect(ruleSkipSampled(PAGE, 100)).toBe(true);
    expect(ruleSkipSampled(PAGE, 0)).toBe(false);
    let hits = 0;
    for (let i = 0; i < 1000; i += 1) if (ruleSkipSampled(`${i}`.padStart(32, "b"), 50)) hits += 1;
    expect(hits).toBeGreaterThan(350);
    expect(hits).toBeLessThan(650);
  });
});
