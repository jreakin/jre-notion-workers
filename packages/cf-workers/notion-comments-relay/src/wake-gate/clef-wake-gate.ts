import { invokeClefFlash, invokeClefFull, type ParsedClefRun } from "./clef-ai.js";
import { tryConsumeClefCall } from "./clef-daily-cap.js";
import { resolveClefMode } from "./clef-mode.js";
import { clefHardOverrideReason } from "./clef-overrides.js";
import { buildClefStateString, mapClefSource } from "./clef-state.js";
import { CLEF_FULL_SAMPLE_PERCENT } from "./clef-thresholds.js";
import type { Env } from "../env.js";
import { idInNotionIdSet, normalizeNotionUuid } from "./notion-ids.js";
import type {
  ClefDecisionOutcome,
  ClefShadowLogEntry,
  GateEventContext,
  WakeDecisionOutcome,
  WakeGateDecision,
} from "./gate-event-types.js";
import { enqueueGateLogRow } from "../gate-log-ring.js";
import { runRuleSkipClefShadow } from "./clef-rule-skip-shadow.js";

const DUPLICATE_WINDOW_MS = 60_000;

/** Default window for the pre-Clef same-item dedupe (CLEF_ITEM_DEDUPE_WINDOW_S). */
export const ITEM_DEDUPE_WINDOW_S_DEFAULT = 600;
const ITEM_DEDUPE_MAX_KEYS = 5000;
/** Isolate-local (no KV write per event). Key: item id + event type. */
const itemDedupe = new Map<string, { firstTs: number; count: number }>();

export function readItemDedupeWindowMs(env: Env): number {
  const raw = env.CLEF_ITEM_DEDUPE_WINDOW_S?.trim();
  const n = raw ? Number.parseInt(raw, 10) : ITEM_DEDUPE_WINDOW_S_DEFAULT;
  return Number.isFinite(n) && n >= 0 ? n * 1000 : ITEM_DEDUPE_WINDOW_S_DEFAULT * 1000;
}

/**
 * Dedupe key, or null (never dedupe):
 * - comment.updated → never (an edit can add content);
 * - other comment.* → the comment's own id + event type (a different comment on the same page is never a repeat);
 * - page events → page id + event type, ONLY when SUBMITTED_PROPERTY_IDS and NEEDS_JOHN_PROPERTY_IDS are
 *   both configured (until then a Needs John flip could not be told apart, so page dedupe stays off).
 */
export function itemDedupeKey(ctx: GateEventContext, notionType: string | null): string | null {
  if (ctx.isCommentEvent) {
    // Edits can add real content (an ask, a decision): comment.updated is never deduped.
    if (notionType === "comment.updated") return null;
    return ctx.commentId ? `comment:${normalizeNotionUuid(ctx.commentId)}|${notionType ?? ""}` : null;
  }
  const idsConfigured = ctx.submittedPropertyIds.size > 0 && (ctx.needsJohnPropertyIds?.size ?? 0) > 0;
  if (!idsConfigured || !ctx.pageId) return null;
  return `page:${normalizeNotionUuid(ctx.pageId)}|${notionType ?? ""}`;
}

/**
 * Same dedupe key seen within the window (counted from the FIRST event, so a steady stream
 * resurfaces once per window). Returns the 1-based count inside the window; 1 = first (not a repeat).
 * Unknown items are never deduped.
 */
export function noteItemEvent(env: Env, key: string | null, now = Date.now()): number {
  const windowMs = readItemDedupeWindowMs(env);
  if (windowMs === 0 || !key) return 1;
  const prev = itemDedupe.get(key);
  if (prev && now - prev.firstTs >= 0 && now - prev.firstTs < windowMs) {
    prev.count += 1;
    return prev.count;
  }
  if (itemDedupe.size >= ITEM_DEDUPE_MAX_KEYS) {
    for (const [k, v] of itemDedupe) {
      if (now - v.firstTs >= windowMs) itemDedupe.delete(k);
    }
    if (itemDedupe.size >= ITEM_DEDUPE_MAX_KEYS) itemDedupe.clear();
  }
  itemDedupe.set(key, { firstTs: now, count: 1 });
  return 1;
}

export function resetItemDedupeForTests(): void {
  itemDedupe.clear();
}

const pageEventCounts = new Map<string, { ts: number; count: number }>();

/**
 * Wakes that only mean "this event is not mine" (no rule claimed it). They never outvote another
 * gate's explicit skip. Deliberately narrow: unset config / unreadable page / errors still wake.
 */
export const PASS_THROUGH_WAKE_REASONS: ReadonlySet<string> = new Set(["not_fleet_locks"]);

export function aggregateRuleDecision(decisions: WakeGateDecision[]): WakeDecisionOutcome {
  const hasSkip = decisions.some((d) => d.decision === "would_skip");
  const claimingWake = decisions.some(
    (d) => d.decision === "would_wake" && !(hasSkip && PASS_THROUGH_WAKE_REASONS.has(d.reason)),
  );
  if (claimingWake) {
    return "would_wake";
  }
  if (hasSkip && decisions.every((d) => d.decision !== "would_log_only")) {
    return "would_skip";
  }
  if (decisions.every((d) => d.decision === "would_skip")) {
    return "would_skip";
  }
  return "would_log_only";
}

export function ruleDecisionToClefDecision(rule: WakeDecisionOutcome): ClefDecisionOutcome {
  if (rule === "would_skip") {
    return "would_skip";
  }
  if (rule === "would_log_only") {
    return "would_log_only";
  }
  return "would_wake";
}

export function resolveOpaqueItemId(
  ctx: GateEventContext,
  parsed: Record<string, unknown>,
): string {
  if (ctx.pageId) {
    return ctx.pageId;
  }
  const entity = parsed.entity;
  if (entity && typeof entity === "object" && typeof (entity as { id?: unknown }).id === "string") {
    return (entity as { id: string }).id;
  }
  return "unknown";
}

export function shouldRunClefFullSample(itemId: string): boolean {
  if (itemId === "unknown" || itemId.trim() === "") {
    return false;
  }
  const normalized = normalizeNotionUuid(itemId);
  let hash = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
  }
  return hash % 100 < CLEF_FULL_SAMPLE_PERCENT;
}

function bumpPageEventCount(_env: Env, pageId: string): number {
  const now = Date.now();
  const prev = pageEventCounts.get(pageId);
  let count = 1;
  if (prev && now - prev.ts < DUPLICATE_WINDOW_MS) {
    count = prev.count + 1;
  }
  pageEventCounts.set(pageId, { ts: now, count });
  return count;
}

/** Read-only view (rule-skip shadow must not perturb the wake path's duplicate counter). */
function peekPageEventCount(pageId: string): number {
  const prev = pageEventCounts.get(pageId);
  return prev && Date.now() - prev.ts < DUPLICATE_WINDOW_MS ? prev.count : 0;
}

export function resetClefPageEventCountsForTests(): void {
  pageEventCounts.clear();
  itemDedupe.clear();
}

function isBotEcho(ctx: GateEventContext): boolean {
  if (!ctx.isCommentEvent) {
    return false;
  }
  const authorId = ctx.authorId;
  return Boolean(authorId && idInNotionIdSet(authorId, ctx.fleetCommentsBotIds));
}

export function opaqueLogItemId(itemId: string): string {
  if (itemId === "unknown" || itemId.trim() === "") {
    return itemId;
  }
  const normalized = normalizeNotionUuid(itemId);
  let hash = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
  }
  return `opaque:${hash.toString(16)}`;
}

export async function appendClefShadowLog(env: Env, entry: ClefShadowLogEntry): Promise<void> {
  const logged = { ...entry, item_id: opaqueLogItemId(entry.item_id) };
  console.log(JSON.stringify({ stream: "clef_wake_shadow", ...logged }));
  // CLEF_RING=1 → batched gate_log ring (no per-event KV write); fail-open inside.
  await enqueueGateLogRow(env, { stream: "clef_wake_shadow", ...logged });
}

function baseLogEntry(
  ctx: GateEventContext,
  notionType: string | null,
  itemId: string,
  ruleDecision: WakeDecisionOutcome,
  clefDecision: ClefDecisionOutcome,
  modeLabel: string,
  reason: string,
): ClefShadowLogEntry {
  return {
    ts: new Date().toISOString(),
    gate: "clef_wake",
    item_id: itemId,
    source: mapClefSource(ctx, notionType),
    event: notionType,
    rule_decision: ruleDecision,
    clef_decision: clefDecision,
    p_action: null,
    p_dup: null,
    q_when: null,
    confidence: null,
    model: null,
    latency_ms: null,
    sampled_full: null,
    mode: modeLabel,
    actually_ran: "coalesce_enqueued",
    reason,
    ...(ctx.eventKey ? { event_key: ctx.eventKey } : {}),
  };
}

function applyClefRun(entry: ClefShadowLogEntry, run: ParsedClefRun): ClefShadowLogEntry {
  return {
    ...entry,
    clef_decision: run.decision,
    p_action: run.pAction,
    p_dup: run.pDup,
    q_when: run.qWhen,
    confidence: run.confidence,
    model: run.model,
    latency_ms: run.latencyMs,
    reason: "clef_ok",
  };
}

export async function runClefShadowWakeGate(
  env: Env,
  ctx: GateEventContext,
  notionType: string | null,
  parsed: Record<string, unknown>,
  parseOk: boolean,
  ruleDecisions: WakeGateDecision[],
): Promise<void> {
  const itemId = resolveOpaqueItemId(ctx, parsed);
  const ruleDecision = aggregateRuleDecision(ruleDecisions);
  const modeRes = await resolveClefMode(env);

  if (ruleDecision !== "would_wake") {
    const entry = baseLogEntry(
      ctx,
      notionType,
      itemId,
      ruleDecision,
      ruleDecisionToClefDecision(ruleDecision),
      modeRes.modeLabel,
      "clef_skipped_rule_not_wake",
    );
    await appendClefShadowLog(env, entry);
    // Rule skips are not deduped: each one is still scored for false skips (sampled + capped).
    if (ruleDecision === "would_skip") {
      await runRuleSkipClefShadow(env, ctx, notionType, parsed, itemId, entry, {
        log: (row) => appendClefShadowLog(env, row),
        pageEventsLast60s: ctx.pageId ? peekPageEventCount(ctx.pageId) : 0,
      });
    }
    return;
  }

  const overrideReason = clefHardOverrideReason(ctx, parsed, parseOk, ruleDecisions);
  if (overrideReason) {
    const entry = baseLogEntry(
      ctx,
      notionType,
      itemId,
      ruleDecision,
      "would_wake",
      modeRes.modeLabel,
      overrideReason,
    );
    if (modeRes.reason) {
      entry.reason = `${overrideReason};${modeRes.reason}`;
    }
    await appendClefShadowLog(env, entry);
    return;
  }

  // Pre-Clef dedupe (after hard overrides, so John / Submitted / Needs John never dedupe).
  const itemCount = noteItemEvent(env, itemDedupeKey(ctx, notionType));
  if (itemCount > 1) {
    const entry = baseLogEntry(
      ctx,
      notionType,
      itemId,
      ruleDecision,
      "would_skip",
      modeRes.modeLabel,
      "dedupe_repeat_item",
    );
    entry.dedupe_repeat = true;
    entry.item_event_count = itemCount;
    // Rule said wake; this repeat is the wake the dedupe saves (count per unique item_id).
    entry.saved_wake = true;
    await appendClefShadowLog(env, entry);
    // A dedupe repeat is a skip: score it through the same sampled + capped false-skip check as rule skips.
    await runRuleSkipClefShadow(env, ctx, notionType, parsed, itemId, entry, {
      log: (row) => appendClefShadowLog(env, row),
      pageEventsLast60s: ctx.pageId ? peekPageEventCount(ctx.pageId) : 0,
      scoreAll: true, // 100% of dedupe repeats are scored (capped); each logs scored true/false
    });
    return;
  }

  if (!modeRes.allowClefCall) {
    const entry = baseLogEntry(
      ctx,
      notionType,
      itemId,
      ruleDecision,
      "would_wake",
      modeRes.modeLabel,
      modeRes.reason ?? "clef_mode_off",
    );
    await appendClefShadowLog(env, entry);
    return;
  }

  const cap = await tryConsumeClefCall(env);
  if (!cap.ok) {
    const entry = baseLogEntry(
      ctx,
      notionType,
      itemId,
      ruleDecision,
      "would_wake",
      modeRes.modeLabel,
      cap.reason,
    );
    await appendClefShadowLog(env, entry);
    return;
  }

  const pageEventsLast60s = ctx.pageId ? bumpPageEventCount(env, ctx.pageId) : 0;
  const state = buildClefStateString(ctx, notionType, parsed, pageEventsLast60s, isBotEcho(ctx));

  let entry = baseLogEntry(
    ctx,
    notionType,
    itemId,
    ruleDecision,
    "would_wake",
    modeRes.modeLabel,
    "clef_pending",
  );
  if (modeRes.reason) {
    entry.reason = modeRes.reason;
  }

  const flash = await invokeClefFlash(env, state);
  if (!flash.ok) {
    entry.reason = flash.reason;
    entry.clef_decision = "would_wake";
    await appendClefShadowLog(env, entry);
    return;
  }

  entry = applyClefRun(entry, flash.parsed);
  if (modeRes.reason) {
    entry.reason = `${entry.reason};${modeRes.reason}`;
  }

  if (shouldRunClefFullSample(itemId)) {
    const fullCap = await tryConsumeClefCall(env);
    if (fullCap.ok) {
      const full = await invokeClefFull(env, state);
      if (full.ok) {
        entry.sampled_full = {
          decision: full.parsed.decision,
          p_action: full.parsed.pAction,
          p_dup: full.parsed.pDup,
          q_when: full.parsed.qWhen,
          model: full.parsed.model,
        };
      }
    }
  }

  await appendClefShadowLog(env, entry);
}
