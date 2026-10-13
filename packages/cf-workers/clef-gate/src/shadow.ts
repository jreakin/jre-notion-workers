import { clefDailyCapKey, parseDailyCap, resolveClefModeFromKv, tryConsumeDailyCall, utcDayKey } from "../../../clef-core/src/index.js";
import {
  buildEmailState,
  deriveShadowLabel,
  invokeEmailClef,
  isFlashSample,
  type ShadowLabel,
} from "./clef-email.js";
import type { Env } from "./env.js";
import { computeJoinFlags } from "./join.js";
import { resolveOverride } from "./overrides.js";
import { DISPOSITIONS, parseEmailShadowBody, type Disposition, type EmailShadowItem } from "./payload.js";

export const GATE = "clef_email";
export const GATE_VERSION = "email-shadow-v1";
export const STREAM = "clef_email_shadow";
export const RING_PREFIX = "clef_email_shadow_log:";
export const RING_TTL_SECONDS = 60 * 60 * 24 * 30;
export const EMAIL_CAP_DEFAULT = 1000;

/**
 * Log row. Built field-by-field from an allowlist — subject/snippet/existing_labels/from_domain are
 * intentionally absent. Never spread the item into this.
 */
export type EmailShadowLogEntry = {
  stream: typeof STREAM;
  event: "decision" | "outcome" | "rejected";
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
    flash_agree: null, latency_ms: null, error_reason: null, triage_disposition: null, triage_lane: null,
    triage_labels: [], triage_escalated: null, triage_rescued: false, agree: null, false_skip: null, false_wake: null,
  };
}

export function emitLog(entry: EmailShadowLogEntry): void {
  console.log(JSON.stringify(entry));
}

async function writeRing(env: Env, entry: EmailShadowLogEntry): Promise<void> {
  if (!entry.msg_id_hash) return;
  try {
    await env.CLEF_KV.put(`${RING_PREFIX}${entry.msg_id_hash}`, JSON.stringify(entry), {
      expirationTtl: RING_TTL_SECONDS,
    });
  } catch {
    // best effort
  }
}

async function bumpExcludedCounter(env: Env): Promise<void> {
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
  if (!entry.shadow_label || !entry.triage_disposition) return;
  const f = computeJoinFlags(entry.shadow_label, {
    disposition: entry.triage_disposition,
    escalated: entry.triage_escalated === true,
    rescued: entry.triage_rescued,
  });
  entry.agree = f.agree;
  entry.false_skip = f.false_skip;
  entry.false_wake = f.false_wake;
}

/** Process one POST /clef/email-shadow body. Returns the log entry (or null when excluded). */
export async function processEmailShadow(env: Env, rawBody: string): Promise<EmailShadowLogEntry | null> {
  const parsed = parseEmailShadowBody(rawBody);
  if (!parsed.ok) {
    if (parsed.excluded) {
      await bumpExcludedCounter(env);
      return null;
    }
    const e = blankEntry("rejected", "shadow");
    e.msg_id_hash = parsed.msg_id_hash ?? null;
    e.error_reason = parsed.reason;
    emitLog(e);
    return e;
  }
  const item = parsed.item;
  const mode = await resolveClefModeFromKv(env.CLEF_KV, env.CLEF_DEFAULT_MODE, GATE);
  const entry = blankEntry("decision", mode.modeLabel);
  applyTriage(entry, item);

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
      entry.shadow_label = "escalate";
    } else {
      const state = buildEmailState(item);
      entry.clef_called = true;
      const full = await invokeEmailClef(env.AI, env.AI_GATEWAY_ID, "full", state);
      entry.model = full.model;
      entry.latency_ms = full.latency_ms;
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
        entry.shadow_label = deriveShadowLabel(null);
      }
      if (isFlashSample(item.msg_id_hash)) {
        entry.flash_sample = true;
        const flashCap = await tryConsumeDailyCall(env.CLEF_KV, capKey, cap);
        if (flashCap.ok) {
          const flash = await invokeEmailClef(env.AI, env.AI_GATEWAY_ID, "flash", state);
          entry.flash_shadow_label = deriveShadowLabel(flash.ok ? flash.parsed : null);
          entry.flash_agree = full.ok && flash.ok ? entry.flash_shadow_label === entry.shadow_label : null;
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

/** POST /clef/email-shadow/outcome {msg_id_hash, disposition, escalated?, source?}. Last write wins. */
export async function processOutcome(env: Env, rawBody: string): Promise<EmailShadowLogEntry | null> {
  if (new TextEncoder().encode(rawBody).length > 1024) return null;
  let b: Record<string, unknown>;
  try {
    const j = JSON.parse(rawBody);
    if (!j || typeof j !== "object" || Array.isArray(j)) return null;
    b = j as Record<string, unknown>;
  } catch {
    return null;
  }
  const hash = typeof b.msg_id_hash === "string" && HASH_RE.test(b.msg_id_hash) ? b.msg_id_hash : null;
  const disposition = (DISPOSITIONS as readonly unknown[]).includes(b.disposition) ? (b.disposition as Disposition) : null;
  if (!hash || !disposition) {
    const e = blankEntry("rejected", "shadow");
    e.msg_id_hash = hash;
    e.error_reason = "invalid_outcome";
    emitLog(e);
    return e;
  }
  let prior: EmailShadowLogEntry | null = null;
  try {
    const raw = await env.CLEF_KV.get(`${RING_PREFIX}${hash}`);
    prior = raw ? (JSON.parse(raw) as EmailShadowLogEntry) : null;
  } catch {
    prior = null;
  }
  const entry: EmailShadowLogEntry = prior ? { ...blankEntry("outcome", prior.mode), ...pickLogFields(prior) } : blankEntry("outcome", "shadow");
  entry.event = "outcome";
  entry.ts = new Date().toISOString();
  entry.msg_id_hash = hash;
  entry.triage_disposition = disposition;
  entry.triage_escalated = b.escalated === true || disposition === "escalate_john" || disposition === "handoff_lane";
  entry.triage_rescued = b.source === "trainspam_rescue";
  if (!prior) entry.error_reason = "outcome_without_decision";
  finishFlags(entry);
  emitLog(entry);
  await writeRing(env, entry);
  return entry;
}

/** Re-pick only allowlisted keys from a stored row (defends against tampered KV values). */
function pickLogFields(src: EmailShadowLogEntry): Partial<EmailShadowLogEntry> {
  const keys = Object.keys(blankEntry("outcome", "shadow")) as (keyof EmailShadowLogEntry)[];
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (k in src) out[k] = (src as Record<string, unknown>)[k];
  }
  return out as Partial<EmailShadowLogEntry>;
}
