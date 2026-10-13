import { beforeEach, describe, expect, test } from "bun:test";
import {
  GATE_LOG_COUNTER_NAME,
  GATE_LOG_FLUSH_ROWS,
  enqueueGateLogRow,
  flushGateLogRing,
  gateLogBufferSizeForTests,
  gateLogKey,
  isHighSignal,
  resetGateLogRingForTests,
} from "../src/gate-log-ring.js";
import { resetSoftDailyCountersForTests, softCounterKey } from "../src/soft-daily-counter.js";
import type { Env } from "../src/env.js";

let store: Map<string, string>;
let ttls: number[];

function env(o: Partial<Env> = {}): Env {
  return {
    RELAY_KV: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string, opt?: { expirationTtl?: number }) => {
        store.set(k, v);
        if (opt?.expirationTtl !== undefined) ttls.push(opt.expirationTtl);
      },
    } as unknown as KVNamespace,
    COS_WEBHOOK_URL: "u",
    COS_WEBHOOK_AUTHORIZATION: "a",
    SETUP_SECRET: "s",
    CLEF_RING: "1",
    WAKE_GATE_KV_RING: "1",
    ...o,
  };
}
const ringKeys = () => [...store.keys()].filter((k) => k.startsWith("gate_log:v1:"));
const row = (i: number) => ({ stream: "clef_wake_shadow" as const, i, rule_decision: "would_wake", clef_decision: "would_wake", reason: "clef_ok" });

describe("gate_log ring", () => {
  beforeEach(() => {
    store = new Map();
    ttls = [];
    resetGateLogRingForTests();
    resetSoftDailyCountersForTests();
  });

  test("batches rows: one KV write per GATE_LOG_FLUSH_ROWS rows", async () => {
    const e = env();
    for (let i = 0; i < GATE_LOG_FLUSH_ROWS * 4; i += 1) await enqueueGateLogRow(e, row(i));
    const keys = ringKeys();
    expect(keys).toHaveLength(4);
    const v = JSON.parse(store.get(keys[0]!)!) as { v: number; rows: unknown[] };
    expect(v.v).toBe(1);
    expect(v.rows).toHaveLength(GATE_LOG_FLUSH_ROWS);
    expect(ttls.every((t) => t >= 60)).toBe(true);
  });

  test("key schema gate_log:v1:<day>:<HH>:<flushId>", () => {
    expect(gateLogKey(new Date("2026-10-13T23:05:00Z"), "abc-1")).toBe("gate_log:v1:2026-10-13:23:abc-1");
  });

  test("flags off → nothing buffered", async () => {
    const e = env({ CLEF_RING: "0", WAKE_GATE_KV_RING: undefined });
    await enqueueGateLogRow(e, row(1));
    await enqueueGateLogRow(e, { stream: "wake_gate_shadow", decision: "would_wake" });
    expect(gateLogBufferSizeForTests()).toBe(0);
  });

  test("daily write cap bounds total writes (rows + counter) well under budget", async () => {
    const e = env({ GATE_LOG_DAILY_WRITE_CAP: "10" });
    let writes = 0;
    const kv = e.RELAY_KV as unknown as { put: (...a: unknown[]) => Promise<void> };
    const orig = kv.put;
    kv.put = async (...a: unknown[]) => {
      writes += 1;
      await orig(...(a as [string, string]));
    };
    for (let i = 0; i < 5000; i += 1) await enqueueGateLogRow(e, row(i));
    expect(ringKeys().length).toBeLessThanOrEqual(10);
    expect(writes).toBeLessThanOrEqual(12); // ≤10 flushes + ≤2 counter persists
    expect(Number(store.get(softCounterKey(GATE_LOG_COUNTER_NAME)))).toBe(ringKeys().length);
  });

  test("near cap: low-signal rows sampled, high-signal kept", async () => {
    store.set(softCounterKey(GATE_LOG_COUNTER_NAME), "8"); // 80% of 10
    const e = env({ GATE_LOG_DAILY_WRITE_CAP: "10" });
    for (let i = 0; i < 20; i += 1) await enqueueGateLogRow(e, row(i));
    expect(gateLogBufferSizeForTests()).toBe(5);
    await enqueueGateLogRow(e, { ...row(99), candidate_false_skip: true });
    expect(gateLogBufferSizeForTests()).toBe(6);
  });

  test("high-signal classifier", () => {
    expect(isHighSignal({ stream: "clef_wake_shadow", candidate_false_skip: true })).toBe(true);
    expect(isHighSignal({ stream: "clef_wake_shadow", reason: "error:TypeError" })).toBe(true);
    expect(isHighSignal({ stream: "clef_wake_shadow", rule_decision: "would_wake", clef_decision: "would_skip" })).toBe(true);
    expect(isHighSignal({ stream: "wake_gate_shadow", decision: "would_skip" })).toBe(true);
    expect(isHighSignal({ stream: "wake_gate_shadow", decision: "would_wake", reason: "default" })).toBe(false);
  });

  test("fail-open: KV throwing never throws", async () => {
    const e = env({
      RELAY_KV: { get: async () => { throw new Error("x"); }, put: async () => { throw new Error("x"); } } as unknown as KVNamespace,
    });
    for (let i = 0; i < 60; i += 1) await enqueueGateLogRow(e, row(i));
    expect(await flushGateLogRing(e, { force: true })).toBe(false);
  });

  test("force flush of a partial batch writes one key", async () => {
    const e = env();
    await enqueueGateLogRow(e, row(1));
    expect(ringKeys()).toHaveLength(0);
    expect(await flushGateLogRing(e, { force: true })).toBe(true);
    expect(ringKeys()).toHaveLength(1);
  });
});

describe("main Clef counter batching (#39 B1)", () => {
  beforeEach(() => {
    store = new Map();
    ttls = [];
    resetSoftDailyCountersForTests();
  });

  test("CLEF_DAILY_CALL_CAP=2000 worst case → ≤ 80 counter writes/day, cap still enforced", async () => {
    const { tryConsumeClefCall, clefDailyCapKey } = await import("../src/wake-gate/clef-daily-cap.js");
    let puts = 0;
    const e = env({ CLEF_DAILY_CALL_CAP: "2000" });
    const kv = e.RELAY_KV as unknown as { put: (...a: unknown[]) => Promise<void> };
    const orig = kv.put;
    kv.put = async (...a: unknown[]) => {
      puts += 1;
      await orig(...(a as [string, string]));
    };
    let ok = 0;
    for (let i = 0; i < 2500; i += 1) if ((await tryConsumeClefCall(e)).ok) ok += 1;
    expect(ok).toBe(2000);
    expect(puts).toBeLessThanOrEqual(80);
    expect(store.get(clefDailyCapKey())).toBe("2000");
  });
});
