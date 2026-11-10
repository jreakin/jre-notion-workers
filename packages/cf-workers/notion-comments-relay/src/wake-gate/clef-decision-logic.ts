import {
  CLEF_P_ACTION_BATCH_MAX,
  CLEF_P_ACTION_SKIP_MAX,
  CLEF_P_DUP_SKIP_MIN,
} from "./clef-thresholds.js";

export type ClefOutcome = "would_wake" | "would_skip" | "would_batch";

export function decideClefOutcome(
  pAction: number,
  pDup: number,
  qWhen: "now" | "batch" | "ignore",
): ClefOutcome {
  if (pAction <= CLEF_P_ACTION_SKIP_MAX && pDup >= CLEF_P_DUP_SKIP_MIN) {
    return "would_skip";
  }
  // Clef Decision Model amendment (needs John's sign-off): q_when=ignore batches like
  // q_when=batch. It never skips; skip stays p_action <= 0.05 && p_dup >= 0.80 only.
  if (pAction <= CLEF_P_ACTION_BATCH_MAX && (qWhen === "batch" || qWhen === "ignore")) {
    return "would_batch";
  }
  return "would_wake";
}

/** Webhook event types the page_created skip rule (Option 1) applies to. */
export const CLEF_PAGE_CREATED_EVENT = "page.created";

export function isClefPageCreatedEvent(notionType: string | null): boolean {
  return notionType === CLEF_PAGE_CREATED_EVENT;
}

/**
 * The Option 1 predicate itself: p_action <= 0.05 AND q_when = "ignore". A live page.created skip
 * requires exactly this (from flash, and from the full model when sampled); the p_dup rule never
 * makes a page.created skip live.
 */
export function pageCreatedOption1Skip(pAction: number, qWhen: "now" | "batch" | "ignore"): boolean {
  return pAction <= CLEF_P_ACTION_SKIP_MAX && qWhen === "ignore";
}

/**
 * Event-aware Clef outcome (Option 1, John 2026-11-09). A new page cannot be a duplicate, so the
 * p_dup rule above never skips page.created. For page.created only, also skip when
 * p_action <= 0.05 AND q_when = "ignore". Every other event type is decided by decideClefOutcome
 * unchanged. Callers apply this only to a real Clef score (no override, no fallback, no mode reason);
 * see pageCreatedRuleEligible in clef-wake-gate.ts.
 */
export function decideClefOutcomeForEvent(
  pAction: number,
  pDup: number,
  qWhen: "now" | "batch" | "ignore",
  notionType: string | null,
): ClefOutcome {
  if (isClefPageCreatedEvent(notionType) && pageCreatedOption1Skip(pAction, qWhen)) {
    return "would_skip";
  }
  return decideClefOutcome(pAction, pDup, qWhen);
}
