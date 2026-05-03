import { describe, expect, test } from "bun:test";
import {
  fetchWithGitHubRetry,
  computeRateLimitWaitMs,
} from "../../src/shared/github-retry.js";

function ok(body: unknown = {}, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

function err(status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ message: "boom" }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Build a fetcher that returns each response in order. */
function sequence(...responses: Response[]): {
  fetcher: () => Promise<Response>;
  calls: () => number;
} {
  let i = 0;
  return {
    fetcher: async () => {
      const next = responses[i] ?? responses[responses.length - 1]!;
      i++;
      return next;
    },
    calls: () => i,
  };
}

describe("computeRateLimitWaitMs", () => {
  test("uses Retry-After (seconds) when present", () => {
    const res = err(429, { "retry-after": "5" });
    expect(computeRateLimitWaitMs(res, 0)).toBe(5000);
  });

  test("uses x-ratelimit-reset when remaining=0", () => {
    const res = err(403, {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": "1000",
    });
    // Reset is at epoch 1000 (sec); now is 800_000ms → wait 200_000ms.
    expect(computeRateLimitWaitMs(res, 800_000)).toBe(200_000);
  });

  test("returns null when neither header present", () => {
    const res = err(403);
    expect(computeRateLimitWaitMs(res)).toBeNull();
  });

  test("clamps reset time in the past to 0", () => {
    const res = err(403, {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": "1",
    });
    expect(computeRateLimitWaitMs(res, 10_000_000)).toBe(0);
  });
});

describe("fetchWithGitHubRetry", () => {
  test("returns immediately on 200", async () => {
    const seq = sequence(ok({ ok: true }));
    const sleeps: number[] = [];
    const res = await fetchWithGitHubRetry(seq.fetcher, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(res.status).toBe(200);
    expect(seq.calls()).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test("retries on HTTP 503 then succeeds", async () => {
    const seq = sequence(err(503), err(503), ok());
    const sleeps: number[] = [];
    const res = await fetchWithGitHubRetry(seq.fetcher, {
      baseMs: 10,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(res.status).toBe(200);
    expect(seq.calls()).toBe(3);
    expect(sleeps.length).toBe(2);
  });

  test("waits according to x-ratelimit-reset on 403 primary rate limit", async () => {
    const seq = sequence(
      err(403, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "10", // 10 sec since epoch
      }),
      ok()
    );
    let sleptFor: number | null = null;
    const res = await fetchWithGitHubRetry(seq.fetcher, {
      baseMs: 10,
      maxSleepMs: 60_000,
      now: () => 5_000, // 5 sec since epoch → wait ≈ 5_000ms
      sleep: async (ms) => {
        sleptFor = ms;
      },
    });
    expect(res.status).toBe(200);
    expect(sleptFor).toBe(5_000);
  });

  test("respects Retry-After on 429", async () => {
    const seq = sequence(err(429, { "retry-after": "2" }), ok());
    let sleptFor: number | null = null;
    const res = await fetchWithGitHubRetry(seq.fetcher, {
      baseMs: 10,
      sleep: async (ms) => {
        sleptFor = ms;
      },
    });
    expect(res.status).toBe(200);
    expect(sleptFor).toBe(2000);
  });

  test("gives up rather than waiting longer than maxSleepMs", async () => {
    const seq = sequence(
      err(429, { "retry-after": "3600" }), // 1 hour
      ok()
    );
    const sleeps: number[] = [];
    const res = await fetchWithGitHubRetry(seq.fetcher, {
      baseMs: 10,
      maxSleepMs: 1000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    // Returns the 429 without retrying since the wait exceeds the cap.
    expect(res.status).toBe(429);
    expect(seq.calls()).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test("does NOT retry on 404", async () => {
    const seq = sequence(err(404));
    const sleeps: number[] = [];
    const res = await fetchWithGitHubRetry(seq.fetcher, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(res.status).toBe(404);
    expect(seq.calls()).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test("does NOT retry on plain 403 (permission denied, not rate-limit)", async () => {
    const seq = sequence(err(403, { "x-ratelimit-remaining": "100" }));
    const res = await fetchWithGitHubRetry(seq.fetcher, {
      sleep: async () => {},
    });
    expect(res.status).toBe(403);
    expect(seq.calls()).toBe(1);
  });

  test("retries on thrown network error then succeeds", async () => {
    let i = 0;
    const fetcher = async (): Promise<Response> => {
      i++;
      if (i === 1) throw new Error("ECONNRESET network glitch");
      return ok();
    };
    const sleeps: number[] = [];
    const res = await fetchWithGitHubRetry(fetcher, {
      baseMs: 5,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(res.status).toBe(200);
    expect(i).toBe(2);
    expect(sleeps.length).toBe(1);
  });

  test("returns final non-OK response after exhausting retries", async () => {
    const seq = sequence(err(503), err(503), err(503), err(503), err(503));
    const res = await fetchWithGitHubRetry(seq.fetcher, {
      retries: 2,
      baseMs: 1,
      sleep: async () => {},
    });
    expect(res.status).toBe(503);
    // 1 initial + 2 retries = 3 calls
    expect(seq.calls()).toBe(3);
  });
});
