/**
 * Shared Notion retry/backoff helper.
 *
 * Wraps async Notion SDK calls with exponential backoff. Honors `Retry-After`
 * (`retry_after` on APIResponseError) for `rate_limited`, retries transient
 * `internal_server_error` and 5xx network errors, and rethrows
 * non-retryable errors immediately.
 */
import { APIResponseError } from "@notionhq/client";

export interface RetryOptions {
  retries?: number;
  baseMs?: number;
  maxMs?: number;
  /** Optional label for logs. */
  label?: string;
}

const DEFAULT_RETRIES = 4;
const DEFAULT_BASE_MS = 250;
const DEFAULT_MAX_MS = 8000;

const RETRYABLE_CODES = new Set<string>([
  "rate_limited",
  "internal_server_error",
  "service_unavailable",
  "bad_gateway",
  "gateway_timeout",
  "conflict_error",
]);

function isRetryable(err: unknown): boolean {
  if (err instanceof APIResponseError) {
    return RETRYABLE_CODES.has(err.code);
  }
  const name = err instanceof Error ? err.name : "";
  const msg = err instanceof Error ? err.message : String(err);
  if (/ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up/i.test(msg)) return true;
  if (name === "FetchError" || name === "AbortError") return true;
  return false;
}

function retryAfterMs(err: unknown): number | null {
  if (err instanceof APIResponseError) {
    const headers = (err as unknown as { headers?: Record<string, string> }).headers;
    const ra = headers?.["retry-after"] ?? headers?.["Retry-After"];
    if (ra) {
      const n = Number(ra);
      if (!Number.isNaN(n) && n > 0) return Math.min(n * 1000, DEFAULT_MAX_MS * 4);
    }
  }
  return null;
}

function jitter(ms: number): number {
  return ms / 2 + Math.random() * ms;
}

export async function withNotionRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const baseMs = opts.baseMs ?? DEFAULT_BASE_MS;
  const maxMs = opts.maxMs ?? DEFAULT_MAX_MS;
  const label = opts.label ?? "notion";

  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (!isRetryable(err) || attempt > retries) throw err;
      const ra = retryAfterMs(err);
      const backoff = ra ?? Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const delay = Math.round(jitter(backoff));
      const code = err instanceof APIResponseError ? err.code : (err instanceof Error ? err.name : "error");
      console.warn(`[notion-retry] ${label} attempt ${attempt}/${retries} failed (${code}); retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** Sleep helper for callers that want to throttle outside retry loops. */
export async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}
