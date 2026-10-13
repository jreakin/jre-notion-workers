import {
  CLEF_DAILY_CALL_CAP_DEFAULT,
  clefDailyCapKey as coreClefDailyCapKey,
  parseDailyCap,
  tryConsumeDailyCall,
  type ClefCapResult,
} from "../../../../clef-core/src/index.js";
import type { Env } from "../env.js";

export { parseClefCounter, type ClefCapResult } from "../../../../clef-core/src/index.js";

/** Relay keeps the legacy un-gated key `clef:calls:<day>`. */
export function clefDailyCapKey(): string {
  return coreClefDailyCapKey();
}

export function readDailyCap(env: Env): number {
  return parseDailyCap(env.CLEF_DAILY_CALL_CAP, CLEF_DAILY_CALL_CAP_DEFAULT);
}

export async function tryConsumeClefCall(env: Env): Promise<ClefCapResult> {
  return tryConsumeDailyCall(env.RELAY_KV, clefDailyCapKey(), readDailyCap(env));
}
