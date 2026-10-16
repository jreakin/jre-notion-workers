import { clefDailyCapKey, parseDailyCap, resolveClefModeFromKv, tryConsumeDailyCall, utcDayKey } from "../../../clef-core/src/index.js";
import {
  buildEmailState,
  deriveShadowLabel,
  invokeEmailClef,
  isFlashSample,
  type ShadowLabel,
  type Sleep,
  CLEF_COMPLETION_BUDGET_MS,
  CLEF_RATE_LIMITED_REASON,
} from "./clef-email.js";
import { CLEF_CALL_TIMEOUT_MS } from "../../../clef-core/src/index.js";
import type { Env } from "./env.js";
import { computeJoinFlags } from "./join.js";
import { resolveOverride } from "./overrides.js";
import { DISPOSITIONS, parseEmailShadowBody, type Disposition, type EmailShadowItem } from "./payload.js";

export const GATE = "clef_email";
export const GATE_VERSION = "email-shadow-v1";
export const STREAM = "clef_email_shadow";
export const RING_PREFIX = "clef_email_shadow_log:";
/** Outcomes live under their own key so a decision/verdict write can never overwrite one (and vice versa). */
export const OUTCOME_PREFIX = "clef_email_shadow_outcome:";
export const RING_TTL_SECONDS = 60 * 60 * 24 * 30;
export const EMAIL_CAP_DEFAULT = 1000;

/**
 * Log row. Built field-by-field from an allowlist — subject/snippet/existing_labels/from_domain are
 * intentionally absent. Never spread the item into this.
 */
export type EmailShadowLogEntry = {
  stream: typeof STREAM;
  event: "decision" | "outcome" | "rejected" | "excluded" | "store_failed";
  gate: typeof GATE;
  gate_version: string;
  mode: string;
  ts: string;
  run_id: string | null;
  mailbox: string | null;
  msg_id_hash: string | null;
  thread_id_hash: string | null;
  override: string | null;
  clef_called: boolean;
  model: string | null;
  flash_sample: boolean;
  p_person: number | null;
  p_money_sec: number | null;
  lane: string | null;
  p_bulk: number | null;
  p_calendar: number | null;
  urgency: number | null;
  confidence: number | null;
  shadow_label: ShadowLabel | null;
  flash_shadow_label: ShadowLabel | null;
  flash_agree: boolean | null;
  latency_ms: number | null;
  /** Model calls made for the verdict (retries + fallback included); null when Clef was not called. */
  clef_attempts: number | null;
  /** True when the full model failed transiently and a clef-flash fallback call was made. */
  clef_fallback: boolean;
  /** Why retries/fallback stopped early (clef_budget_exhausted / clef_daily_cap / …); null otherwise. */
  clef_stopped: string | null;
  error_reason: string | null;
  triage_disposition: Disposition | null;
  triage_lane: string | null;
  triage_labels: string[];
  triage_escalated: boolean | null;
  triage_rescued: boolean;
  agree: boolean | null;
  false_skip: boolean | null;
  false_wake: boolean | null;
};

function blankEntry(event: EmailShadowLogEntry["event"], mode: string): EmailShadowLogEntry {
  return {
    stream: STREAM, event, gate: GATE, gate_version: GATE_VERSION, mode, ts: new Date().toISOString(),
    run_id: null, mailbox: null, msg_id_hash: null, thread_id_hash: null, override: null, clef_called: false,
    model: null, flash_sample: false, p_person: null, p_money_sec: null, lane: null, p_bulk: null,
    p_calendar: null, urgency: null, confidence: null, shadow_label: null, flash_shadow_label: null,
    flash_agree: null, latency_ms: null, clef_attempts: null, clef_fallback: false, clef_stopped: null, error_reason: null, triage_disposition: null, triage_lane: null,
    triage_labels: [], triage_escalated: null, triage_rescued: false, agree: null, false_skip: null, false_wake: null,
  };
}

export function emitLog(entry: EmailShadowLogEntry): void {
  console.log(JSON.stringify(entry));
}

/** Writes the row; throws on KV failure so callers can answer 5xx / log honestly. */
async function writeRingStrict(env: Env, entry: EmailShadowLogEntry, prefix = RING_PREFIX): Promise<void> {
  if (!entry.msg_id_hash) throw new Error("missing_msg_id_hash");
  await env.CLEF_KV.put(`${prefix}${entry.msg_id_hash}`, JSON.stringify(entry), {
    expirationTtl: RING_TTL_SECONDS,
  });
}

/** Masked failure line: hash + reason only, never subject/snippet/addresses. */
export function emitFailure(
  event: "store_failed" | "excluded" | "rejected",
  reason: string,
  msgIdHash: string | null,
  mode = "n/a",
): void {
  const e = blankEntry(event, mode);
  e.msg_id_hash = msgIdHash;
  e.error_reason = reason;
  emitLog(e);
}

async function writeRing(env: Env, entry: EmailShadowLogEntry): Promise<boolean> {
  try {
    await writeRingStrict(env, entry);
    return true;
  } catch {
    emitFailure("store_failed", "kv_put_failed", entry.msg_id_hash, entry.mode);
    return false;
  }
}

async function bumpExcludedCounter(env: Env): Promise<void> {
  emitFailure("excluded", "excluded_grokbot", null);
  const key = `clef_email:excluded:${utcDayKey()}`;
  try {
    const n = Number.parseInt((await env.CLEF_KV.get(key)) ?? "0", 10);
    await env.CLEF_KV.put(key, String((Number.isFinite(n) ? n : 0) + 1), { expirationTtl: RING_TTL_SECONDS });
  } catch {
    // best effort
  }
}

function applyTriage(entry: EmailShadowLogEntry, item: EmailShadowItem): void {
  entry.run_id = item.run_id;
  entry.mailbox = item.mailbox;
  entry.msg_id_hash = item.msg_id_hash;
  entry.thread_id_hash = item.thread_id_hash;
  entry.triage_disposition = item.triage.disposition;
  entry.triage_lane = item.triage.lane;
  entry.triage_labels = item.triage.labels_applied;
  entry.triage_escalated = item.triage.escalated;
}

function finishFlags(entry: EmailShadowLogEntry): void {
  // `error` verdicts are their own category: not a wake, not a skip, never agree/false_*.
  if (!entry.shadow_label || entry.shadow_label === "error" || !entry.triage_disposition) return;
  const f = computeJoinFlags(entry.shadow_label, {
    disposition: entry.triage_disposition,
    escalated: entry.triage_escalated === true,
    rescued: entry.triage_rescued,
  });
  entry.agree = f.agree;
  entry.false_skip = f.false_skip;
  entry.false_wake = f.false_wake;
}

export type Admission =
  | { status: 200; kind: "excluded" }
  | { status: 400; kind: "rejected"; entry: EmailShadowLogEntry }
  | { status: 500; kind: "store_failed"; entry: EmailShadowLogEntry }
  | { status: 202; kind: "duplicate" }
  | { status: 202; kind: "stored"; entry: EmailShadowLogEntry; item: EmailShadowItem; mode: ClefModeLike };

type ClefModeLike = Awaited<ReturnType<typeof resolveClefModeFromKv>>;

export const PENDING_REASON = "clef_pending";

/**
 * Synchronous half of POST /clef/email-shadow: parse, validate, and durably store a pending
 * decision row (triage truth + hashes, no Clef verdict yet). Only a "stored" admission may
 * be answered with 202.
 */
export async function admitEmailShadow(env: Env, rawBody: string): Promise<Admission> {
  const parsed = parseEmailShadowBody(rawBody);
  if (!parsed.ok) {
    if (parsed.excluded) {
      await bumpExcludedCounter(env);
      return { status: 200, kind: "excluded" };
    }
    const e = blankEntry("rejected", "n/a");
    e.msg_id_hash = parsed.msg_id_hash ?? null;
    e.error_reason = parsed.reason;
    emitLog(e);
    return { status: 400, kind: "rejected", entry: e };
  }
  const item = parsed.item;
  // Idempotent resend: a finished row is never rewritten and Clef is not re-run.
  // (A still-pending row is re-admitted so a dead background step can recover. KV reads can be
  // stale for ~60 s across PoPs, so a near-simultaneous duplicate may still re-run Clef once.)
  const existing = await env.CLEF_KV.get(`${RING_PREFIX}${item.msg_id_hash}`);
  if (existing !== null) {
    let pending = true;
    try {
      pending = (JSON.parse(existing) as Partial<EmailShadowLogEntry>).error_reason === PENDING_REASON;
    } catch {
      pending = true;
    }
    if (!pending) return { status: 202, kind: "duplicate" };
  }
  const mode = await resolveClefModeFromKv(env.CLEF_KV, env.CLEF_DEFAULT_MODE, GATE);
  const entry = blankEntry("decision", mode.modeLabel);
  applyTriage(entry, item);
  entry.error_reason = PENDING_REASON;
  try {
    await writeRingStrict(env, entry);
  } catch {
    emitFailure("store_failed", "kv_put_failed", entry.msg_id_hash, entry.mode);
    return { status: 500, kind: "store_failed", entry };
  }
  return { status: 202, kind: "stored", entry: { ...entry, error_reason: null }, item, mode };
}

/** Async half: Clef call(s), then overwrite the pending row. Preserves a racing outcome's triage truth. */
/** Test seams for the retry path (defaults: real setTimeout, CLEF_RETRY_BACKOFF_MS). */
export type CompletionDeps = {
  sleep?: Sleep;
  backoffMs?: readonly number[];
  rateLimitBackoffMs?: readonly number[];
  random?: () => number;
  /** Clock + total budget (default Date.now / CLEF_COMPLETION_BUDGET_MS). */
  now?: () => number;
  budgetMs?: number;
};

export async function completeEmailShadow(
  env: Env,
  item: EmailShadowItem,
  entry: EmailShadowLogEntry,
  mode: ClefModeLike,
  deps: CompletionDeps = {},
): Promise<EmailShadowLogEntry> {
  try {
    return await completeInner(env, item, entry, mode, deps);
  } catch {
    emitFailure("store_failed", "clef_completion_failed", entry.msg_id_hash, entry.mode);
    return entry;
  }
}

/** Process one POST /clef/email-shadow body end-to-end. Returns the log entry (or null when excluded). */
export async function processEmailShadow(
  env: Env,
  rawBody: string,
  deps: CompletionDeps = {},
): Promise<EmailShadowLogEntry | null> {
  const a = await admitEmailShadow(env, rawBody);
  if (a.kind === "excluded" || a.kind === "duplicate") return null;
  if (a.kind !== "stored") return a.entry;
  return completeEmailShadow(env, a.item, a.entry, a.mode, deps);
}

async function completeInner(
  env: Env,
  item: EmailShadowItem,
  entry: EmailShadowLogEntry,
  mode: ClefModeLike,
  deps: CompletionDeps,
): Promise<EmailShadowLogEntry> {
  const override = resolveOverride(item);
  if (override) {
    entry.override = override;
    entry.shadow_label = "escalate";
  } else if (!mode.allowClefCall) {
    entry.error_reason = mode.reason;
    entry.shadow_label = "escalate";
  } else {
    const cap = parseDailyCap(env.CLEF_EMAIL_DAILY_CALL_CAP, EMAIL_CAP_DEFAULT);
    const capKey = clefDailyCapKey(GATE);
    const capRes = await tryConsumeDailyCall(env.CLEF_KV, capKey, cap);
    if (!capRes.ok) {
      entry.error_reason = capRes.reason;
      // Cap reached is policy (escalate); an unreadable/invalid cap store is an infra error.
      entry.shadow_label = capRes.reason === "clef_daily_cap" ? "escalate" : "error";
    } else {
      const state = buildEmailState(item);
      entry.clef_called = true;
      const now = deps.now ?? Date.now;
      const deadline = now() + (deps.budgetMs ?? CLEF_COMPLETION_BUDGET_MS);
      // Each retry / fallback call takes one more daily-cap unit (the cap counts real model calls).
      const consumeExtra = async (): Promise<string | null> => {
        const r = await tryConsumeDailyCall(env.CLEF_KV, capKey, cap);
        return r.ok ? null : r.reason;
      };
      const full = await invokeEmailClef(env.AI, env.AI_GATEWAY_ID, "full", state, {
        fallbackToFlash: true,
        sleep: deps.sleep,
        backoffMs: deps.backoffMs,
        rateLimitBackoffMs: deps.rateLimitBackoffMs,
        random: deps.random,
        now,
        deadline,
        consumeExtra,
      });
      entry.model = full.model;
      entry.latency_ms = full.latency_ms;
      entry.clef_attempts = full.attempts;
      entry.clef_fallback = full.fallback;
      entry.clef_stopped = full.stopped ?? null;
      if (full.ok) {
        Object.assign(entry, {
          p_person: full.parsed.p_person,
          p_money_sec: full.parsed.p_money_sec,
          lane: full.parsed.lane,
          p_bulk: full.parsed.p_bulk,
          p_calendar: full.parsed.p_calendar,
          urgency: full.parsed.urgency,
          confidence: full.parsed.confidence,
        });
        entry.shadow_label = deriveShadowLabel(full.parsed);
      } else {
        entry.error_reason = full.reason;
        entry.shadow_label = "error";
      }
      // Side-by-side flash: single call, no retries, only with a full call's time left in the budget.
      // Skipped when the verdict already came from flash (it would compare flash with itself).
      // Also skipped after a gateway 429: the extra call would only add to the rate-limited burst.
      if (isFlashSample(item.msg_id_hash) && !full.fallback && !(!full.ok && full.reason === CLEF_RATE_LIMITED_REASON)) {
        entry.flash_sample = true;
        if (deadline - now() >= CLEF_CALL_TIMEOUT_MS) {
          const flashCap = await tryConsumeDailyCall(env.CLEF_KV, capKey, cap);
          if (flashCap.ok) {
            const flash = await invokeEmailClef(env.AI, env.AI_GATEWAY_ID, "flash", state, {
              backoffMs: [],
              rateLimitBackoffMs: [],
              now,
              deadline,
            });
            entry.flash_shadow_label = flash.ok ? deriveShadowLabel(flash.parsed) : "error";
            entry.flash_agree = full.ok && flash.ok ? entry.flash_shadow_label === entry.shadow_label : null;
          }
        }
      }
    }
  }
  finishFlags(entry);
  emitLog(entry);
  await writeRing(env, entry);
  return entry;
}

const HASH_RE = /^[a-f0-9]{16,128}$/;

export type OutcomeResult = { status: 202 | 400 | 413 | 500; entry: EmailShadowLogEntry | null };

function rejectOutcome(reason: string, hash: string | null = null): OutcomeResult {
  const e = blankEntry("rejected", "n/a");
  e.msg_id_hash = hash;
  e.error_reason = reason;
  emitLog(e);
  return { status: reason === "outcome_too_large" ? 413 : 400, entry: e };
}

/** POST /clef/email-shadow/outcome {msg_id_hash, disposition, escalated?, source?}. Last write wins. */
export async function processOutcome(env: Env, rawBody: string): Promise<EmailShadowLogEntry | null> {
  return (await handleOutcome(env, rawBody)).entry;
}

/** Fully inline (KV read + write); only a stored row is answered with 202. */
export async function handleOutcome(env: Env, rawBody: string): Promise<OutcomeResult> {
  if (new TextEncoder().encode(rawBody).length > 1024) return rejectOutcome("outcome_too_large");
  let b: Record<string, unknown>;
  try {
    const j = JSON.parse(rawBody);
    if (!j || typeof j !== "object" || Array.isArray(j)) return rejectOutcome("invalid_outcome");
    b = j as Record<string, unknown>;
  } catch {
    return rejectOutcome("invalid_json");
  }
  const hash = typeof b.msg_id_hash === "string" && HASH_RE.test(b.msg_id_hash) ? b.msg_id_hash : null;
  const disposition = (DISPOSITIONS as readonly unknown[]).includes(b.disposition) ? (b.disposition as Disposition) : null;
  if (!hash || !disposition) return rejectOutcome("invalid_outcome", hash);
  let prior: EmailShadowLogEntry | null = null;
  try {
    const raw = await env.CLEF_KV.get(`${RING_PREFIX}${hash}`);
    prior = raw ? (JSON.parse(raw) as EmailShadowLogEntry) : null;
  } catch {
    prior = null;
  }
  // Outcome row = triage truth + identifiers only. It deliberately carries NO verdict and NO
  // agree/false_skip/false_wake flags (they would be stale if the decision was still pending).
  // Grade only via gradeJoined()/gradeFromKv().
  const entry = blankEntry("outcome", prior?.mode ?? "n/a");
  entry.msg_id_hash = hash;
  entry.run_id = prior?.run_id ?? null;
  entry.mailbox = prior?.mailbox ?? null;
  entry.thread_id_hash = prior?.thread_id_hash ?? null;
  entry.triage_disposition = disposition;
  entry.triage_escalated = b.escalated === true || disposition === "escalate_john" || disposition === "handoff_lane";
  entry.triage_rescued = b.source === "trainspam_rescue";
  if (!prior) entry.error_reason = "outcome_without_decision";
  try {
    await writeRingStrict(env, entry, OUTCOME_PREFIX);
  } catch {
    emitFailure("store_failed", "kv_put_failed", hash, entry.mode);
    return { status: 500, entry: { ...entry, error_reason: "kv_put_failed" } };
  }
  emitLog(entry);
  return { status: 202, entry };
}


/**
 * Grading join: decision row (`clef_email_shadow_log:<hash>`) + optional outcome row
 * (`clef_email_shadow_outcome:<hash>`). The outcome's triage truth wins; flags are recomputed
 * from the decision's verdict. Returns null while the verdict is still pending.
 */
export function gradeJoined(
  decision: EmailShadowLogEntry,
  outcome: EmailShadowLogEntry | null,
): EmailShadowLogEntry | null {
  if (!decision.shadow_label || decision.error_reason === PENDING_REASON) return null;
  const g: EmailShadowLogEntry = { ...decision };
  if (outcome?.triage_disposition) {
    g.event = "outcome";
    g.triage_disposition = outcome.triage_disposition;
    g.triage_escalated = outcome.triage_escalated === true;
    g.triage_rescued = outcome.triage_rescued === true;
  }
  g.agree = g.false_skip = g.false_wake = null;
  finishFlags(g);
  return g;
}

function parseRow(raw: string | null): EmailShadowLogEntry | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as EmailShadowLogEntry) : null;
  } catch {
    return null;
  }
}

/**
 * The single grading entry point for any consumer (14-day zero-false-skip window, Gate Log, etc.):
 * reads both keys for a hash and joins them via gradeJoined. Never read flags off an outcome row.
 */
export async function gradeFromKv(kv: KVNamespace, msgIdHash: string): Promise<EmailShadowLogEntry | null> {
  const [d, o] = await Promise.all([
    kv.get(`${RING_PREFIX}${msgIdHash}`),
    kv.get(`${OUTCOME_PREFIX}${msgIdHash}`),
  ]);
  const decision = parseRow(d);
  return decision ? gradeJoined(decision, parseRow(o)) : null;
}
