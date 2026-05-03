/**
 * GitHub fetch retry/backoff shim.
 *
 * Wraps `fetch` for GitHub API calls so transient failures (rate limits,
 * 5xx, abort/network errors) are retried with exponential backoff.  Honors
 * `Retry-After` and the `x-ratelimit-reset` header for primary rate limits;
 * falls back to capped exponential backoff otherwise.  Non-retryable
 * statuses (4xx other than 403/429) are returned as-is so the caller can
 * classify them via `classifyGitHubError`.
 */

export interface GitHubRetryOptions {
  retries?: number;
  baseMs?: number;
  /** Cap individual retry sleeps; rate-limit waits past this become a give-up. */
  maxSleepMs?: number;
  /** Optional label for log output. */
  label?: string;
  /** Sleep implementation (overridable for tests). Receives ms. */
  sleep?: (ms: number) => Promise<void>;
  /** Now (ms since epoch) — overridable for tests. */
  now?: () => number;
}

const DEFAULT_RETRIES = 4;
const DEFAULT_BASE_MS = 500;
const DEFAULT_MAX_SLEEP_MS = 60_000; // 60s — bounded to fit worker time budgets

const RETRYABLE_STATUSES = new Set<number>([408, 429, 500, 502, 503, 504]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(ms: number): number {
  return ms / 2 + Math.random() * ms;
}

/**
 * Compute the wait (in ms) implied by a 403/429 GitHub response.
 * Returns `null` when we can't determine a wait from headers.
 */
export function computeRateLimitWaitMs(
  res: Response,
  nowMs: number = Date.now()
): number | null {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) {
    const n = Number(retryAfter);
    if (!Number.isNaN(n) && n >= 0) return Math.max(0, n) * 1000;
  }

  const remaining = res.headers.get("x-ratelimit-remaining");
  const reset = res.headers.get("x-ratelimit-reset");
  if (remaining === "0" && reset) {
    const resetSec = parseInt(reset, 10);
    if (!Number.isNaN(resetSec)) {
      const wait = resetSec * 1000 - nowMs;
      return Math.max(0, wait);
    }
  }

  return null;
}

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status);
}

function isRetryableThrown(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  const msg = err instanceof Error ? err.message : String(err);
  if (/ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network/i.test(msg)) return true;
  if (name === "FetchError" || name === "AbortError" || name === "TypeError") return true;
  return false;
}

/**
 * Execute a GitHub `fetch` call with retry and rate-limit awareness.
 *
 * The `fetcher` is called fresh on each attempt (so the request has no
 * already-consumed body).  On a primary rate-limit (HTTP 403 with
 * `x-ratelimit-remaining: 0`) we wait for the `x-ratelimit-reset` time,
 * capped by `maxSleepMs`.  HTTP 429 honors `Retry-After`.  On a non-OK
 * status that isn't retryable (404, 401, 301, etc.) the response is
 * returned unmodified so the caller can classify it.
 */
export async function fetchWithGitHubRetry(
  fetcher: () => Promise<Response>,
  opts: GitHubRetryOptions = {}
): Promise<Response> {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const baseMs = opts.baseMs ?? DEFAULT_BASE_MS;
  const maxSleepMs = opts.maxSleepMs ?? DEFAULT_MAX_SLEEP_MS;
  const label = opts.label ?? "github";
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? (() => Date.now());

  let attempt = 0;
  while (true) {
    attempt++;
    let res: Response;
    try {
      res = await fetcher();
    } catch (err) {
      if (attempt > retries || !isRetryableThrown(err)) throw err;
      const backoff = Math.min(maxSleepMs, baseMs * 2 ** (attempt - 1));
      const delay = Math.round(jitter(backoff));
      console.warn(
        `[github-retry] ${label} attempt ${attempt}/${retries} threw (${
          err instanceof Error ? err.name : "error"
        }); retrying in ${delay}ms`
      );
      await sleep(delay);
      continue;
    }

    // 403 with remaining=0 OR 429 → primary or secondary rate limit.
    if (res.status === 429 || res.status === 403) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      const isPrimary = res.status === 403 && remaining === "0";
      if (res.status === 429 || isPrimary) {
        if (attempt > retries) return res;
        const explicit = computeRateLimitWaitMs(res, now());
        const fallback = Math.min(maxSleepMs, baseMs * 2 ** (attempt - 1));
        const wait = explicit != null ? Math.min(explicit, maxSleepMs) : fallback;
        // If GitHub asks for longer than our cap, give up so the worker
        // can return a partial result rather than blocking the budget.
        if (explicit != null && explicit > maxSleepMs) {
          console.warn(
            `[github-retry] ${label} rate-limit reset is ${explicit}ms away (> cap ${maxSleepMs}ms); not retrying`
          );
          return res;
        }
        const delay = Math.max(0, Math.round(wait));
        console.warn(
          `[github-retry] ${label} attempt ${attempt}/${retries} rate-limited (HTTP ${res.status}); waiting ${delay}ms`
        );
        await sleep(delay);
        continue;
      }
      // Plain 403 (permission denied) — return for caller.
      return res;
    }

    if (isRetryableStatus(res.status) && attempt <= retries) {
      const backoff = Math.min(maxSleepMs, baseMs * 2 ** (attempt - 1));
      const delay = Math.round(jitter(backoff));
      console.warn(
        `[github-retry] ${label} attempt ${attempt}/${retries} got HTTP ${res.status}; retrying in ${delay}ms`
      );
      await sleep(delay);
      continue;
    }

    return res;
  }
}
