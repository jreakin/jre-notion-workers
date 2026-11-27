/**
 * Live Clef skip (fail-open), behind per-event env flags:
 * - CLEF_SKIP_PAGE_CREATED_LIVE=1 (Option 1 page.created only)
 * - CLEF_SKIP_COMMENTS_LIVE=1 (comment.* standard would_skip)
 * - CLEF_SKIP_PROPERTIES_UPDATED_LIVE=1 (page.properties_updated standard would_skip)
 *
 * The forward path waits (bounded by CLEF_LIVE_DECISION_TIMEOUT_MS) for the Clef gate shadow path already runs.
 * Timeout, error, KV kill switch, or any other verdict ⇒ forward (fail open).
 */
import type { Env } from "../env.js";
import { flushGateLogRing } from "../gate-log-ring.js";
import {
  appendClefShadowLog,
  type ClefGateResult,
  type ClefLiveSkipKind,
  PAGE_CREATED_RULE_TAG,
} from "./clef-wake-gate.js";

export const CLEF_LIVE_DECISION_TIMEOUT_MS_DEFAULT = 8_000;
export const CLEF_LIVE_SKIP_REASON = `clef_live_skip:${PAGE_CREATED_RULE_TAG}`;

export function liveSkipLogReason(v: ClefGateResult): string {
  if (v.pageCreatedSkip) {
    return CLEF_LIVE_SKIP_REASON;
  }
  if (v.liveSkipKind === "comment") {
    return "clef_live_skip:comment";
  }
  if (v.liveSkipKind === "properties_updated") {
    return "clef_live_skip:properties_updated";
  }
  return CLEF_LIVE_SKIP_REASON;
}

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

function liveSkipKindActive(v: ClefGateResult): ClefLiveSkipKind | "page_created" | null {
  if (v.pageCreatedSkip && v.entry?.page_created_rule === "would_skip") {
    return "page_created";
  }
  return v.liveSkipKind;
}

/** True when the verdict allows a live skip on the wake-path row. */
export function isLiveSkipVerdict(v: ClefGateResult | null): v is ClefGateResult & { entry: NonNullable<ClefGateResult["entry"]> } {
  if (!v?.entry) {
    return false;
  }
  const kind = liveSkipKindActive(v);
  if (!kind) {
    return false;
  }
  if (kind === "page_created") {
    return v.entry.clef_decision === "would_skip";
  }
  return v.entry.clef_decision === "would_skip";
}

/** One masked row per actual skip (opaque item id, scores and labels only), then ship gate_log. Fail-open. */
export async function logClefLiveSkip(env: Env, v: ClefGateResult & { entry: NonNullable<ClefGateResult["entry"]> }): Promise<void> {
  const reason = liveSkipLogReason(v);
  try {
    await appendClefShadowLog(env, {
      ...v.entry,
      ts: new Date().toISOString(),
      clef_decision: "would_skip",
      actually_ran: "clef_live_skipped",
      mode: "live",
      reason,
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
