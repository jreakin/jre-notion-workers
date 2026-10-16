import {
  CLEF_FLASH_MODEL,
  CLEF_FLASH_MODEL_NAME,
  CLEF_FULL_MODEL,
  CLEF_FULL_MODEL_NAME,
  CLEF_STATE_MAX_CHARS,
  clefAnswers,
  clefErrorReason,
  readChoice,
  readConfidence,
  readNoul,
  readScore,
  runClefModel,
  CLEF_CALL_TIMEOUT_MS,
  type AiRunBinding,
} from "../../../clef-core/src/index.js";
import { LANES, type EmailShadowItem, type Lane } from "./payload.js";

export const EMAIL_QUESTIONS = {
  q_person: { type: "noul", instructions: "Is a real person writing to John personally and expecting a reply?" },
  q_money_sec: {
    type: "noul",
    instructions: "Is this about money due or failing, a credential/security event, or a lockout?",
  },
  q_lane: {
    type: "choice",
    instructions: "Which of John's lanes owns this email, if any?",
    criteria: {
      cos: "Chief of Staff: John's personal admin, scheduling, household, accounts",
      vep_desk: "VEP Desk: voter/election data products and their customers",
      qr_pm: "QR PM: Quorum Report publication, editors, subscribers",
      abstract_secretary: "Abstract Secretary: Abstract Data business, clients, contracts, invoices",
      none: "No lane needs it",
    },
  },
  q_bulk: { type: "noul", instructions: "Is this marketing, a newsletter, or spam?" },
  q_calendar: { type: "noul", instructions: "Is this a calendar or meeting change?" },
  q_urgency: {
    type: "score",
    instructions: "How urgent is this for John?",
    criteria: ["Not urgent", "This week", "Today", "Right now"],
  },
} as const;

/** Placeholder thresholds, fixed before shadow starts; calibrate on held-out days. */
export const EMAIL_THRESHOLDS = {
  ESCALATE_P_PERSON: 0.5,
  ESCALATE_P_MONEY_SEC: 0.3,
  ESCALATE_P_CALENDAR: 0.5,
  SKIP_P_BULK_MIN: 0.9,
  SKIP_P_PERSON_MAX: 0.05,
  SKIP_P_MONEY_SEC_MAX: 0.05,
} as const;

export const FLASH_SAMPLE_MOD = 10;

/**
 * `error`: Clef could not produce a verdict (gateway/AI error, timeout, bad output, unbound, cap store
 * unavailable) after retries + fallback. It is its own category: never graded as a wake or a skip.
 * (If a live mode is ever added, `error` must fail open to escalate.)
 */
export type ShadowLabel = "escalate" | "fyi" | "would_skip" | "error";

export type ParsedEmailRun = {
  p_person: number;
  p_money_sec: number;
  lane: Lane;
  p_bulk: number;
  p_calendar: number;
  urgency: number | null;
  confidence: number | null;
};

export function parseEmailClefResponse(raw: unknown): ParsedEmailRun | null {
  const a = clefAnswers(raw);
  if (!a) return null;
  const p_person = readNoul(a, "q_person");
  const p_money_sec = readNoul(a, "q_money_sec");
  const lane = readChoice(a, "q_lane", LANES);
  const p_bulk = readNoul(a, "q_bulk");
  const p_calendar = readNoul(a, "q_calendar");
  const confidence = readConfidence(a, "q_lane");
  if (p_person === null || p_money_sec === null || lane === null || p_bulk === null || p_calendar === null) {
    return null;
  }
  if (confidence === "bad") return null;
  // urgency is log-only: a bad/missing score does not invalidate the run.
  return { p_person, p_money_sec, lane, p_bulk, p_calendar, urgency: readScore(a, "q_urgency", 3), confidence };
}

export function deriveShadowLabel(p: ParsedEmailRun | null): ShadowLabel {
  if (!p) return "escalate"; // uncertain / error / timeout / bad output
  const t = EMAIL_THRESHOLDS;
  if (
    p.p_person >= t.ESCALATE_P_PERSON ||
    p.p_money_sec >= t.ESCALATE_P_MONEY_SEC ||
    p.p_calendar >= t.ESCALATE_P_CALENDAR ||
    p.lane !== "none"
  ) {
    return "escalate";
  }
  if (p.p_bulk >= t.SKIP_P_BULK_MIN && p.p_person <= t.SKIP_P_PERSON_MAX && p.p_money_sec <= t.SKIP_P_MONEY_SEC_MAX) {
    return "would_skip";
  }
  return "fyi";
}

/** Deterministic 10% flash side-by-side sample: hash mod 10 = 0. */
export function isFlashSample(msgIdHash: string): boolean {
  const tail = msgIdHash.slice(-8);
  const n = Number.parseInt(tail, 16);
  return Number.isFinite(n) && n % FLASH_SAMPLE_MOD === 0;
}

/** Compact state for Clef. Contains masked subject/snippet — transient, never logged. */
export function buildEmailState(item: EmailShadowItem): string {
  const meta = [
    `mailbox: ${item.mailbox}`,
    `from_domain: ${item.from_domain ?? "unknown"}`,
    `from_kind: ${item.from_kind}`,
    `to_john_direct: ${item.to_john_direct}`,
    `cc_count: ${item.cc_count}`,
    `list_unsubscribe: ${item.list_unsubscribe}`,
    `has_attachment: ${item.has_attachment}`,
    `gmail_category: ${item.gmail_category ?? "unknown"}`,
    `labels: ${item.existing_labels.join(", ") || "none"}`,
    `subject: ${item.subject}`,
  ].join("\n");
  const head = `${meta}\nsnippet: `;
  const room = Math.max(0, CLEF_STATE_MAX_CHARS - head.length);
  return (head + item.snippet.slice(0, room)).slice(0, CLEF_STATE_MAX_CHARS);
}

type CallMeta = {
  latency_ms: number;
  model: string;
  attempts: number;
  fallback: boolean;
  /** Why retries/fallback stopped early (clef_budget_exhausted, clef_daily_cap, …); null otherwise. */
  stopped?: string | null;
};
export type EmailClefCall = ({ ok: true; parsed: ParsedEmailRun } | { ok: false; reason: string }) & CallMeta;

/** Transient failures worth a retry: AI Gateway / Workers AI errors and timeouts (not config or bad output). */
export function isTransientClefReason(reason: string): boolean {
  return reason === "clef_timeout" || reason.startsWith("clef_error:");
}

/**
 * The `clef-shadow-gate` AI Gateway's own rate limit (60 req / 60 s sliding) answers 429, surfaced by the
 * binding as an AiGatewayError. Morning inbox bursts (120+ emails in one minute) hit it: every 429 was
 * logged as `clef_error:AiGatewayError`. Logged as its own reason so the grader can tell it apart.
 */
export const CLEF_RATE_LIMITED_REASON = "clef_error:RateLimited";

/** True when the error is a 429 / rate limit (checks status/code fields and the message; never logs it). */
export function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: unknown; code?: unknown; message?: unknown };
  if (e.status === 429 || e.code === 429 || e.code === "429") return true;
  const msg = typeof e.message === "string" ? e.message : "";
  return /\b429\b|rate[ _-]?limit|too many requests/i.test(msg);
}

/** Backoff before retry n (1-based) of the same model. Small: this runs in waitUntil after the 202. */
export const CLEF_RETRY_BACKOFF_MS = [250, 750] as const;
/**
 * Backoff after a gateway 429. Sub-second retries land in the same 60 s sliding window and only burn more of
 * the limit (and cap units), so wait seconds, with ±30 % jitter so a burst of emails does not retry in lockstep.
 */
export const CLEF_RATE_LIMIT_BACKOFF_MS = [4_000, 9_000] as const;
export const CLEF_RATE_LIMIT_JITTER = 0.3;
/**
 * Total wall-clock budget for ALL Clef work of one email (retries, fallback, flash side-by-side),
 * under the 30 s waitUntil limit (headroom for the KV row rewrite). Each call's timeout is clipped to what is left.
 */
export const CLEF_COMPLETION_BUDGET_MS = 22_000;
/** Don't start a call with less than this left (it would just time out). */
export const CLEF_MIN_CALL_MS = 500;

export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export type InvokeOpts = {
  /** Try clef-flash once when the full model still fails transiently. */
  fallbackToFlash?: boolean;
  sleep?: Sleep;
  backoffMs?: readonly number[];
  /** Backoff used after a rate-limit failure; default CLEF_RATE_LIMIT_BACKOFF_MS. */
  rateLimitBackoffMs?: readonly number[];
  /** Random source in [0, 1) for the rate-limit jitter; default Math.random. */
  random?: () => number;
  /** Clock (ms) for the budget; default Date.now. */
  now?: () => number;
  /** Absolute deadline (same clock as `now`); default now + CLEF_COMPLETION_BUDGET_MS. */
  deadline?: number;
  /**
   * Called before every call AFTER the first (retries + fallback) to take one more daily-cap unit,
   * so the cap counts real model calls. Returns a reason to stop (e.g. "clef_daily_cap") or null.
   */
  consumeExtra?: () => Promise<string | null>;
};

async function invokeOnce(
  ai: AiRunBinding,
  gatewayId: string,
  variant: "full" | "flash",
  state: string,
  timeoutMs: number,
): Promise<{ ok: true; parsed: ParsedEmailRun } | { ok: false; reason: string }> {
  const slug = variant === "full" ? CLEF_FULL_MODEL : CLEF_FLASH_MODEL;
  const name = variant === "full" ? CLEF_FULL_MODEL_NAME : CLEF_FLASH_MODEL_NAME;
  try {
    // Email state carries masked subject/snippet: never let AI Gateway log or cache it.
    const gateway = { id: gatewayId, collectLog: false, skipCache: true };
    const raw = await runClefModel(ai, gateway, slug, name, state, EMAIL_QUESTIONS, timeoutMs);
    const parsed = parseEmailClefResponse(raw);
    return parsed ? { ok: true, parsed } : { ok: false, reason: "clef_bad_output" };
  } catch (err) {
    return { ok: false, reason: isRateLimitError(err) ? CLEF_RATE_LIMITED_REASON : clefErrorReason(err) };
  }
}

/**
 * Call Clef `variant`. On a transient failure retry the same model with backoff; when `fallbackToFlash`
 * and the full model still fails transiently, try clef-flash once. Everything stays inside `deadline`
 * (per-call timeout clipped to the time left; no call starts with < CLEF_MIN_CALL_MS left →
 * `clef_budget_exhausted`). Every extra call takes a cap unit via `consumeExtra`.
 * `reason` on failure is the LAST stop reason; `attempts` counts every model call made.
 */
export async function invokeEmailClef(
  ai: AiRunBinding | undefined,
  gatewayId: string | undefined,
  variant: "full" | "flash",
  state: string,
  opts: InvokeOpts = {},
): Promise<EmailClefCall> {
  const name = variant === "full" ? CLEF_FULL_MODEL_NAME : CLEF_FLASH_MODEL_NAME;
  const now = opts.now ?? Date.now;
  const started = now();
  const deadline = opts.deadline ?? started + CLEF_COMPLETION_BUDGET_MS;
  if (!ai) return { ok: false, reason: "clef_ai_unbound", latency_ms: 0, model: name, attempts: 0, fallback: false };
  // Fail closed: without the gateway there is no rate limit and no gateway no-log guarantee.
  if (!gatewayId?.trim()) {
    return { ok: false, reason: "clef_gateway_unset", latency_ms: 0, model: name, attempts: 0, fallback: false };
  }
  const gw = gatewayId.trim();
  const sleep = opts.sleep ?? realSleep;
  const backoff = opts.backoffMs ?? CLEF_RETRY_BACKOFF_MS;
  let attempts = 0;
  let model = name;
  let fallback = false;
  let stopped: string | null = null;
  let last: { ok: true; parsed: ParsedEmailRun } | { ok: false; reason: string } = {
    ok: false,
    reason: "clef_budget_exhausted",
  };

  /** One call if budget (and, for extra calls, cap) allows; false = stop. */
  const tryCall = async (v: "full" | "flash", waitMs: number): Promise<boolean> => {
    if (attempts > 0) {
      // Stopping early keeps the last real failure reason (e.g. clef_error:AiGatewayError) on the row.
      if (deadline - now() - waitMs < CLEF_MIN_CALL_MS) {
        stopped = "clef_budget_exhausted";
        return false;
      }
      const stop = opts.consumeExtra ? await opts.consumeExtra() : null;
      if (stop) {
        stopped = stop;
        return false;
      }
      if (waitMs > 0) await sleep(waitMs);
    }
    const left = deadline - now();
    if (left < CLEF_MIN_CALL_MS) {
      if (attempts === 0) last = { ok: false, reason: "clef_budget_exhausted" };
      stopped = "clef_budget_exhausted";
      return false;
    }
    attempts++;
    model = v === "full" ? CLEF_FULL_MODEL_NAME : CLEF_FLASH_MODEL_NAME;
    last = await invokeOnce(ai, gw, v, state, Math.min(CLEF_CALL_TIMEOUT_MS, left));
    return true;
  };

  const failedTransient = () => {
    const r = last as { ok: boolean; reason?: string };
    return !r.ok && isTransientClefReason(r.reason ?? "");
  };
  const rlBackoff = opts.rateLimitBackoffMs ?? CLEF_RATE_LIMIT_BACKOFF_MS;
  const random = opts.random ?? Math.random;
  const rateLimited = () => {
    const r = last as { ok: boolean; reason?: string };
    return !r.ok && r.reason === CLEF_RATE_LIMITED_REASON;
  };
  const retries = Math.max(backoff.length, rlBackoff.length);
  for (let i = 0; i <= retries; i++) {
    let waitMs = 0;
    if (i > 0) {
      if (rateLimited()) {
        const base = rlBackoff[i - 1];
        if (base === undefined) break;
        waitMs = Math.round(base * (1 - CLEF_RATE_LIMIT_JITTER + 2 * CLEF_RATE_LIMIT_JITTER * random()));
      } else {
        const base = backoff[i - 1];
        if (base === undefined) break;
        waitMs = base;
      }
    }
    if (!(await tryCall(variant, waitMs))) break;
    if (!failedTransient()) break;
  }
  // clef-flash goes through the same gateway and the same rate limit: no fallback on a 429.
  if (
    failedTransient() &&
    !rateLimited() &&
    variant === "full" &&
    opts.fallbackToFlash &&
    isTransientClefReason(last.reason)
  ) {
    fallback = await tryCall("flash", 0);
  }
  const latency_ms = now() - started;
  // `last` is reassigned inside tryCall; re-widen it (TS narrows the closure-mutated let to its initializer).
  const res = last as { ok: true; parsed: ParsedEmailRun } | { ok: false; reason: string };
  if (res.ok) return { ok: true, parsed: res.parsed, latency_ms, model, attempts, fallback, stopped };
  return { ok: false, reason: res.reason, latency_ms, model, attempts, fallback, stopped };
}

/**
 * Guard for any future live mode: a label that would act on mail. `error` (no verdict) fails open to
 * `escalate`; nothing else changes. Shadow grading keeps `error` as its own category.
 */
export function liveActionLabel(label: ShadowLabel): Exclude<ShadowLabel, "error"> {
  return label === "error" ? "escalate" : label;
}
