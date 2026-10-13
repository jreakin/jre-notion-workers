/**
 * Daily RELAY_KV write meter + budget alert.
 *
 * Wraps RELAY_KV so every put/delete increments a soft daily counter (`kv:writes:<YYYY-MM-DD>`,
 * persisted every 25 ops → ≤ ~40 extra writes/day at 1k). When the merged count crosses
 * KV_WRITE_ALERT_THRESHOLD (default 800) an alert-level console line is emitted once per isolate
 * per UTC day. Soft (per-isolate, merged on persist) → treat as an early warning, not an exact meter.
 * Fail-open: metering errors never affect the wrapped operation.
 */
import type { Env } from "./env.js";
import { trySoftDailyConsume } from "./soft-daily-counter.js";

export const KV_WRITE_COUNTER_NAME = "kv:writes";
export const KV_WRITE_PERSIST_EVERY = 25;
export const KV_WRITE_ALERT_THRESHOLD_DEFAULT = 800;

let alertedDay = "";

export function readKvWriteAlertThreshold(env: Env): number {
  const n = Number.parseInt(env.KV_WRITE_ALERT_THRESHOLD?.trim() ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : KV_WRITE_ALERT_THRESHOLD_DEFAULT;
}

export function resetKvWriteMeterForTests(): void {
  alertedDay = "";
}

async function record(raw: KVNamespace, threshold: number): Promise<void> {
  try {
    const r = await trySoftDailyConsume(raw, KV_WRITE_COUNTER_NAME, Number.MAX_SAFE_INTEGER, KV_WRITE_PERSIST_EVERY);
    const day = new Date().toISOString().slice(0, 10);
    if (r.count >= threshold && alertedDay !== day) {
      alertedDay = day;
      console.error(
        JSON.stringify({
          level: "alert",
          event: "kv_write_budget_alert",
          kv_writes_today: r.count,
          threshold,
          budget: 1000,
          day,
        }),
      );
    }
  } catch {
    // fail open
  }
}

export function meterKv(raw: KVNamespace, env: Env): KVNamespace {
  const threshold = readKvWriteAlertThreshold(env);
  return new Proxy(raw, {
    get(target, prop, receiver) {
      if (prop === "put" || prop === "delete") {
        return async (...args: unknown[]) => {
          const fn = Reflect.get(target, prop, target) as (...a: unknown[]) => Promise<unknown>;
          const out = await fn.apply(target, args);
          await record(target, threshold);
          return out;
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/** Shallow env copy with metered RELAY_KV (idempotent per call site). */
export function withMeteredKv(env: Env): Env {
  try {
    return { ...env, RELAY_KV: meterKv(env.RELAY_KV, env) };
  } catch {
    return env;
  }
}
