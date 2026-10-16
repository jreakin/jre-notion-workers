/**
 * Failed coalesce forwards back off instead of retrying every cron minute. CoS ingress answers 400 while the
 * Grok Bot automation run rate limit is exceeded (Oct 13–16), and each 1/min retry cost ~9 RELAY_KV writes,
 * which used up the daily KV write budget (→ `KV PUT failed: 429`). Backoff: 1, 2, 4, 8, then 15 min.
 */
export const COALESCE_RETRY_BASE_MS = 60_000;
export const COALESCE_RETRY_MAX_MS = 15 * 60_000;
/** After this many failed forwards an item is dropped (logged `coalesce_dropped`), ≈ 2 h of retries. */
export const COALESCE_MAX_ATTEMPTS = 12;

export function coalesceRetryDelayMs(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  return Math.min(COALESCE_RETRY_MAX_MS, COALESCE_RETRY_BASE_MS * 2 ** Math.min(n - 1, 10));
}

/** True while the oldest buffered (previously failed) item is still backing off. */
export function coalesceBackingOff(items: readonly { at: string; next_at?: number }[], now = Date.now()): boolean {
  const next = items[0]?.next_at;
  return typeof next === "number" && next > now;
}
