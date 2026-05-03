import { describe, expect, it } from "bun:test";
import { withNotionRetry } from "../../src/shared/notion-retry.js";

describe("withNotionRetry", () => {
  it("returns the result on first success", async () => {
    let calls = 0;
    const r = await withNotionRetry(async () => {
      calls++;
      return "ok";
    });
    expect(r).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries on transient network errors and eventually succeeds", async () => {
    let calls = 0;
    const r = await withNotionRetry(
      async () => {
        calls++;
        if (calls < 3) {
          const err = new Error("ECONNRESET");
          (err as { name: string }).name = "FetchError";
          throw err;
        }
        return "ok";
      },
      { retries: 5, baseMs: 1, maxMs: 5 }
    );
    expect(r).toBe("ok");
    expect(calls).toBe(3);
  });

  it("rethrows non-retryable errors immediately", async () => {
    let calls = 0;
    let caught: Error | null = null;
    try {
      await withNotionRetry(
        async () => {
          calls++;
          throw new Error("validation_error: bad input");
        },
        { retries: 5, baseMs: 1, maxMs: 5 }
      );
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(calls).toBe(1);
  });

  it("gives up after retries exhausted", async () => {
    let calls = 0;
    let caught: Error | null = null;
    try {
      await withNotionRetry(
        async () => {
          calls++;
          const err = new Error("ETIMEDOUT");
          throw err;
        },
        { retries: 2, baseMs: 1, maxMs: 5 }
      );
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(calls).toBe(3); // initial + 2 retries
  });
});
