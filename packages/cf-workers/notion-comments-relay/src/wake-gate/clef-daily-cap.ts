import {
  CLEF_DAILY_CALL_CAP_DEFAULT,
  clefDailyCapKey as coreClefDailyCapKey,
  parseDailyCap,
  type ClefCapResult,
} from "../../../../clef-core/src/index.js";
import type { Env } from "../env.js";
import { trySoftDailyConsume } from "../soft-daily-counter.js";

export { parseClefCounter, type ClefCapResult } from "../../../../clef-core/src/index.js";

/**
 * KV budget (#39 B1): persist the main Clef counter every N calls instead of every call.
 * Worst case at CLEF_DAILY_CALL_CAP=2000: ceil(2000/25) = 80 writes/day (was 2000).
 */
export const CLEF_COUNTER_PERSIST_EVERY = 25;
/** Soft-counter name → key `clef:calls:<YYYY-MM-DD>` (identical to the legacy relay key). */
export const CLEF_COUNTER_NAME = "clef:calls";

/** Relay keeps the legacy un-gated key `clef:calls:<day>`. */
export function clefDailyCapKey(): string {
  return coreClefDailyCapKey();
}

export function readDailyCap(env: Env): number {
  return parseDailyCap(env.CLEF_DAILY_CALL_CAP, CLEF_DAILY_CALL_CAP_DEFAULT);
}

export async function tryConsumeClefCall(env: Env): Promise<ClefCapResult> {
  try {
    const r = await trySoftDailyConsume(
      env.RELAY_KV,
      CLEF_COUNTER_NAME,
      readDailyCap(env),
      CLEF_COUNTER_PERSIST_EVERY,
      new Date(),
      { rejectInvalid: true },
    );
    if (r.ok) return { ok: true, count: r.count };
    return { ok: false, reason: r.reason === "invalid" ? "clef_cap_invalid" : "clef_daily_cap" };
  } catch {
    return { ok: false, reason: "clef_cap_unavailable" };
  }
}
