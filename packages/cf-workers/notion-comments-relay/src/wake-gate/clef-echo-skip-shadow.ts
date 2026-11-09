/**
 * Shadow-only Clef scoring for LOCK-69 echo-filter drops (own_echo / agent_prefix /
 * untracked_property_edit). The drop itself is live and deterministic; this only asks Clef, on a
 * sample, whether it would have woken CoS, so false drops can be measured.
 *
 * Runs via ctx.waitUntil AFTER the drop's 200 is decided: it never changes the decision or adds latency.
 * Bounded by: sample percent (CLEF_ECHO_SKIP_SAMPLE_PERCENT, default 5), its own soft daily counter
 * (CLEF_ECHO_SKIP_DAILY_CAP, default 100, so it cannot starve rule-skip checks) and the global Clef
 * daily cap (CLEF_DAILY_CALL_CAP via tryConsumeClefCall). Clef mode off ⇒ no call. Every error is swallowed.
 * Rows: stream clef_wake_shadow, decision rule_skip, source echo_filter, echo_reason, scored true/false.
 * Unsampled events add no row (the deterministic rule_skip row is already logged).
 */
import type { Env } from "../env.js";
import { flushGateLogRing } from "../gate-log-ring.js";
import { tryConsumeClefCall } from "./clef-daily-cap.js";
import { runRuleSkipClefShadow, type RuleSkipShadowDeps } from "./clef-rule-skip-shadow.js";
import { appendClefShadowLog } from "./clef-wake-gate.js";
import { ECHO_FILTER_STREAM, type EchoFilterVerdict } from "./echo-filter.js";
import type { ClefShadowLogEntry, GateEventContext } from "./gate-event-types.js";

export const ECHO_SKIP_SAMPLE_PERCENT_DEFAULT = 5;
export const ECHO_SKIP_DAILY_CAP_DEFAULT = 100;
export const ECHO_SKIP_COUNTER_NAME = "clef:echo_skip_calls";
export const ECHO_SKIP_CAP_REASON = "echo_skip_daily_cap";

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw?.trim() ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function readEchoSkipSamplePercent(env: Env): number {
  return Math.min(100, parseNonNegativeInt(env.CLEF_ECHO_SKIP_SAMPLE_PERCENT, ECHO_SKIP_SAMPLE_PERCENT_DEFAULT));
}

export function readEchoSkipDailyCap(env: Env): number {
  return parseNonNegativeInt(env.CLEF_ECHO_SKIP_DAILY_CAP, ECHO_SKIP_DAILY_CAP_DEFAULT);
}

export type EchoSkipShadowDeps = {
  log?: RuleSkipShadowDeps["log"];
  /** Ship gate_log rows at the end (default true; the drop branch already flushed its own row). */
  flush?: boolean;
};

/**
 * Score one echo-filter drop shadow-only. Never throws. `ctx` is the forward-path gate context the
 * filter decided on; item id = comment id for comments, else page id (raw; hashed when logged).
 */
export async function runEchoSkipClefShadow(
  env: Env,
  ctx: GateEventContext,
  parsed: Record<string, unknown>,
  verdict: Extract<EchoFilterVerdict, { decision: "drop" }>,
  deps: EchoSkipShadowDeps = {},
): Promise<void> {
  try {
    const itemId = (ctx.isCommentEvent ? ctx.commentId : ctx.pageId) ?? ctx.pageId ?? "unknown";
    const base: ClefShadowLogEntry = {
      ts: new Date().toISOString(),
      gate: "clef_wake",
      item_id: itemId,
      source: ECHO_FILTER_STREAM,
      event: ctx.notionType,
      event_key: ctx.eventKey ?? "unknown",
      rule_decision: "would_skip",
      clef_decision: "would_skip",
      p_action: null,
      p_dup: null,
      q_when: null,
      confidence: null,
      model: null,
      latency_ms: null,
      sampled_full: null,
      mode: "deterministic",
      actually_ran: "echo_filter",
      reason: `rule_skip:${verdict.reason}`,
      echo_reason: verdict.reason,
    };
    await runRuleSkipClefShadow(env, ctx, ctx.notionType, parsed, itemId, base, {
      log: deps.log ?? ((entry) => appendClefShadowLog(env, entry)),
      pageEventsLast60s: 0,
      budget: {
        samplePercent: readEchoSkipSamplePercent(env),
        counterName: ECHO_SKIP_COUNTER_NAME,
        dailyCap: readEchoSkipDailyCap(env),
        capReason: ECHO_SKIP_CAP_REASON,
        consumeGlobal: () => tryConsumeClefCall(env),
      },
    });
    if (deps.flush !== false) await flushGateLogRing(env);
  } catch {
    // fail-open: shadow scoring never affects the live drop
  }
}
