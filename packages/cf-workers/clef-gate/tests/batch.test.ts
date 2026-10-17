import { afterEach, describe, expect, test } from "bun:test";
import {
  BATCH_BAD_OUTPUT,
  BATCH_ITEM_MISSING,
  ClefBatchCore,
  MAX_SINGLE_FALLBACK,
  buildBatchRequest,
  parseBatchResponse,
  parseBatchSize,
} from "../src/batch.js";
import { buildEmailState, CLEF_RATE_LIMITED_REASON, EMAIL_QUESTIONS } from "../src/clef-email.js";
import { parseEmailShadowBody } from "../src/payload.js";
import { processEmailShadow, type EmailBatcher } from "../src/shadow.js";
import { answers, captureLogs, HASH_FLASH, makeEnv, payload, SECRET_SNIPPET, SECRET_SUBJECT } from "./helpers.js";

let cap: ReturnType<typeof captureLogs> | null = null;
afterEach(() => {
  cap?.restore();
  cap = null;
});

/** Batch answers for n items; `skip` items get no answers, `bad` items get an out-of-range value. */
function batchAnswers(n: number, opts: { skip?: number[]; bad?: number[]; bulk?: number } = {}) {
  const out: Record<string, unknown> = {};
  for (let i = 1; i <= n; i++) {
    if (opts.skip?.includes(i)) continue;
    const a = answers({ bulk: opts.bulk ?? 0.95 }).answers as Record<string, unknown>;
    for (const [k, v] of Object.entries(a)) out[`e${i}__${k}`] = v;
    if (opts.bad?.includes(i)) out[`e${i}__q_person`] = { type: "noul", noul: 7 };
  }
  return { result: { answers: out } };
}

function core(run: (states: readonly string[]) => Promise<unknown>, maxSize = 20) {
  const calls: number[] = [];
  let capUnits = 0;
  const c = new ClefBatchCore({
    maxSize,
    windowMs: 0,
    sleep: async () => {},
    random: () => 0.5,
    setTimer: (fn) => queueMicrotask(fn),
    consume: async () => {
      capUnits++;
      return null;
    },
    run: async (states) => {
      calls.push(states.length);
      return run(states);
    },
  });
  return { c, calls, capUnits: () => capUnits };
}

const states = (n: number) => Array.from({ length: n }, (_, i) => `state-${i}`);

describe("batch request / response", () => {
  test("one state + scoped questions per email; only the masked state goes in", () => {
    const parsed = parseEmailShadowBody(JSON.stringify(payload()));
    if (!parsed.ok) throw new Error("payload");
    const s = buildEmailState(parsed.item);
    const req = buildBatchRequest([s, s]);
    expect(Object.keys(req.questions).length).toBe(2 * Object.keys(EMAIL_QUESTIONS).length);
    expect(Object.keys(req.questions)).toContain("e2__q_lane");
    expect(req.state).toContain("### email e1");
    expect(req.state).not.toContain("jane.doe@example.com");
    expect(req.state).not.toContain("987654321");
  });

  test("partial / malformed answers parse to null per item", () => {
    const r = parseBatchResponse(batchAnswers(4, { skip: [2], bad: [3] }), 4);
    expect(r.map((x) => x !== null)).toEqual([true, false, false, true]);
    expect(parseBatchResponse("garbage", 3)).toEqual([null, null, null]);
  });

  test("batch size: default 20, clamped to 25", () => {
    expect(parseBatchSize(undefined)).toBe(20);
    expect(parseBatchSize("0")).toBe(20);
    expect(parseBatchSize("100")).toBe(25);
    expect(parseBatchSize("10")).toBe(10);
  });
});

describe("ClefBatchCore", () => {
  test("120-email burst → 6 calls of 20 (fits the 300/min gateway limit), one cap unit per call", async () => {
    const { c, calls, capUnits } = core(async (s) => batchAnswers(s.length));
    const res = await Promise.all(states(120).map((s) => c.submit(s)));
    expect(calls).toEqual([20, 20, 20, 20, 20, 20]);
    expect(capUnits()).toBe(6);
    expect(res.every((r) => r.ok && r.batch_size === 20)).toBe(true);
  });

  test("partial answers: missing items re-batched once in one call", async () => {
    let n = 0;
    const { c, calls } = core(async (s) => (++n === 1 ? batchAnswers(s.length, { skip: [3, 7] }) : batchAnswers(s.length)));
    const res = await Promise.all(states(10).map((s) => c.submit(s)));
    expect(calls).toEqual([10, 2]);
    expect(res.every((r) => r.ok)).toBe(true);
  });

  test("still missing after the re-batch: at most MAX_SINGLE_FALLBACK go per-email, the rest are bad output", async () => {
    const { c, calls } = core(async () => ({ result: { answers: {} } }));
    const res = await Promise.all(states(12).map((s) => c.submit(s)));
    expect(calls).toEqual([12, 12]);
    expect(res.filter((r) => !r.ok && r.fallback && r.reason === BATCH_ITEM_MISSING).length).toBe(MAX_SINGLE_FALLBACK);
    expect(res.filter((r) => !r.ok && !r.fallback && r.reason === BATCH_BAD_OUTPUT).length).toBe(12 - MAX_SINGLE_FALLBACK);
  });

  test("whole-call 429 is retried once; then every item errors (no per-email fan-out)", async () => {
    const { c, calls } = core(async () => {
      throw Object.assign(new Error("429 Too Many Requests"), { name: "AiGatewayError" });
    });
    const res = await Promise.all(states(5).map((s) => c.submit(s)));
    expect(calls).toEqual([5, 5]);
    expect(res.every((r) => !r.ok && !r.fallback && r.reason === CLEF_RATE_LIMITED_REASON)).toBe(true);
  });

  test("transient error then success", async () => {
    let n = 0;
    const { c } = core(async (s) => {
      if (++n === 1) throw Object.assign(new Error("502"), { name: "AiGatewayError" });
      return batchAnswers(s.length);
    });
    const res = await Promise.all(states(3).map((s) => c.submit(s)));
    expect(res.every((r) => r.ok && r.attempts === 2)).toBe(true);
  });

  test("cap reached: no call, items get the cap reason", async () => {
    const c = new ClefBatchCore({
      maxSize: 20,
      setTimer: (fn) => queueMicrotask(fn),
      consume: async () => "clef_daily_cap",
      run: async () => {
        throw new Error("must not run");
      },
    });
    const res = await Promise.all(states(3).map((s) => c.submit(s)));
    expect(res.every((r) => !r.ok && r.reason === "clef_daily_cap" && !r.fallback)).toBe(true);
  });
});

describe("shadow flow with a batcher", () => {
  const fake = (r: Awaited<ReturnType<EmailBatcher["classify"]>>): EmailBatcher & { states: string[] } => {
    const states: string[] = [];
    return { states, classify: async (s) => (states.push(s), r) };
  };

  test("batched verdict fills the row; no single call; secrets never logged", async () => {
    cap = captureLogs();
    const { env, calls, kv } = makeEnv();
    const b = fake({ ok: true, parsed: { p_person: 0.01, p_money_sec: 0.01, lane: "none", p_bulk: 0.95, p_calendar: 0.01, urgency: 1, confidence: 0.9 }, batch_size: 20, attempts: 1 });
    const e = await processEmailShadow(env, JSON.stringify(payload()), { batcher: b });
    expect(calls.length).toBe(0);
    expect(b.states.length).toBe(1);
    expect(e?.shadow_label).toBe("would_skip");
    expect(e?.clef_batch_size).toBe(20);
    expect(e?.clef_attempts).toBe(1);
    const all = cap.lines.join("\n") + [...kv.data.values()].join("\n");
    expect(all).not.toContain(SECRET_SUBJECT.slice(0, 20));
    expect(all).not.toContain(SECRET_SNIPPET.slice(0, 20));
    expect(all).not.toContain("jane.doe");
  });

  test("missing in batch → scored alone (one single call), flagged clef_batch_fallback", async () => {
    cap = captureLogs();
    const { env, calls } = makeEnv(answers());
    const b = fake({ ok: false, reason: BATCH_ITEM_MISSING, fallback: true, batch_size: 20, attempts: 1 });
    const e = await processEmailShadow(env, JSON.stringify(payload()), { batcher: b });
    expect(calls.length).toBe(1);
    expect(e?.clef_batch_fallback).toBe(true);
    expect(e?.shadow_label).toBe("would_skip");
  });

  test("whole-batch failure → error row, no single call, no side-by-side on 429", async () => {
    cap = captureLogs();
    const { env, calls } = makeEnv();
    const b = fake({ ok: false, reason: CLEF_RATE_LIMITED_REASON, fallback: false, batch_size: 20, attempts: 2 });
    const e = await processEmailShadow(env, JSON.stringify(payload({ msg_id_hash: HASH_FLASH })), { batcher: b });
    expect(calls.length).toBe(0);
    expect(e?.shadow_label).toBe("error");
    expect(e?.error_reason).toBe(CLEF_RATE_LIMITED_REASON);
    expect(e?.flash_sample).toBe(false);
  });

  test("batcher throws → error row (clef_batch_unavailable), not a fail-open single call", async () => {
    cap = captureLogs();
    const { env, calls } = makeEnv();
    const e = await processEmailShadow(env, JSON.stringify(payload()), {
      batcher: { classify: async () => { throw new Error("do down"); } },
    });
    expect(calls.length).toBe(0);
    expect(e?.error_reason).toBe("clef_batch_unavailable");
  });

  test("no batcher bound → legacy one call per email", async () => {
    cap = captureLogs();
    const { env, calls } = makeEnv();
    const e = await processEmailShadow(env, JSON.stringify(payload()), {});
    expect(calls.length).toBe(1);
    expect(e?.clef_batch_size).toBeNull();
  });
});

describe("batch time budget", () => {
  test("slow first call: no retry / re-batch past the batch budget; missing items still get a per-email fallback", async () => {
    let t = 0;
    const calls: number[] = [];
    const c = new ClefBatchCore({
      maxSize: 20,
      now: () => t,
      sleep: async (ms) => { t += ms; },
      setTimer: (fn) => queueMicrotask(fn),
      consume: async () => null,
      run: async (s) => {
        calls.push(s.length);
        t += 8_000; // a full-timeout call
        return batchAnswers(s.length, { skip: [1, 2] });
      },
    });
    const res = await Promise.all(states(4).map((s) => c.submit(s)));
    expect(calls).toEqual([4]); // 15 s budget: no time for the 8 s re-batch call
    expect(res.filter((r) => !r.ok && r.fallback).length).toBe(2);
    expect(res.filter((r) => r.ok).length).toBe(2);
  });
});
