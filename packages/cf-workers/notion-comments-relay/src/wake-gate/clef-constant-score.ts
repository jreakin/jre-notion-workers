const STREAK_TRIGGER = 5;

let streak = { pAction: null as number | null, confidence: null as number | null, count: 0 };
let forceWakeUntilDifferent = false;

function scoreKey(pAction: number, confidence: number | null): string {
  const c = confidence === null ? "null" : String(confidence);
  return `${pAction}|${c}`;
}

/** Clef-scored rows only. After 5 identical (p_action, confidence) in a row, force wakes until a different score. */
export function noteClefConstantScore(
  pAction: number | null,
  confidence: number | null,
): { forceWake: boolean; logReason: string | null } {
  if (pAction === null) {
    streak = { pAction: null, confidence: null, count: 0 };
    forceWakeUntilDifferent = false;
    return { forceWake: false, logReason: null };
  }
  const key = scoreKey(pAction, confidence);
  const prevKey =
    streak.pAction === null ? null : scoreKey(streak.pAction, streak.confidence);
  if (key === prevKey) {
    streak.count += 1;
  } else {
    streak = { pAction, confidence, count: 1 };
    forceWakeUntilDifferent = false;
  }
  if (streak.count >= STREAK_TRIGGER) {
    forceWakeUntilDifferent = true;
  }
  if (forceWakeUntilDifferent) {
    return { forceWake: true, logReason: "clef_constant_score" };
  }
  return { forceWake: false, logReason: null };
}

export function resetClefConstantScoreForTests(): void {
  streak = { pAction: null, confidence: null, count: 0 };
  forceWakeUntilDifferent = false;
}
