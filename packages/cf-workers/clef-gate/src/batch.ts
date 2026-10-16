/**
 * Clef email batching: one Workers AI call scores up to CLEF_EMAIL_BATCH_SIZE (default 20) emails.
 *
 * Why: the clef-shadow-gate AI Gateway allows 60 req / 60 s and the morning inbox run posts 120+
 * emails in a minute (Oct 14/15 7:12 AM CT bursts → 429 → fail-open). One call per ~20 emails fits.
 *
 * Privacy: the batch state carries only each email's masked + clipped state (buildEmailState: masked
 * subject/snippet + non-PII metadata). It lives in Durable Object memory only for the batch window, is
 * never written to storage, and is never logged. Results carry parsed scores only.
 *
 * Failure policy (no en-masse fail-open, no en-masse fan-out):
 * - whole call fails (gateway error / 429 / timeout) → retried with backoff; if still failing, every item
 *   in the batch gets that error (row `error`), NOT one call per email (that would rebuild the burst);
 * - partial / malformed answers → the missing items are re-batched once; items still missing after that
 *   get `fallback: true` (the caller scores them alone), at most MAX_SINGLE_FALLBACK per batch; the rest
 *   get `clef_batch_bad_output`.
 */
import { EMAIL_QUESTIONS, isRateLimitError, parseEmailClefResponse, CLEF_RATE_LIMITED_REASON, type ParsedEmailRun } from "./clef-email.js";
import { clefErrorReason } from "../../../clef-core/src/index.js";

export const BATCH_SIZE_DEFAULT = 20;
export const BATCH_SIZE_MAX = 25;
/** How long the first item of a batch waits for company before the batch is sent. */
export const BATCH_WINDOW_MS = 2_000;
/** Timeout for one batch call (a batch answers ~20× the questions of a single call). */
export const BATCH_CALL_TIMEOUT_MS = 8_000;
/**
 * All work for one batch (first call, one retry, one re-batch) must end within this, so the waiting
 * emails (22 s budget, 2 s window) still have a single call's time for a per-email fallback.
 */
export const BATCH_TOTAL_MS = 15_000;
export const BATCH_BACKOFF_MS = [500] as const;
export const BATCH_RATE_LIMIT_BACKOFF_MS = [4_000] as const;
export const MAX_SINGLE_FALLBACK = 5;
export const BATCH_BAD_OUTPUT = "clef_batch_bad_output";
export const BATCH_ITEM_MISSING = "clef_batch_item_missing";

export function parseBatchSize(raw: string | undefined): number {
  const n = Number.parseInt(raw?.trim() ?? "", 10);
  if (!Number.isFinite(n) || n < 1) return BATCH_SIZE_DEFAULT;
  return Math.min(n, BATCH_SIZE_MAX);
}

type Q = (typeof EMAIL_QUESTIONS)[keyof typeof EMAIL_QUESTIONS];

/** One state + one question set for n emails: `e<i>__q_*` keys, each instruction scoped to email e<i>. */
export function buildBatchRequest(states: readonly string[]): { state: string; questions: Record<string, unknown> } {
  const blocks: string[] = [];
  const questions: Record<string, unknown> = {};
  states.forEach((s, i) => {
    const id = `e${i + 1}`;
    blocks.push(`### email ${id}\n${s}`);
    for (const [k, q] of Object.entries(EMAIL_QUESTIONS) as [string, Q][]) {
      questions[`${id}__${k}`] = { ...q, instructions: `About email ${id} only: ${q.instructions}` };
    }
  });
  return {
    state: `${states.length} separate emails follow. Judge each one on its own.\n\n${blocks.join("\n\n")}`,
    questions,
  };
}

/** Per-email parse of a batch answer; null where the item's answers are missing or malformed. */
export function parseBatchResponse(raw: unknown, n: number): (ParsedEmailRun | null)[] {
  const top = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const body = top && top.result && typeof top.result === "object" ? (top.result as Record<string, unknown>) : top;
  const answers = body && body.answers && typeof body.answers === "object" ? (body.answers as Record<string, unknown>) : null;
  const out: (ParsedEmailRun | null)[] = [];
  for (let i = 0; i < n; i++) {
    if (!answers) {
      out.push(null);
      continue;
    }
    const prefix = `e${i + 1}__`;
    const mine: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(answers)) if (k.startsWith(prefix)) mine[k.slice(prefix.length)] = v;
    out.push(parseEmailClefResponse({ answers: mine }));
  }
  return out;
}

export type BatchItemResult =
  | { ok: true; parsed: ParsedEmailRun; batch_size: number; attempts: number }
  | { ok: false; reason: string; fallback: boolean; batch_size: number; attempts: number };

export type BatchDeps = {
  /** One model call for `states` (the batch). Throws on gateway/AI error or timeout. */
  run: (states: readonly string[]) => Promise<unknown>;
  /** Takes one daily-cap unit per batch call; returns a stop reason or null. */
  consume: () => Promise<string | null>;
  maxSize: number;
  windowMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  now?: () => number;
};

type Pending = { state: string; resolve: (r: BatchItemResult) => void };

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ClefBatchCore {
  private pending: Pending[] = [];
  private timerSet = false;
  constructor(private deps: BatchDeps) {}

  /** Queue one email state; resolves with that email's verdict once its batch is scored. */
  submit(state: string): Promise<BatchItemResult> {
    return new Promise((resolve) => {
      this.pending.push({ state, resolve });
      if (this.pending.length >= this.deps.maxSize) {
        void this.flush();
      } else if (!this.timerSet) {
        this.timerSet = true;
        const set = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
        set(() => {
          this.timerSet = false;
          void this.flush();
        }, this.deps.windowMs ?? BATCH_WINDOW_MS);
      }
    });
  }

  /** Send everything queued now, in chunks of maxSize. */
  async flush(): Promise<void> {
    while (this.pending.length > 0) {
      const batch = this.pending.splice(0, this.deps.maxSize);
      try {
        await this.score(batch);
      } catch {
        for (const p of batch) p.resolve({ ok: false, reason: "clef_batch_failed", fallback: false, batch_size: batch.length, attempts: 0 });
      }
    }
  }

  /** One call with retry; returns raw or a failure reason. */
  private async call(states: readonly string[], deadline: number): Promise<{ raw: unknown; attempts: number } | { reason: string; attempts: number }> {
    const sleep = this.deps.sleep ?? realSleep;
    const random = this.deps.random ?? Math.random;
    let attempts = 0;
    let reason = "clef_batch_failed";
    const now = this.deps.now ?? Date.now;
    for (let i = 0; i <= 1; i++) {
      // No call (first, retry, or re-batch) starts without a full call's time left in the batch budget.
      if (deadline - now() < BATCH_CALL_TIMEOUT_MS) return { reason: attempts === 0 ? "clef_budget_exhausted" : reason, attempts };
      const stop = await this.deps.consume();
      if (stop) return { reason: attempts === 0 ? stop : reason, attempts };
      attempts++;
      try {
        return { raw: await this.deps.run(states), attempts };
      } catch (err) {
        reason = isRateLimitError(err) ? CLEF_RATE_LIMITED_REASON : clefErrorReason(err);
        if (i === 0) {
          const base = reason === CLEF_RATE_LIMITED_REASON ? BATCH_RATE_LIMIT_BACKOFF_MS[0] : BATCH_BACKOFF_MS[0];
          await sleep(Math.round(base * (0.7 + 0.6 * random())));
        }
      }
    }
    return { reason, attempts };
  }

  private async score(batch: Pending[]): Promise<void> {
    const size = batch.length;
    const deadline = (this.deps.now ?? Date.now)() + BATCH_TOTAL_MS;
    const first = await this.call(batch.map((p) => p.state), deadline);
    if (!("raw" in first)) {
      for (const p of batch) p.resolve({ ok: false, reason: first.reason, fallback: false, batch_size: size, attempts: first.attempts });
      return;
    }
    let attempts = first.attempts;
    const results = parseBatchResponse(first.raw, size);
    let missing = batch.map((_, i) => i).filter((i) => results[i] === null);
    // Re-batch the missing items once (one call), unless only one is missing (score it alone instead).
    if (missing.length > 1) {
      const again = await this.call(missing.map((i) => batch[i]!.state), deadline);
      if ("raw" in again) {
        attempts += again.attempts;
        const re = parseBatchResponse(again.raw, missing.length);
        missing.forEach((idx, j) => {
          if (re[j]) results[idx] = re[j]!;
        });
        missing = missing.filter((i) => results[i] === null);
      }
    }
    let singles = 0;
    batch.forEach((p, i) => {
      const r = results[i];
      if (r) {
        p.resolve({ ok: true, parsed: r, batch_size: size, attempts });
      } else if (singles < MAX_SINGLE_FALLBACK) {
        singles++;
        p.resolve({ ok: false, reason: BATCH_ITEM_MISSING, fallback: true, batch_size: size, attempts });
      } else {
        p.resolve({ ok: false, reason: BATCH_BAD_OUTPUT, fallback: false, batch_size: size, attempts });
      }
    });
  }
}
