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
