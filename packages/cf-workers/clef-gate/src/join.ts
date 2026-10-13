import type { ShadowLabel } from "./clef-email.js";
import type { Disposition } from "./payload.js";

export type TriageTruth = { disposition: Disposition; escalated: boolean; rescued?: boolean };

/** Triage "acted": escalated to John, handed to a lane, or John rescued it from TrainSpam. */
export function triageActed(t: TriageTruth): boolean {
  return t.rescued === true || t.escalated || t.disposition === "escalate_john" || t.disposition === "handoff_lane";
}

export function triageSkipped(t: TriageTruth): boolean {
  return !triageActed(t) && (t.disposition === "spam" || t.disposition === "archive_fyi");
}

export type JoinFlags = { agree: boolean; false_skip: boolean; false_wake: boolean };

export function computeJoinFlags(label: ShadowLabel, t: TriageTruth): JoinFlags {
  const acted = triageActed(t);
  const skipped = triageSkipped(t);
  const false_skip = label === "would_skip" && acted;
  const false_wake = label === "escalate" && skipped;
  const agree =
    (label === "escalate" && acted) ||
    (label === "would_skip" && skipped) ||
    (label === "fyi" && !acted && (t.disposition === "archive_fyi" || t.disposition === "leave"));
  return { agree, false_skip, false_wake };
}
