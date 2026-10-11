import { CLEF_DAILY_CALL_CAP_DEFAULT } from "./clef-thresholds.js";
import type { Env } from "../env.js";

function utcDayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function clefDailyCapKey(): string {
  return `clef:calls:${utcDayKey()}`;
}

export function readDailyCap(env: Env): number {
  const raw = env.CLEF_DAILY_CALL_CAP?.trim();
  if (!raw) {
    return CLEF_DAILY_CALL_CAP_DEFAULT;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : CLEF_DAILY_CALL_CAP_DEFAULT;
}

export function parseClefCounter(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") {
    return 0;
  }
  if (!/^\d+$/.test(raw.trim())) {
    return null;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    return null;
  }
  return n;
}

export type ClefCapResult =
  | { ok: true; count: number }
  | { ok: false; reason: "clef_daily_cap" | "clef_cap_invalid" | "clef_cap_unavailable" };

export async function tryConsumeClefCall(env: Env): Promise<ClefCapResult> {
  const cap = readDailyCap(env);
  const key = clefDailyCapKey();
  try {
    const raw = await env.RELAY_KV.get(key);
    const current = parseClefCounter(raw);
    if (current === null) {
      return { ok: false, reason: "clef_cap_invalid" };
    }
    if (current >= cap) {
      return { ok: false, reason: "clef_daily_cap" };
    }
    await env.RELAY_KV.put(key, String(current + 1), { expirationTtl: 60 * 60 * 48 });
    return { ok: true, count: current + 1 };
  } catch {
    return { ok: false, reason: "clef_cap_unavailable" };
  }
}
