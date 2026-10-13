import { kvTtl } from "./kv-ttl.js";

/**
 * Write-frugal soft daily counter.
 *
 * Counts in isolate memory and persists to KV only every `persistEvery` increments
 * (merging with the stored value via max), so a cap of N costs ~N/persistEvery KV writes/day
 * instead of N. Soft: concurrent isolates can overrun by up to (persistEvery - 1) each.
 * Every KV error is swallowed (fail-open on counting; callers decide what "ok" means).
 */
type CounterState = { day: string; count: number; unpersisted: number; loaded: boolean };

const states = new Map<string, CounterState>();

export const SOFT_COUNTER_TTL_SECONDS = 60 * 60 * 48;

export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function softCounterKey(name: string, now: Date = new Date()): string {
  return `${name}:${utcDay(now)}`;
}

function parseCount(raw: string | null): number {
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export type SoftConsumeResult =
  | { ok: true; count: number }
  | { ok: false; reason: "daily_cap"; count: number }
  | { ok: false; reason: "invalid"; count: number };

export interface SoftKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

function stateFor(name: string, day: string): CounterState {
  let s = states.get(name);
  if (!s || s.day !== day) {
    s = { day, count: 0, unpersisted: 0, loaded: false };
    states.set(name, s);
  }
  return s;
}

/** Current (isolate-local, KV-merged on first use) count without consuming. */
export async function peekSoftDailyCount(kv: SoftKv, name: string, now = new Date()): Promise<number> {
  const s = stateFor(name, utcDay(now));
  if (!s.loaded) {
    try {
      s.count = Math.max(s.count, parseCount(await kv.get(softCounterKey(name, now))));
    } catch {
      // fail open: treat as 0 + local
    }
    s.loaded = true;
  }
  return s.count;
}

export async function trySoftDailyConsume(
  kv: SoftKv,
  name: string,
  cap: number,
  persistEvery: number,
  now: Date = new Date(),
  opts: { rejectInvalid?: boolean } = {},
): Promise<SoftConsumeResult> {
  if (opts.rejectInvalid) {
    try {
      const raw = await kv.get(softCounterKey(name, now));
      if (raw !== null && raw.trim() !== "" && !/^\d+$/.test(raw.trim())) {
        return { ok: false, reason: "invalid", count: 0 };
      }
    } catch {
      // fail open
    }
  }
  const current = await peekSoftDailyCount(kv, name, now);
  if (current >= cap) {
    return { ok: false, reason: "daily_cap", count: current };
  }
  const s = stateFor(name, utcDay(now));
  s.count += 1;
  s.unpersisted += 1;
  if (s.unpersisted >= Math.max(1, persistEvery) || s.count >= cap) {
    const delta = s.unpersisted;
    s.unpersisted = 0;
    try {
      // Additive merge: other isolates' increments since our last read are kept (max-merge
      // would undercount by up to (isolates-1)×). Still soft: concurrent persists can race.
      const key = softCounterKey(name, now);
      const stored = parseCount(await kv.get(key));
      s.count = stored + delta;
      await kv.put(key, String(s.count), { expirationTtl: kvTtl(SOFT_COUNTER_TTL_SECONDS) });
    } catch {
      // fail open (local count stays as-is)
    }
  }
  return { ok: true, count: s.count };
}

export function resetSoftDailyCountersForTests(): void {
  states.clear();
}
