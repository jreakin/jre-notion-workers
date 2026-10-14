/**
 * Per-isolate throttle for the `last_notion_post` debug snapshot.
 *
 * The relay used to PUT the debug snapshot to RELAY_KV on every inbound POST. At webhook
 * bursts (e.g. thousands of page.properties_updated events) that alone blew through the
 * ~1k KV writes/day budget, tripped Cloudflare's 1 write/sec/key limit (429), and kept
 * `kv_write_budget_alert` firing. The snapshot is only a debugging aid for /setup/last-post,
 * so capturing at most once per interval per isolate keeps it useful at a fraction of the cost.
 */
export const DEBUG_CAPTURE_MIN_INTERVAL_MS = 60_000;

let lastCaptureAt = Number.NEGATIVE_INFINITY;

/** Returns true (and claims the slot) when a debug snapshot may be written now. */
export function claimDebugCaptureSlot(
  nowMs: number = Date.now(),
  minIntervalMs: number = DEBUG_CAPTURE_MIN_INTERVAL_MS,
): boolean {
  if (nowMs - lastCaptureAt < minIntervalMs) return false;
  lastCaptureAt = nowMs;
  return true;
}

export function resetDebugCaptureThrottleForTests(): void {
  lastCaptureAt = Number.NEGATIVE_INFINITY;
}
