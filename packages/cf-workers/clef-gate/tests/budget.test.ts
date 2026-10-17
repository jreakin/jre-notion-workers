import { afterEach, describe, expect, test } from "bun:test";
import { CLEF_COMPLETION_BUDGET_MS, CLEF_RATE_LIMITED_REASON, isRateLimitError } from "../src/clef-email.js";
import { processEmailShadow } from "../src/shadow.js";
import { answers, captureLogs, HASH_FLASH, makeEnv, payload } from "./helpers.js";

let cap: ReturnType<typeof captureLogs> | null = null;
afterEach(() => {
  cap?.restore();
  cap = null;
});

function gwErr(): Error {
  const e = new Error("gateway 502");
  e.name = "AiGatewayError";
  return e;
}

/** Fake clock: every model call costs `callMs`; sleeps advance the clock too. */
function clocked(env: ReturnType<typeof makeEnv>["env"], behave: (slug: string, n: number) => unknown, callMs = 3000) {
  let t = 1_000_000;
  const slugs: string[] = [];
  (env.AI as { run: unknown }).run = async (slug: string) => {
    slugs.push(slug);
    t += callMs;
    const r = behave(slug, slugs.length);
    if (r instanceof Error) throw r;
    return r;
  };
  const deps = { now: () => t, sleep: async (ms: number) => { t += ms; } };
  return { deps, slugs, start: t, elapsed: () => t - 1_000_000 };
}

function capCount(kv: { data: Map<string, string> }): number {
  for (const [k, v] of kv.data) if (k.startsWith("clef:calls:")) return Number.parseInt(v, 10);
  return 0;
}

describe("total time budget + cap per real call", () => {
  test("all full attempts fail: retries + fallback stay inside the budget; side-by-side skipped (fallback)", async () => {
    cap = captureLogs();
    const { env, kv } = makeEnv();
    const c = clocked(env, () => gwErr());
    const e = await processEmailShadow(env, JSON.stringify(payload({ msg_id_hash: HASH_FLASH })), c.deps);
    expect(c.elapsed()).toBeLessThanOrEqual(CLEF_COMPLETION_BUDGET_MS);
    expect(CLEF_COMPLETION_BUDGET_MS).toBeLessThanOrEqual(25_000); // < 30 s waitUntil, with headroom
    expect(c.slugs).toEqual(["@cf/cloudflare/clef", "@cf/cloudflare/clef", "@cf/cloudflare/clef", "@cf/cloudflare/clef-flash"]);
    expect(e?.flash_shadow_label).toBeNull();
    expect(e?.shadow_label).toBe("error");
    expect(capCount(kv)).toBe(4); // every real call took a cap unit
  });

  test("side-by-side flash: one call, no retries, even when it fails", async () => {
    cap = captureLogs();
    const { env, kv } = makeEnv();
    const c = clocked(env, (slug) => (slug === "@cf/cloudflare/clef-flash" ? gwErr() : answers()));
    const e = await processEmailShadow(env, JSON.stringify(payload({ msg_id_hash: HASH_FLASH })), c.deps);
    expect(c.slugs).toEqual(["@cf/cloudflare/clef", "@cf/cloudflare/clef-flash"]);
    expect(e?.flash_shadow_label).toBe("error");
    expect(e?.flash_agree).toBeNull();
    expect(capCount(kv)).toBe(2);
  });

  test("side-by-side flash is skipped when less than one call's time is left", async () => {
    cap = captureLogs();
    const { env } = makeEnv();
    const c = clocked(env, (_s, n) => (n < 3 ? gwErr() : answers())); // 3 full calls + 1 s backoff ≈ 10 s
    const e = await processEmailShadow(env, JSON.stringify(payload({ msg_id_hash: HASH_FLASH })), {
      ...c.deps,
      budgetMs: 12_000,
    });
    expect(e?.shadow_label).toBe("would_skip");
    expect(e?.flash_sample).toBe(true);
    expect(e?.flash_shadow_label).toBeNull();
    expect(c.slugs.filter((s) => s.endsWith("clef-flash")).length).toBe(0);
    expect(c.elapsed()).toBeLessThanOrEqual(12_000);
  });

  test("budget exhaustion stops retries early, keeps the real failure reason, logs clef_stopped", async () => {
    cap = captureLogs();
    const { env } = makeEnv();
    const c = clocked(env, () => gwErr(), 4000);
    const e = await processEmailShadow(env, JSON.stringify(payload()), { ...c.deps, budgetMs: 9_000 });
    expect(c.elapsed()).toBeLessThanOrEqual(9_000 + 4000); // a started call is bounded by its clipped timeout
    expect(e?.error_reason).toBe("clef_error:AiGatewayError");
    expect(e?.clef_stopped).toBe("clef_budget_exhausted");
    // 2 full calls, the 3rd retry no longer fits; the flash fallback still fits (its timeout is clipped).
    expect(e?.clef_attempts).toBe(3);
    expect(e?.clef_fallback).toBe(true);
  });

  test("cap reached mid-retry stops further calls (clef_stopped = clef_daily_cap)", async () => {
    cap = captureLogs();
    const { env } = makeEnv();
    (env as { CLEF_EMAIL_DAILY_CALL_CAP?: string }).CLEF_EMAIL_DAILY_CALL_CAP = "2";
    const c = clocked(env, () => gwErr(), 10);
    const e = await processEmailShadow(env, JSON.stringify(payload()), c.deps);
    expect(e?.clef_attempts).toBe(2);
    expect(e?.clef_stopped).toBe("clef_daily_cap");
  });
});

function rateLimited(): Error {
  const e = new Error("AiGateway: 429 Too Many Requests (rate limit)");
  e.name = "AiGatewayError";
  return e;
}

describe("gateway rate limit (429)", () => {
  test("isRateLimitError: status/code fields and 429 / rate-limit messages only", () => {
    expect(isRateLimitError(rateLimited())).toBe(true);
    expect(isRateLimitError(Object.assign(new Error("x"), { status: 429 }))).toBe(true);
    expect(isRateLimitError(new Error("Rate limited by gateway"))).toBe(true);
    expect(isRateLimitError(gwErr())).toBe(false);
    expect(isRateLimitError(new Error("clef_timeout"))).toBe(false);
    expect(isRateLimitError("429")).toBe(false);
  });

  test("429 then success: waits seconds (jittered), not 250 ms, and no flash fallback", async () => {
    cap = captureLogs();
    const { env } = makeEnv();
    const sleeps: number[] = [];
    const c = clocked(env, (_slug, n) => (n === 1 ? rateLimited() : answers()));
    const deps = { ...c.deps, random: () => 0.5, sleep: async (ms: number) => { sleeps.push(ms); await c.deps.sleep(ms); } };
    const e = await processEmailShadow(env, JSON.stringify(payload()), deps);
    expect(sleeps).toEqual([4_000]);
    expect(c.slugs).toEqual(["@cf/cloudflare/clef", "@cf/cloudflare/clef"]);
    expect(e?.shadow_label).not.toBe("error");
    expect(e?.clef_attempts).toBe(2);
  });

  test("429 on every try: logged as RateLimited, never falls back to flash (same gateway limit), no side-by-side", async () => {
    cap = captureLogs();
    const { env, kv } = makeEnv();
    const c = clocked(env, () => rateLimited());
    const deps = { ...c.deps, random: () => 0 };
    const e = await processEmailShadow(env, JSON.stringify(payload({ msg_id_hash: HASH_FLASH })), deps);
    expect(c.slugs.every((s) => s === "@cf/cloudflare/clef")).toBe(true);
    expect(c.slugs.length).toBe(3);
    expect(e?.error_reason).toBe(CLEF_RATE_LIMITED_REASON);
    expect(e?.clef_fallback).toBe(false);
    expect(e?.flash_sample).toBe(false);
    expect(c.elapsed()).toBeLessThanOrEqual(CLEF_COMPLETION_BUDGET_MS);
    expect(capCount(kv)).toBe(3);
  });

  test("jitter stays within ±30 % of the base backoff", async () => {
    for (const r of [0, 0.999]) {
      cap?.restore();
      cap = captureLogs();
      const { env } = makeEnv();
      const sleeps: number[] = [];
      const c = clocked(env, (_s, n) => (n === 1 ? rateLimited() : answers()));
      await processEmailShadow(env, JSON.stringify(payload()), {
        ...c.deps,
        random: () => r,
        sleep: async (ms: number) => { sleeps.push(ms); await c.deps.sleep(ms); },
      });
      expect(sleeps[0]).toBeGreaterThanOrEqual(2_800);
      expect(sleeps[0]).toBeLessThanOrEqual(5_200);
    }
  });
});
