/** Cloudflare KV rejects `expirationTtl` below 60 seconds. */
export const KV_MIN_TTL_SECONDS = 60;

/**
 * Clamp a KV `expirationTtl` to Cloudflare's 60s minimum (rounds up; non-finite → minimum).
 * Every RELAY_KV write with a TTL must go through this helper (enforced by tests/kv-ttl.test.ts).
 */
export function kvTtl(seconds: number): number {
  if (!Number.isFinite(seconds)) return KV_MIN_TTL_SECONDS;
  return Math.max(KV_MIN_TTL_SECONDS, Math.ceil(seconds));
}
