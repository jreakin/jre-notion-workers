import type { KvLike } from "./kv.js";

export function utcDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** `clef:calls:<day>` (legacy relay key) or `clef:calls:<gate>:<day>` when a gate is given. */
export function clefDailyCapKey(gate?: string, now: Date = new Date()): string {
  return gate ? `clef:calls:${gate}:${utcDayKey(now)}` : `clef:calls:${utcDayKey(now)}`;
}

export function parseDailyCap(raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return fallback;
  }
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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

/** Best-effort KV counter (not atomic; KV is eventually consistent — soft cap). */
export async function tryConsumeDailyCall(
  kv: KvLike,
  key: string,
  cap: number,
): Promise<ClefCapResult> {
  try {
    const raw = await kv.get(key);
    const current = parseClefCounter(raw);
    if (current === null) {
      return { ok: false, reason: "clef_cap_invalid" };
    }
    if (current >= cap) {
      return { ok: false, reason: "clef_daily_cap" };
    }
    await kv.put(key, String(current + 1), { expirationTtl: 60 * 60 * 48 });
    return { ok: true, count: current + 1 };
  } catch {
    return { ok: false, reason: "clef_cap_unavailable" };
  }
}
