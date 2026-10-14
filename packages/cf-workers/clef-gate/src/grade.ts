/**
 * Window grader for clef_email shadow rows (14-day zero-false-skip window).
 *
 * Input: rows already joined via gradeJoined()/gradeFromKv() (never raw outcome rows).
 * `shadow_label:"error"` rows (no verdict after retries/fallback, gateway unset, AI unbound, cap store
 * unreadable) are neither wakes nor skips: they are an unmeasured email. The window FAILS when:
 *   - any row has false_skip === true, or
 *   - any day's error rate (error rows / decided rows that day) is above ERROR_RATE_MAX (2%), or
 *   - any row has a config error (clef_gateway_unset / clef_ai_unbound): Clef was never reachable.
 * Error rows whose triage acted (escalate_john / handoff_lane / escalated / TrainSpam rescue) are
 * listed as unmeasured would-be wakes. Pending rows (null from gradeJoined) are skipped by the caller.
 */
import { triageActed } from "./join.js";
import type { EmailShadowLogEntry } from "./shadow.js";

export const ERROR_RATE_MAX = 0.02;
export const CONFIG_ERROR_REASONS: ReadonlySet<string> = new Set(["clef_gateway_unset", "clef_ai_unbound"]);

export type DayErrorStats = { day: string; decided: number; errors: number; error_rate: number; over_threshold: boolean };

export type WindowGrade = {
  pass: boolean;
  fail_reasons: string[];
  days: DayErrorStats[];
  false_skips: number;
  config_errors: number;
  /** msg_id_hash of error rows whose triage acted: Clef never scored a real wake. */
  unmeasured_wakes: string[];
};

/** UTC day of the row's ts (the decision write time). */
function dayOf(row: EmailShadowLogEntry): string {
  return typeof row.ts === "string" && row.ts.length >= 10 ? row.ts.slice(0, 10) : "unknown";
}

export function gradeWindow(rows: EmailShadowLogEntry[], errorRateMax = ERROR_RATE_MAX): WindowGrade {
  const byDay = new Map<string, { decided: number; errors: number }>();
  let falseSkips = 0;
  let configErrors = 0;
  const unmeasured: string[] = [];
  for (const r of rows) {
    if (r.event !== "decision" && r.event !== "outcome") continue;
    if (!r.shadow_label) continue; // pending
    const d = byDay.get(dayOf(r)) ?? { decided: 0, errors: 0 };
    d.decided += 1;
    if (r.shadow_label === "error") {
      d.errors += 1;
      if (r.error_reason && CONFIG_ERROR_REASONS.has(r.error_reason)) configErrors += 1;
      if (
        r.triage_disposition &&
        triageActed({
          disposition: r.triage_disposition,
          escalated: r.triage_escalated === true,
          rescued: r.triage_rescued,
        }) &&
        r.msg_id_hash
      ) {
        unmeasured.push(r.msg_id_hash);
      }
    }
    if (r.false_skip === true) falseSkips += 1;
    byDay.set(dayOf(r), d);
  }
  const days = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, v]) => {
      const rate = v.decided ? v.errors / v.decided : 0;
      return { day, decided: v.decided, errors: v.errors, error_rate: rate, over_threshold: rate > errorRateMax };
    });
  const fail: string[] = [];
  if (falseSkips > 0) fail.push("false_skip");
  if (days.some((d) => d.over_threshold)) fail.push("error_rate_over_threshold");
  if (configErrors > 0) fail.push("config_error");
  return { pass: fail.length === 0, fail_reasons: fail, days, false_skips: falseSkips, config_errors: configErrors, unmeasured_wakes: unmeasured };
}
