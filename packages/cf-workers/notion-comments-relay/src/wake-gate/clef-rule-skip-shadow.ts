/**
 * Shadow-only Clef scoring for events the deterministic rules skipped (Abstract Secretary finding:
 * rule skips never reached clef_wake, so false skips could not be scored).
 *
 * Never wakes anyone and never touches the forward path: it runs inside the existing
 * `ctx.waitUntil(runShadowWakeGates(...))` after forwarding is scheduled, and every error is swallowed.
 * Volume is bounded by sampling + a soft daily cap (CLEF_RULE_SKIP_DAILY_CAP, default 200).
 */
import { maskPii, structuredMentionsExcludedAddress } from "../../../../clef-core/src/index.js";
import type { Env } from "../env.js";
import { trySoftDailyConsume } from "../soft-daily-counter.js";
import { invokeClefFlash } from "./clef-ai.js";
import { resolveClefMode } from "./clef-mode.js";
import { buildClefStateString } from "./clef-state.js";
import { idInNotionIdSet, normalizeNotionUuid } from "./notion-ids.js";
import type { ClefShadowLogEntry, GateEventContext } from "./gate-event-types.js";

export const RULE_SKIP_DAILY_CAP_DEFAULT = 200;
export const RULE_SKIP_SAMPLE_PERCENT_DEFAULT = 50;
/** Persist the soft counter every N calls (≈ cap/N KV writes/day). */
export const RULE_SKIP_COUNTER_PERSIST_EVERY = 10;
export const RULE_SKIP_COUNTER_NAME = "clef:rule_skip_calls";

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw?.trim() ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function readRuleSkipDailyCap(env: Env): number {
  return parsePositiveInt(env.CLEF_RULE_SKIP_DAILY_CAP, RULE_SKIP_DAILY_CAP_DEFAULT);
}

export function readRuleSkipSamplePercent(env: Env): number {
  return Math.min(100, parsePositiveInt(env.CLEF_RULE_SKIP_SAMPLE_PERCENT, RULE_SKIP_SAMPLE_PERCENT_DEFAULT));
}

/** Deterministic per (item, UTC hour) so retries of the same burst sample consistently. */
export function ruleSkipSampled(itemId: string, percent: number, now: Date = new Date()): boolean {
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  const seed = `${normalizeNotionUuid(itemId)}|${now.toISOString().slice(0, 13)}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return hash % 100 < percent;
}

/** Notion free-text keys (author-controlled): masked for Clef, never used for exclusion. */
export const NOTION_FREE_TEXT_KEYS: ReadonlySet<string> = new Set([
  "text",
  "plain_text",
  "content",
  "rich_text",
  "title",
  "snippet",
  "subject",
  "href",
]);

/** Same anchored jre@mail.grokbot.com rule as clef-gate (#36), on structured fields only. */
export function ruleSkipExcludedGrokbot(parsed: Record<string, unknown>): boolean {
  return structuredMentionsExcludedAddress(parsed, NOTION_FREE_TEXT_KEYS);
}

export type RuleSkipShadowDeps = {
  log: (entry: ClefShadowLogEntry) => Promise<void>;
  pageEventsLast60s: number;
};

/**
 * `base` is the already-built clef_wake shadow entry for this rule-skipped event (same fields as
 * every other clef_wake row). Emits ONE additional row with decision=rule_skip + Clef's verdict.
 */
export async function runRuleSkipClefShadow(
  env: Env,
  ctx: GateEventContext,
  notionType: string | null,
  parsed: Record<string, unknown>,
  itemId: string,
  base: ClefShadowLogEntry,
  deps: RuleSkipShadowDeps,
): Promise<void> {
  try {
    const row: ClefShadowLogEntry = {
      ...base,
      ts: new Date().toISOString(),
      decision: "rule_skip",
      candidate_false_skip: false,
      actually_ran: base.actually_ran,
    };

    const modeRes = await resolveClefMode(env);
    if (!modeRes.allowClefCall) {
      return; // mode off: no extra row, no call (base row already logged)
    }
    if (ruleSkipExcludedGrokbot(parsed)) {
      await deps.log({ ...row, reason: "rule_skip:excluded_grokbot" });
      return; // bot's own inbox: never sent to Clef
    }
    if (!ruleSkipSampled(itemId, readRuleSkipSamplePercent(env))) {
      return; // unsampled: no extra row keeps log + KV volume flat
    }
    const cap = await trySoftDailyConsume(
      env.RELAY_KV,
      RULE_SKIP_COUNTER_NAME,
      readRuleSkipDailyCap(env),
      RULE_SKIP_COUNTER_PERSIST_EVERY,
    );
    if (!cap.ok) {
      await deps.log({ ...row, reason: "rule_skip_daily_cap" });
      return;
    }

    const isEcho = Boolean(
      ctx.isCommentEvent && ctx.authorId && idInNotionIdSet(ctx.authorId, ctx.fleetCommentsBotIds),
    );
    const state = buildClefStateString(ctx, notionType, parsed, deps.pageEventsLast60s, isEcho, {
      maskText: maskPii,
    });
    const flash = await invokeClefFlash(env, state);
    if (!flash.ok) {
      await deps.log({ ...row, reason: `rule_skip:${flash.reason}` });
      return;
    }
    const run = flash.parsed;
    await deps.log({
      ...row,
      clef_decision: run.decision,
      p_action: run.pAction,
      p_dup: run.pDup,
      q_when: run.qWhen,
      confidence: run.confidence,
      model: run.model,
      latency_ms: run.latencyMs,
      candidate_false_skip: run.decision === "would_wake",
      reason: "rule_skip:clef_ok",
    });
  } catch (err) {
    // fail-open: shadow path must never affect forwarding or the primary shadow log
    try {
      console.log(
        JSON.stringify({
          stream: "clef_wake_shadow",
          gate: "clef_wake",
          decision: "rule_skip",
          reason: `rule_skip:error:${err instanceof Error ? err.name : "Error"}`,
        }),
      );
    } catch {
      // ignore
    }
  }
}
