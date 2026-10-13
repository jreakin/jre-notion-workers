import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import worker from "../src/index.js";
import {
  GATE_LOG_FLUSH_MAX_AGE_MS,
  ageGateLogBufferForTests,
  enqueueGateLogRow,
  flushGateLogRing,
  gateLogBufferSizeForTests,
  pacedMinAgeMs,
  resetGateLogRingForTests,
} from "../src/gate-log-ring.js";
import { runShadowWakeGates } from "../src/wake-gate/wake-gate-shadow.js";
import {
  resetSoftDailyCountersForTests,
  softCounterKey,
  trySoftDailyConsume,
} from "../src/soft-daily-counter.js";
import { meterKv, resetKvWriteMeterForTests } from "../src/kv-write-meter.js";
import { runClefShadowWakeGate } from "../src/wake-gate/clef-wake-gate.js";
import { EXCLUDED_LOG_CAP_PER_DAY, resetExcludedLogCapForTests } from "../src/wake-gate/clef-rule-skip-shadow.js";
import type { Env } from "../src/env.js";
import type { GateEventContext } from "../src/wake-gate/gate-event-types.js";

let store: Map<string, string>;
let puts: string[];
let origLog: typeof console.log;
let origErr: typeof console.error;
let lines: string[];

function kv(): KVNamespace {
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      puts.push(k);
      store.set(k, v);
    },
    delete: async (k: string) => {
      store.delete(k);
    },
  } as unknown as KVNamespace;
}
function env(o: Partial<Env> = {}): Env {
  return { RELAY_KV: kv(), COS_WEBHOOK_URL: "u", COS_WEBHOOK_AUTHORIZATION: "a", SETUP_SECRET: "s", CLEF_RING: "1", WAKE_GATE_KV_RING: "1", ...o };
}
const ringKeys = () => [...store.keys()].filter((k) => k.startsWith("gate_log:v1:"));
const row = { stream: "clef_wake_shadow" as const, rule_decision: "would_wake", clef_decision: "would_wake" };

beforeEach(() => {
  store = new Map();
  puts = [];
  lines = [];
  resetGateLogRingForTests();
  resetSoftDailyCountersForTests();
  resetKvWriteMeterForTests();
  resetExcludedLogCapForTests();
  origLog = console.log;
  origErr = console.error;
  console.log = ((l: unknown) => lines.push(String(l))) as typeof console.log;
  console.error = ((l: unknown) => lines.push(String(l))) as typeof console.error;
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});

describe("low-traffic flush", () => {
  test("partial batch < 5 min is held; > 5 min flushes at end of request", async () => {
    const e = env({ CLEF_DEFAULT_MODE: "off" });
    await enqueueGateLogRow(e, row);
    await runShadowWakeGates(e, {}, "page.created", "{}", true);
    expect(ringKeys()).toHaveLength(0);
    ageGateLogBufferForTests(GATE_LOG_FLUSH_MAX_AGE_MS + 1000);
    await runShadowWakeGates(e, {}, "page.created", "{}", true);
    expect(ringKeys()).toHaveLength(1);
    // the aged batch went out; only this request's fresh rows remain buffered
    expect(JSON.parse(store.get(ringKeys()[0]!)!).rows[0].rule_decision).toBe("would_wake");
    expect(gateLogBufferSizeForTests()).toBeLessThanOrEqual(4);
  });

  test("B1: young rows + cron tick → 0 writes (cron respects paced age)", async () => {
    const e = env();
    await enqueueGateLogRow(e, row);
    await worker.scheduled!({} as ScheduledController, e, { waitUntil() {} } as unknown as ExecutionContext);
    expect(ringKeys()).toHaveLength(0);
    expect(puts).toHaveLength(0);
    expect(gateLogBufferSizeForTests()).toBe(1);
  });

  test("B1: stale rows + cron tick → flush", async () => {
    const e = env();
    await enqueueGateLogRow(e, row);
    ageGateLogBufferForTests(24 * 3600_000); // older than any paced min age
    await worker.scheduled!({} as ScheduledController, e, { waitUntil() {} } as unknown as ExecutionContext);
    expect(ringKeys()).toHaveLength(1);
    expect(gateLogBufferSizeForTests()).toBe(0);
  });

  test("cron with empty ring + empty coalesce buffer still writes nothing", async () => {
    const e = env();
    for (let i = 0; i < 30; i += 1) {
      await worker.scheduled!({} as ScheduledController, e, { waitUntil() {} } as unknown as ExecutionContext);
    }
    expect(puts).toHaveLength(0);
  });

  test("GATE_LOG_DAILY_WRITE_CAP still bounds forced flushes", async () => {
    const e = env({ GATE_LOG_DAILY_WRITE_CAP: "5" });
    for (let i = 0; i < 50; i += 1) {
      await enqueueGateLogRow(e, row);
      await flushGateLogRing(e, { force: true });
    }
    expect(ringKeys().length).toBe(5);
  });

  test("pacing: min age is ≥ 5 min and spreads the remaining budget over the UTC day", () => {
    const noon = new Date("2026-10-13T12:00:00Z");
    expect(pacedMinAgeMs(0, 60, noon)).toBe(Math.floor((12 * 3600_000) / 60)); // 12 min
    expect(pacedMinAgeMs(0, 1000, noon)).toBe(GATE_LOG_FLUSH_MAX_AGE_MS);
    expect(pacedMinAgeMs(59, 60, noon)).toBe(12 * 3600_000);
  });
});

describe("soft counter additive merge", () => {
  test("two isolates' increments add up (no max-merge undercount)", async () => {
    const k = kv();
    for (let i = 0; i < 10; i += 1) await trySoftDailyConsume(k, "t", 1000, 10);
    resetSoftDailyCountersForTests(); // simulate a second isolate
    for (let i = 0; i < 10; i += 1) await trySoftDailyConsume(k, "t", 1000, 10);
    expect(store.get(softCounterKey("t"))).toBe("20");
  });
});

describe("KV write meter alert", () => {
  test("alert-level line once when metered writes pass threshold", async () => {
    const m = meterKv(kv(), env({ KV_WRITE_ALERT_THRESHOLD: "30" }));
    for (let i = 0; i < 80; i += 1) await m.put(`k${i}`, "v");
    const alerts = lines.filter((l) => l.includes("kv_write_budget_alert"));
    expect(alerts).toHaveLength(1);
    const a = JSON.parse(alerts[0]!) as Record<string, unknown>;
    expect(a.level).toBe("alert");
    expect(Number(a.kv_writes_today)).toBeGreaterThanOrEqual(30);
    // meter overhead: persisted every 25 ops
    expect(puts.filter((p) => p.startsWith("kv:writes:")).length).toBeLessThanOrEqual(4);
  });

  test("meter is fail-open when the counter KV read throws", async () => {
    const raw = {
      get: async () => {
        throw new Error("x");
      },
      put: async () => {},
      delete: async () => {},
    } as unknown as KVNamespace;
    const m = meterKv(raw, env());
    await m.put("a", "b");
    await m.delete("a");
  });
});

describe("excluded_grokbot log cap", () => {
  test(`at most ${EXCLUDED_LOG_CAP_PER_DAY} excluded rows/day per isolate`, async () => {
    const ctx: GateEventContext = {
      notionType: "comment.created",
      rawBody: "{}",
      pageId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      johnUserIds: new Set(),
      fleetCommentsBotIds: new Set(),
      submittedPropertyIds: new Set(),
      nonSubmittedPropertyIds: new Set(),
      updatedPropertyIds: [],
      isCommentEvent: true,
      propertiesAvailable: true,
      properties: {},
    };
    const e = env({ CLEF_DEFAULT_MODE: "shadow", CLEF_RULE_SKIP_SAMPLE_PERCENT: "100", CLEF_RING: "0" });
    for (let i = 0; i < 50; i += 1) {
      await runClefShadowWakeGate(e, ctx, "comment.created", { authors: [{ person: { email: "jre@mail.grokbot.com" } }] }, true, [
        { gate_name: "x", decision: "would_skip", reason: "r", inputs: {}, ts: "", mode: "shadow" },
      ]);
    }
    expect(lines.filter((l) => l.includes("rule_skip:excluded_grokbot"))).toHaveLength(EXCLUDED_LOG_CAP_PER_DAY);
  });
});
