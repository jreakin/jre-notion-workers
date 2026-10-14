/**
 * Durable gate_log buffer core (storage-agnostic; the Durable Object wires SQLite into it).
 *
 * Rows survive isolate churn because they live in one SQLite-backed Durable Object
 * (`idFromName("gate_log")`). A DO alarm drains them into KV using the unchanged v1 schema
 * `gate_log:v1:<YYYY-MM-DD>:<HH>:<flushId>` → {"v":1,"flushed_at","rows":[…]} (TTL 7d), so
 * Notion Steward's reader does not change. The daily flush count lives in DO storage (exact,
 * single-writer), so it costs 0 KV writes; flushes are capped by GATE_LOG_DAILY_WRITE_CAP.
 */
import { kvTtl } from "./kv-ttl.js";
import type { GateLogRow } from "./gate-log-ring.js";

export const DO_FLUSH_MIN_INTERVAL_MS = 5 * 60_000;
/** Rows per KV value (≈600 B/row → ≤ ~300 KB, far under KV's 25 MiB value limit). */
export const DO_FLUSH_MAX_ROWS = 500;
/** Storage bound: oldest rows beyond this are pruned (counted in meta `pruned:<day>`). */
export const DO_MAX_STORED_ROWS = 20_000;
/** First retry delay after a failed KV put / alarm error; doubles per consecutive failure. */
export const DO_RETRY_MS = 60_000;
/** Retry backoff ceiling (≤ 48 attempts/day while KV writes stay blocked). */
export const DO_RETRY_MAX_MS = 30 * 60_000;

/** min(DO_RETRY_MS · 2^failures, DO_RETRY_MAX_MS) */
export function doRetryDelayMs(failures: number): number {
  const f = Math.max(0, Math.min(failures, 20));
  return Math.min(DO_RETRY_MS * 2 ** f, DO_RETRY_MAX_MS);
}
export const GATE_LOG_TTL_SECONDS = 60 * 60 * 24 * 7;

export interface GateLogStore {
  insert(rowsJson: string[], at: number): void;
  count(): number;
  take(limit: number): { id: number; json: string }[];
  deleteThrough(maxId: number, taken: number): void;
  pruneTo(max: number): number;
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}

export interface KvPut {
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface AlarmCtl {
  get(): Promise<number | null>;
  set(at: number): Promise<void>;
}

const RETRY_FAILS_KEY = "retry_fails";

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** max(5 min, time left in UTC day ÷ flushes left) — spreads the cap over the whole day. */
export function doPacedIntervalMs(used: number, cap: number, now: number): number {
  const d = new Date(now);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  if (used >= cap) return end - now + 1_000; // next UTC day
  return Math.max(DO_FLUSH_MIN_INTERVAL_MS, Math.floor((end - now) / Math.max(1, cap - used)));
}

export class GateLogBufferCore {
  constructor(
    private store: GateLogStore,
    private kv: KvPut,
    private alarm: AlarmCtl,
    private cap: number,
    private now: () => number = Date.now,
    private flushIdPrefix = "do",
  ) {}

  flushesToday(now = this.now()): number {
    const n = Number.parseInt(this.store.getMeta(`flushes:${utcDay(now)}`) ?? "0", 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /** RPC entry: persist rows, make sure an alarm is pending. */
  async append(rows: GateLogRow[]): Promise<{ stored: number }> {
    if (!Array.isArray(rows) || rows.length === 0) return { stored: 0 };
    const now = this.now();
    const json = rows.slice(0, DO_FLUSH_MAX_ROWS).map((r) => JSON.stringify(r));
    this.store.insert(json, now);
    const pruned = this.store.pruneTo(DO_MAX_STORED_ROWS);
    if (pruned > 0) {
      const k = `pruned:${utcDay(now)}`;
      this.store.setMeta(k, String(Number(this.store.getMeta(k) ?? "0") + pruned));
    }
    if ((await this.alarm.get()) === null) {
      await this.alarm.set(now + doPacedIntervalMs(this.flushesToday(now), this.cap, now));
    }
    return { stored: json.length };
  }

  private retryFailures(): number {
    const n = Number.parseInt(this.store.getMeta(RETRY_FAILS_KEY) ?? "0", 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  private async scheduleRetry(now: number): Promise<void> {
    const fails = this.retryFailures();
    this.store.setMeta(RETRY_FAILS_KEY, String(fails + 1));
    await this.alarm.set(now + doRetryDelayMs(fails));
  }

  /** Called when the alarm handler threw: re-arm (with backoff) if a backlog remains. */
  async rearmAfterError(): Promise<void> {
    if (this.store.count() > 0 && (await this.alarm.get()) === null) {
      await this.scheduleRetry(this.now());
    }
  }

  /** Alarm entry: flush ≤ one batch to KV (respecting the daily cap), then reschedule. */
  async onAlarm(): Promise<{ flushed: number; key?: string }> {
    const now = this.now();
    const used = this.flushesToday(now);
    if (this.store.count() === 0) return { flushed: 0 };
    if (this.cap <= 0) return { flushed: 0 }; // disabled: rows are pruned by the storage bound
    if (used >= this.cap) {
      await this.alarm.set(now + doPacedIntervalMs(used, this.cap, now));
      return { flushed: 0 };
    }
    const batch = this.store.take(DO_FLUSH_MAX_ROWS);
    const rows: unknown[] = [];
    for (const b of batch) {
      try {
        rows.push(JSON.parse(b.json));
      } catch {
        // skip corrupt row
      }
    }
    const iso = new Date(now).toISOString();
    const key = `gate_log:v1:${iso.slice(0, 10)}:${iso.slice(11, 13)}:${this.flushIdPrefix}-${now.toString(36)}`;
    try {
      await this.kv.put(key, JSON.stringify({ v: 1, flushed_at: iso, rows }), {
        expirationTtl: kvTtl(GATE_LOG_TTL_SECONDS),
      });
    } catch {
      await this.scheduleRetry(now); // keep rows; retry with backoff
      return { flushed: 0 };
    }
    this.store.deleteThrough(batch[batch.length - 1]!.id, batch.length);
    if (this.retryFailures() > 0) this.store.setMeta(RETRY_FAILS_KEY, "0");
    this.store.setMeta(`flushes:${utcDay(now)}`, String(used + 1));
    if (this.store.count() > 0) {
      await this.alarm.set(now + doPacedIntervalMs(used + 1, this.cap, now));
    }
    return { flushed: rows.length, key };
  }
}
