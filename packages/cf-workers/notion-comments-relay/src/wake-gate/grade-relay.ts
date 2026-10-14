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
 * - any `clef_ai_unbound` / `clef_gateway_unset` row, wake path or false-skip check (Clef unreachable)
 *   → `config_error`;
 * - unscored repeats → `unscored_dedupe_repeat_cap` when the dedupe-repeat cap ran out (capacity), else
 *   `unscored_dedupe_repeat` (error / mode off / missing row).
 * Mode-off days fail too (repeats log `rule_skip:mode_off`, scored:false): an off day is unmeasured.
 * Rule skips are SAMPLED (CLEF_RULE_SKIP_SAMPLE_PERCENT, daily cap): unsampled rule skips are reported
 * as `rule_skips_unscored` but do not fail the window, so "zero false skips" for rule skips means
 * zero among the scored ones. State that coverage alongside any pass.
 */
export const RELAY_ERROR_RATE_MAX = 0.02;
const ERROR_RE = /^(clef_error:|clef_timeout$|clef_bad_output$|clef_ai_unbound$|clef_gateway_unset$)/;
/** Clef never reachable: any such row (wake path or false-skip check) fails the window. */
export const RELAY_CONFIG_ERRORS: ReadonlySet<string> = new Set(["clef_ai_unbound", "clef_gateway_unset"]);

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
  /** Of the unscored repeats, how many were due to the dedupe-repeat daily cap. */
  dedupe_repeats_unscored_cap: number;
  /** Scored skips (rule or dedupe) where Clef said would_wake. */
  false_skips: number;
  /** saved_wake rows grouped by opaque item_id. */
  saved_wakes_by_item: Record<string, number>;
  /** Config-error rows (clef_ai_unbound / clef_gateway_unset), wake path or false-skip check. */
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
  let dedupeCapUnscored = 0;
  let falseSkips = 0;
  let aiUnbound = 0;
  const saved: Record<string, number> = {};
  for (const r of rows) {
    if (r.stream !== undefined && r.stream !== "clef_wake_shadow") continue;
    const reason = str(r.reason);
    if (r.decision === "rule_skip") {
      if (RELAY_CONFIG_ERRORS.has(reason.replace(/^rule_skip:/, ""))) aiUnbound += 1;
      const scored = r.scored === true || reason === "rule_skip:clef_ok";
      if (r.dedupe_repeat === true) {
        if (r.excluded === true) dedupeExcluded += 1;
        else if (scored) dedupeScored += 1;
        else if (r.cap_exhausted === true || reason === "dedupe_repeat_daily_cap") dedupeCapUnscored += 1;
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
    if (RELAY_CONFIG_ERRORS.has(reason.split(";")[0] ?? "")) aiUnbound += 1;
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
  const capUnscored = Math.min(dedupeCapUnscored, dedupeUnscored);
  const fail: string[] = [];
  if (falseSkips > 0) fail.push("false_skip");
  // Cap exhaustion is a capacity problem, not a gate-quality one: its own reason.
  if (capUnscored > 0) fail.push("unscored_dedupe_repeat_cap");
  if (dedupeUnscored - capUnscored > 0) fail.push("unscored_dedupe_repeat");
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
    dedupe_repeats_unscored_cap: capUnscored,
    false_skips: falseSkips,
    saved_wakes_by_item: saved,
    ai_unbound: aiUnbound,
  };
}
