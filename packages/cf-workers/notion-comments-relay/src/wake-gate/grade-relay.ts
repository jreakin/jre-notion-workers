/**
 * Window grader for the relay's comment/properties Clef gate (`stream: "clef_wake_shadow"` rows).
 * Counterpart of clef-gate's gradeWindow (email). Pass the window's rows (any order, any stream;
 * non-clef_wake_shadow rows are ignored). Days are UTC (row `ts`).
 *
 * Row kinds:
 * - wake-path Clef row: `decision` absent, reason `clef_ok` or a Clef failure reason;
 * - rule-skip base row: `rule_decision:"would_skip"`, reason `clef_skipped_rule_not_wake`;
 * - dedupe repeat: reason `dedupe_repeat_item` (`saved_wake:true`);
 * - false-skip check row: `decision:"rule_skip"` (+ `dedupe_repeat:true` when it scores a repeat),
 *   `scored` true/false, `candidate_false_skip`.
 *
 * The window FAILS when:
 * - any scored skip (rule skip or dedupe repeat) has `candidate_false_skip:true`;
 * - any dedupe repeat is unscored (repeats are scored 100%; cap/error/mode-off leaves them unscored);
 * - any day's wake-path Clef error rate is above ERROR_RATE_MAX (2%);
 * - any `clef_ai_unbound` row (Clef was never reachable).
 * Rule skips are SAMPLED (CLEF_RULE_SKIP_SAMPLE_PERCENT, daily cap): unsampled rule skips are reported
 * as `rule_skips_unscored` but do not fail the window, so "zero false skips" for rule skips means
 * zero among the scored ones. State that coverage alongside any pass.
 */
export const RELAY_ERROR_RATE_MAX = 0.02;
const ERROR_RE = /^(clef_error:|clef_timeout$|clef_bad_output$|clef_ai_unbound$)/;

type Row = Record<string, unknown>;

export type RelayDay = {
  day: string;
  clef_calls: number;
  clef_errors: number;
  error_rate: number;
  over_threshold: boolean;
};

export type RelayGrade = {
  pass: boolean;
  fail_reasons: string[];
  days: RelayDay[];
  rule_skips: number;
  rule_skips_scored: number;
  rule_skips_unscored: number;
  dedupe_repeats: number;
  dedupe_repeats_scored: number;
  dedupe_repeats_unscored: number;
  /** Scored skips (rule or dedupe) where Clef said would_wake. */
  false_skips: number;
  /** saved_wake rows grouped by opaque item_id. */
  saved_wakes_by_item: Record<string, number>;
  ai_unbound: number;
};

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function gradeRelayWindow(rows: Row[], errorRateMax = RELAY_ERROR_RATE_MAX): RelayGrade {
  const days = new Map<string, { calls: number; errors: number }>();
  let ruleSkips = 0;
  let ruleScored = 0;
  let dedupe = 0;
  let dedupeScored = 0;
  let dedupeExcluded = 0;
  let falseSkips = 0;
  let aiUnbound = 0;
  const saved: Record<string, number> = {};
  for (const r of rows) {
    if (r.stream !== undefined && r.stream !== "clef_wake_shadow") continue;
    const reason = str(r.reason);
    if (r.decision === "rule_skip") {
      const scored = r.scored === true || reason === "rule_skip:clef_ok";
      if (r.dedupe_repeat === true) {
        if (r.excluded === true) dedupeExcluded += 1;
        else if (scored) dedupeScored += 1;
      } else if (scored) {
        ruleScored += 1;
      }
      if (scored && r.candidate_false_skip === true) falseSkips += 1;
      continue;
    }
    if (reason === "dedupe_repeat_item") {
      dedupe += 1;
      const id = str(r.item_id) || "unknown";
      saved[id] = (saved[id] ?? 0) + (r.saved_wake === true ? 1 : 0);
      continue;
    }
    if (r.rule_decision === "would_skip" && reason === "clef_skipped_rule_not_wake") {
      ruleSkips += 1;
      continue;
    }
    if (reason === "clef_ai_unbound") aiUnbound += 1;
    // Wake-path Clef attempts: clef_ok (possibly with ";mode" suffix) or a Clef failure reason.
    const base = reason.split(";")[0] ?? "";
    if (base === "clef_ok" || ERROR_RE.test(base)) {
      const day = str(r.ts).slice(0, 10) || "unknown";
      const d = days.get(day) ?? { calls: 0, errors: 0 };
      d.calls += 1;
      if (ERROR_RE.test(base)) d.errors += 1;
      days.set(day, d);
    }
  }
  const dayList = [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, v]) => {
      const rate = v.calls ? v.errors / v.calls : 0;
      return { day, clef_calls: v.calls, clef_errors: v.errors, error_rate: rate, over_threshold: rate > errorRateMax };
    });
  const dedupeUnscored = Math.max(0, dedupe - dedupeScored - dedupeExcluded);
  const fail: string[] = [];
  if (falseSkips > 0) fail.push("false_skip");
  if (dedupeUnscored > 0) fail.push("unscored_dedupe_repeat");
  if (dayList.some((d) => d.over_threshold)) fail.push("error_rate_over_threshold");
  if (aiUnbound > 0) fail.push("config_error");
  return {
    pass: fail.length === 0,
    fail_reasons: fail,
    days: dayList,
    rule_skips: ruleSkips,
    rule_skips_scored: ruleScored,
    rule_skips_unscored: Math.max(0, ruleSkips - ruleScored),
    dedupe_repeats: dedupe,
    dedupe_repeats_scored: dedupeScored,
    dedupe_repeats_unscored: dedupeUnscored,
    false_skips: falseSkips,
    saved_wakes_by_item: saved,
    ai_unbound: aiUnbound,
  };
}
