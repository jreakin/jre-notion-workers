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
  // q_when=ignore must never be louder than batch (bug: it fell through to would_wake).
  if (qWhen === "ignore" && pAction <= CLEF_P_ACTION_BATCH_MAX) {
    return pDup >= CLEF_P_DUP_SKIP_MIN ? "would_skip" : "would_batch";
  }
  if (pAction <= CLEF_P_ACTION_BATCH_MAX && qWhen === "batch") {
    return "would_batch";
  }
  return "would_wake";
}
