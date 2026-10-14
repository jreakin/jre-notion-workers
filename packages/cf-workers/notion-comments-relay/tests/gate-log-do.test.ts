import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  DO_FLUSH_MAX_ROWS,
  DO_FLUSH_MIN_INTERVAL_MS,
  DO_MAX_STORED_ROWS,
  DO_RETRY_MAX_MS,
  GateLogBufferCore,
  doRetryDelayMs,
  doPacedIntervalMs,
} from "../src/gate-log-core.js";
import { GateLogBuffer, SqlGateLogStore } from "../src/gate-log-do.js";
import {
  enqueueGateLogRow,
  flushGateLogRing,
  gateLogDoPendingForTests,
  resetGateLogRingForTests,
} from "../src/gate-log-ring.js";
import { runShadowWakeGates } from "../src/wake-gate/wake-gate-shadow.js";
import type { Env } from "../src/env.js";

/** bun:sqlite shim with the subset of Cloudflare SqlStorage we use. */
function sqlShim(): SqlStorage {
  const db = new Database(":memory:");
  return {
    exec(q: string, ...b: unknown[]) {
      const st = db.query(q);
      const rows = /^\s*select/i.test(q) ? (st.all(...(b as never[])) as Record<string, unknown>[]) : (st.run(...(b as never[])), []);
      return { toArray: () => rows, one: () => rows[0]! };
    },
  } as unknown as SqlStorage;
}

let kvStore: Map<string, string>;
let kvPuts: number;
let alarmAt: number | null;
let clock: number;
const T0 = Date.UTC(2026, 9, 14, 1, 0, 0); // 8 PM CDT

function kv(fail = false) {
  return {
    get: async (k: string) => kvStore.get(k) ?? null,
    put: async (k: string, v: string) => {
      if (fail) throw new Error("kv down");
      kvPuts += 1;
      kvStore.set(k, v);
    },
  };
}
const alarm = { get: async () => alarmAt, set: async (at: number) => void (alarmAt = at) };
const row = (i: number) => ({ stream: "clef_wake_shadow" as const, i });
const keys = () => [...kvStore.keys()].filter((k) => k.startsWith("gate_log:v1:"));

beforeEach(() => {
  kvStore = new Map();
  kvPuts = 0;
  alarmAt = null;
  clock = T0;
  resetGateLogRingForTests();
});

describe("GateLogBufferCore (SQLite store)", () => {
  function core(cap = 60, failKv = false) {
    return new GateLogBufferCore(new SqlGateLogStore(sqlShim()), kv(failKv), alarm, cap, () => clock);
  }

  test("rows survive 'isolate churn': appended across calls, flushed once by the alarm with v1 schema", async () => {
    const c = core();
    await c.append([row(1), row(2)]);
    await c.append([row(3)]); // a different Worker isolate calling the same DO
    expect(alarmAt).not.toBeNull();
    expect(alarmAt! - T0).toBeGreaterThanOrEqual(DO_FLUSH_MIN_INTERVAL_MS);
    clock = alarmAt!;
    const r = await c.onAlarm();
    expect(r.flushed).toBe(3);
    expect(keys()).toHaveLength(1);
    expect(keys()[0]).toMatch(/^gate_log:v1:2026-10-14:\d\d:do-[a-z0-9]+$/);
    const v = JSON.parse(kvStore.get(keys()[0]!)!) as { v: number; flushed_at: string; rows: { i: number }[] };
    expect(v.v).toBe(1);
    expect(v.rows.map((x) => x.i)).toEqual([1, 2, 3]);
  });

  test("daily cap bounds KV writes exactly (counter lives in DO storage: 0 KV counter writes)", async () => {
    const c = core(3);
    for (let i = 0; i < 10; i += 1) {
      await c.append([row(i)]);
      await c.onAlarm();
    }
    expect(kvPuts).toBe(3);
    expect([...kvStore.keys()].every((k) => k.startsWith("gate_log:v1:"))).toBe(true);
    // over cap: rows retained, alarm parked until next UTC day
    expect(alarmAt! - clock).toBeGreaterThan(0);
    expect(new Date(alarmAt!).toISOString().slice(0, 10)).toBe("2026-10-15");
  });

  test("next UTC day resumes and drains the retained rows", async () => {
    const c = core(1);
    await c.append([row(1)]);
    await c.onAlarm();
    await c.append([row(2)]);
    expect((await c.onAlarm()).flushed).toBe(0);
    clock = Date.UTC(2026, 9, 15, 0, 0, 5);
    expect((await c.onAlarm()).flushed).toBe(1);
  });

  test("KV failure keeps rows and retries; never throws", async () => {
    const c = core(60, true);
    await c.append([row(1)]);
    expect((await c.onAlarm()).flushed).toBe(0);
    expect(alarmAt).toBe(clock + 60_000);
  });

  test("KV retries back off exponentially (capped at 30 min) and reset after a success", async () => {
    let fail = true;
    const flaky = { put: async (k: string, v: string) => { if (fail) throw new Error("kv down"); kvStore.set(k, v); } };
    const store = new SqlGateLogStore(sqlShim());
    const c = new GateLogBufferCore(store, flaky, alarm, 60, () => clock);
    await c.append([row(1)]);
    const delays: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      await c.onAlarm();
      delays.push(alarmAt! - clock);
      clock = alarmAt!;
    }
    expect(delays.slice(0, 5)).toEqual([60_000, 120_000, 240_000, 480_000, 960_000]);
    expect(delays.slice(5)).toEqual([DO_RETRY_MAX_MS, DO_RETRY_MAX_MS, DO_RETRY_MAX_MS]);
    fail = false;
    expect((await c.onAlarm()).flushed).toBe(1);
    expect(store.getMeta("retry_fails")).toBe("0");
    expect(doRetryDelayMs(1000)).toBe(DO_RETRY_MAX_MS);
  });

  test("row count is kept in meta, not recounted per append", async () => {
    const queries: string[] = [];
    const base = sqlShim();
    const spy = { exec: (q: string, ...b: unknown[]) => (queries.push(q), base.exec(q, ...b)) } as unknown as SqlStorage;
    const store = new SqlGateLogStore(spy);
    const c = new GateLogBufferCore(store, kv(), alarm, 60, () => clock);
    await c.append([row(1)]); // seeds the cached count once
    queries.length = 0;
    for (let i = 0; i < 5; i += 1) await c.append([row(i), row(i + 1)]);
    expect(queries.some((q) => /COUNT\(\*\)/i.test(q))).toBe(false);
    expect(store.count()).toBe(11);
    clock = alarmAt!;
    await c.onAlarm();
    expect(store.count()).toBe(0);
  });

  test("batches are bounded and backlog keeps the alarm armed", async () => {
    const c = core();
    for (let i = 0; i < 3; i += 1) await c.append(Array.from({ length: DO_FLUSH_MAX_ROWS }, (_, j) => row(i * 1000 + j)));
    alarmAt = null;
    const r = await c.onAlarm();
    expect(r.flushed).toBe(DO_FLUSH_MAX_ROWS);
    expect(alarmAt).not.toBeNull();
  });

  test("storage bound prunes oldest rows", async () => {
    const store = new SqlGateLogStore(sqlShim());
    const c = new GateLogBufferCore(store, kv(), alarm, 60, () => clock);
    for (let i = 0; i < 41; i += 1) await c.append(Array.from({ length: DO_FLUSH_MAX_ROWS }, (_, j) => row(j)));
    expect(store.count()).toBe(DO_MAX_STORED_ROWS);
    expect(Number(store.getMeta("pruned:2026-10-14"))).toBe(41 * DO_FLUSH_MAX_ROWS - DO_MAX_STORED_ROWS);
  });

  test("pacing: ≥ 5 min, spreads the remaining cap over the UTC day", () => {
    const noon = Date.UTC(2026, 9, 14, 12);
    expect(doPacedIntervalMs(0, 60, noon)).toBe(12 * 60_000);
    expect(doPacedIntervalMs(0, 10_000, noon)).toBe(DO_FLUSH_MIN_INTERVAL_MS);
  });
});

describe("GateLogBuffer Durable Object class", () => {
  test("RPC append + alarm through the real class wiring", async () => {
    const env = { RELAY_KV: kv() as unknown as KVNamespace, GATE_LOG_DAILY_WRITE_CAP: "60" } as Env;
    const ctx = {
      storage: {
        sql: sqlShim(),
        getAlarm: async () => alarmAt,
        setAlarm: async (at: number) => void (alarmAt = at),
      },
    } as unknown as DurableObjectState;
    const d = new GateLogBuffer(ctx, env);
    expect((await d.append([row(1)])).stored).toBe(1);
    await d.alarm();
    expect(keys()).toHaveLength(1);
  });

  test("alarm handler error re-arms instead of stranding the backlog", async () => {
    const env = { RELAY_KV: kv() as unknown as KVNamespace, GATE_LOG_DAILY_WRITE_CAP: "60" } as Env;
    const base = sqlShim();
    let breakTake = false;
    const sql = {
      exec: (q: string, ...b: unknown[]) => {
        if (breakTake && /^SELECT id, json/.test(q)) throw new Error("sql boom");
        return base.exec(q, ...b);
      },
    } as unknown as SqlStorage;
    const ctx = {
      storage: { sql, getAlarm: async () => alarmAt, setAlarm: async (at: number) => void (alarmAt = at) },
    } as unknown as DurableObjectState;
    const d = new GateLogBuffer(ctx, env);
    await d.append([row(1)]);
    alarmAt = null; // the runtime clears the pending alarm when it fires
    breakTake = true;
    await d.alarm();
    expect(alarmAt).not.toBeNull();
    expect(keys()).toHaveLength(0);
  });
});

describe("Worker side (fail-open RPC)", () => {
  function nsWith(append: (rows: unknown[]) => Promise<unknown>) {
    const calls: unknown[][] = [];
    const ns = {
      idFromName: () => "id",
      get: () => ({
        append: async (rows: unknown[]) => {
          calls.push(rows);
          return append(rows);
        },
      }),
    };
    return { ns: ns as unknown as DurableObjectNamespace<GateLogBuffer>, calls };
  }
  function env(o: Partial<Env> = {}): Env {
    return {
      RELAY_KV: { get: async () => null, put: async () => void (kvPuts += 1) } as unknown as KVNamespace,
      COS_WEBHOOK_URL: "u",
      COS_WEBHOOK_AUTHORIZATION: "a",
      SETUP_SECRET: "s",
      CLEF_RING: "1",
      WAKE_GATE_KV_RING: "1",
      CLEF_DEFAULT_MODE: "off",
      ...o,
    };
  }

  test("one RPC per request carrying all of that request's rows; zero KV ops on the Worker", async () => {
    const { ns, calls } = nsWith(async () => ({ stored: 1 }));
    const e = env({ GATE_LOG_DO: ns });
    await runShadowWakeGates(e, { type: "page.created", entity: { id: "p", type: "page" } }, "page.created", "{}", true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.length).toBeGreaterThan(0);
    expect(kvPuts).toBe(0);
    expect(gateLogDoPendingForTests()).toBe(0);
  });

  test("DO error is fail-open: no throw, rows dropped, error logged", async () => {
    const { ns } = nsWith(async () => {
      throw new Error("do down");
    });
    const e = env({ GATE_LOG_DO: ns });
    const lines: string[] = [];
    const orig = console.log;
    console.log = ((l: unknown) => lines.push(String(l))) as typeof console.log;
    try {
      await enqueueGateLogRow(e, row(1));
      expect(await flushGateLogRing(e)).toBe(false);
    } finally {
      console.log = orig;
    }
    expect(lines.some((l) => l.includes("gate_log_do_error"))).toBe(true);
    expect(gateLogDoPendingForTests()).toBe(0);
  });

  test("DO hang is bounded by the RPC timeout", async () => {
    const { ns } = nsWith(() => new Promise(() => {}));
    const e = env({ GATE_LOG_DO: ns });
    await enqueueGateLogRow(e, row(1));
    const t = Date.now();
    const orig = console.log;
    console.log = () => {};
    try {
      expect(await flushGateLogRing(e)).toBe(false);
    } finally {
      console.log = orig;
    }
    expect(Date.now() - t).toBeLessThan(3_000);
  });

  test("no binding → legacy in-isolate ring path unchanged", async () => {
    const e = env();
    await enqueueGateLogRow(e, row(1));
    expect(gateLogDoPendingForTests()).toBe(0);
  });
});
