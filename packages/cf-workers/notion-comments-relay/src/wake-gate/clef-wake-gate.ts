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

const CLEF_SHADOW_LOG_KEY = "clef_shadow_log";
const CLEF_SHADOW_LOG_MAX = 50;
const DUPLICATE_WINDOW_MS = 60_000;

const pageEventCounts = new Map<string, { ts: number; count: number }>();

export function aggregateRuleDecision(decisions: WakeGateDecision[]): WakeDecisionOutcome {
  if (decisions.some((d) => d.decision === "would_wake")) {
    return "would_wake";
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

export function resetClefPageEventCountsForTests(): void {
  pageEventCounts.clear();
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

function clefRingEnabled(env: Env): boolean {
  return env.CLEF_RING === "1";
}

export async function appendClefShadowLog(env: Env, entry: ClefShadowLogEntry): Promise<void> {
  const logged = { ...entry, item_id: opaqueLogItemId(entry.item_id) };
  console.log(JSON.stringify({ stream: "clef_wake_shadow", ...logged }));
  if (!clefRingEnabled(env)) {
    return;
  }
  try {
    const raw = await env.RELAY_KV.get(CLEF_SHADOW_LOG_KEY);
    const hist: ClefShadowLogEntry[] = raw ? (JSON.parse(raw) as ClefShadowLogEntry[]) : [];
    hist.unshift(logged);
    await env.RELAY_KV.put(
      CLEF_SHADOW_LOG_KEY,
      JSON.stringify(hist.slice(0, CLEF_SHADOW_LOG_MAX)),
      {
        expirationTtl: 60 * 60 * 24 * 30,
      },
    );
  } catch {
    // shadow logging must not affect forwarding
  }
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
