/**
 * Live Clef page.created skip (Option 1, John 2026-11-09), behind CLEF_SKIP_PAGE_CREATED_LIVE=1.
 *
 * Flag off (default): nothing here runs; the shadow gates stay in waitUntil and every event is forwarded.
 * Flag on, page.created only: the forward path waits (bounded by CLEF_LIVE_DECISION_TIMEOUT_MS) for the
 * Clef gate it already runs. When the gate reports `pageCreatedSkip` the event is not forwarded and ONE
 * extra masked row is written (`live_skip: true`, reason `clef_live_skip:page_created_ignore`, joined to
 * the wake-path row by `event_key`). Timeout, error or any other verdict ⇒ forward (fail open).
 */
import type { Env } from "../env.js";
import { flushGateLogRing } from "../gate-log-ring.js";
import { appendClefShadowLog, type ClefGateResult, PAGE_CREATED_RULE_TAG } from "./clef-wake-gate.js";

export const CLEF_LIVE_DECISION_TIMEOUT_MS_DEFAULT = 8_000;
export const CLEF_LIVE_SKIP_REASON = `clef_live_skip:${PAGE_CREATED_RULE_TAG}`;

export function readClefLiveDecisionTimeoutMs(env: Pick<Env, "CLEF_LIVE_DECISION_TIMEOUT_MS">): number {
  const n = Number.parseInt(env.CLEF_LIVE_DECISION_TIMEOUT_MS?.trim() ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : CLEF_LIVE_DECISION_TIMEOUT_MS_DEFAULT;
}

/** The gate's verdict, or null on timeout / rejection (the caller then forwards). Never throws. */
export async function awaitClefVerdict(
  pending: Promise<ClefGateResult | null>,
  timeoutMs: number,
): Promise<ClefGateResult | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([pending.catch(() => null), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** True when the verdict allows a live skip: the Option 1 rule fired on a logged wake-path row. */
export function isLiveSkipVerdict(v: ClefGateResult | null): v is ClefGateResult & { entry: NonNullable<ClefGateResult["entry"]> } {
  return Boolean(v?.pageCreatedSkip && v.entry && v.entry.page_created_rule === "would_skip");
}

/** One masked row per actual skip (opaque item id, scores and labels only), then ship gate_log. Fail-open. */
export async function logClefLiveSkip(env: Env, v: ClefGateResult & { entry: NonNullable<ClefGateResult["entry"]> }): Promise<void> {
  try {
    await appendClefShadowLog(env, {
      ...v.entry,
      ts: new Date().toISOString(),
      clef_decision: "would_skip",
      actually_ran: "clef_live_skipped",
      mode: "live",
      reason: CLEF_LIVE_SKIP_REASON,
      live_skip: true,
    });
  } catch {
    // fail-open: the skip stands; console may still have the wake-path row
  }
  try {
    await flushGateLogRing(env);
  } catch {
    // fail-open
  }
}
