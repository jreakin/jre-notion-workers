/**
 * Offline replay, Mode A (no AI): re-decide exported clef_wake_shadow rows with the live
 * decideClefOutcome, two candidate skip variants and `option1` (the page.created rule shipped in PR B,
 * decideClefOutcomeForEvent on eligible rows). Pure functions; no I/O.
 *
 * Input rows are masked exports (Steward/BCH, from gate_log:v1 KV values). Only the fields below are
 * read; everything else (and any free text) is ignored, so titles or content can never reach output.
 */
import { decideClefOutcome, decideClefOutcomeForEvent } from "../../src/wake-gate/clef-decision-logic.js";

export type QWhen = "now" | "batch" | "ignore";

export type ReplayRow = {
  item_id: string;
  event_key: string | null;
  event: string;
  reason: string;
  decision: string | null;
  clef_decision: string | null;
  p_action: number | null;
  p_dup: number | null;
  q_when: QWhen | null;
  sampled_full_decision: string | null;
  sampled_full_p_action: number | null;
  sampled_full_q_when: QWhen | null;
  /** Row written when CLEF_SKIP_PAGE_CREATED_LIVE=1 actually skipped (duplicate of a wake-path row). */
  live_skip: boolean;
  /** Optional masked annotations an exporter may add (joined from other streams). */
  author_kind: string | null;
  needs_john: boolean | null;
  sensitive: boolean | null;
};

export type ParseResult = { rows: ReplayRow[]; skippedLines: number; otherStreams: number };

export type VariantName = "current" | "variant1" | "variant2" | "option1";

/** variant1: also skip p_action <= 0.05 && q_when = ignore. variant2: same at p_action <= 0.3. */
export const VARIANT_P_ACTION_MAX: Readonly<Record<"variant1" | "variant2", number>> = {
  variant1: 0.05,
  variant2: 0.3,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function qWhen(v: unknown): QWhen | null {
  return v === "now" || v === "batch" || v === "ignore" ? v : null;
}

/** Masked ids only: anything not `opaque:<hash>` is replaced so a raw id never reaches output. */
export function maskedId(v: unknown): string {
  const s = str(v);
  return s !== null && /^opaque:[A-Za-z0-9_-]+$/.test(s) ? s : "[unmasked]";
}

function maskedKey(v: unknown): string | null {
  const s = str(v);
  if (s === null) return null;
  return /^[A-Za-z0-9:_-]{1,128}$/.test(s) ? s : "[unmasked]";
}

function isClefRow(o: Record<string, unknown>): boolean {
  return o.stream === "clef_wake_shadow" || (o.stream === undefined && o.gate === "clef_wake");
}

export function toReplayRow(o: Record<string, unknown>): ReplayRow {
  const full = isRecord(o.sampled_full) ? o.sampled_full : null;
  return {
    item_id: maskedId(o.item_id),
    event_key: maskedKey(o.event_key),
    event: str(o.event) ?? "unknown",
    reason: str(o.reason) ?? "",
    decision: str(o.decision),
    clef_decision: str(o.clef_decision),
    p_action: num(o.p_action),
    p_dup: num(o.p_dup),
    q_when: qWhen(o.q_when),
    sampled_full_decision: full ? str(full.decision) : null,
    sampled_full_p_action: full ? num(full.p_action) : null,
    sampled_full_q_when: full ? qWhen(full.q_when) : null,
    live_skip: o.live_skip === true,
    author_kind: str(o.author_kind),
    needs_john: bool(o.needs_john),
    sensitive: bool(o.sensitive),
  };
}

/**
 * Accepts JSONL where each line is either one row (`{"stream":"clef_wake_shadow",…}`) or a whole
 * gate_log:v1 KV value (`{"v":1,"rows":[…]}`). Bad lines are counted, never echoed.
 */
export function parseReplayInput(text: string): ParseResult {
  const rows: ReplayRow[] = [];
  let skippedLines = 0;
  let otherStreams = 0;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      skippedLines += 1;
      continue;
    }
    if (!isRecord(parsed)) {
      skippedLines += 1;
      continue;
    }
    const batch: unknown[] = Array.isArray(parsed.rows) ? parsed.rows : [parsed];
    for (const r of batch) {
      if (!isRecord(r)) {
        skippedLines += 1;
      } else if (isClefRow(r)) {
        rows.push(toReplayRow(r));
      } else {
        otherStreams += 1;
      }
    }
  }
  return { rows, skippedLines, otherStreams };
}

export function isScored(r: ReplayRow): r is ReplayRow & { p_action: number; p_dup: number; q_when: QWhen } {
  return r.p_action !== null && r.p_dup !== null && r.q_when !== null;
}

/**
 * Option 1 applies only where the Worker would apply it: a page.created wake-path row Clef scored with
 * no fallback (reason exactly clef_ok, or clef_ok tagged by the rule itself). Mode suffixes, overrides,
 * dedupe repeats and rule-skip checks are not eligible.
 */
export function option1Eligible(r: ReplayRow): boolean {
  return (
    r.event === "page.created" &&
    r.decision !== "rule_skip" &&
    !r.live_skip &&
    (r.reason === "clef_ok" || r.reason === "clef_ok;page_created_ignore")
  );
}

/** Outcome under a variant; null when the row carries no Clef scores (override, cap, dedupe, error). */
export function variantOutcome(r: ReplayRow, variant: VariantName): string | null {
  if (!isScored(r)) return null;
  const base = decideClefOutcome(r.p_action, r.p_dup, r.q_when);
  if (variant === "current") return base;
  if (variant === "option1") {
    return option1Eligible(r) ? decideClefOutcomeForEvent(r.p_action, r.p_dup, r.q_when, r.event) : base;
  }
  if (r.p_action <= VARIANT_P_ACTION_MAX[variant] && r.q_when === "ignore") return "would_skip";
  return base;
}

/** First `;` segment; error detail (exception names) collapsed so buckets stay small. */
export function reasonBucket(reason: string): string {
  const head = reason.split(";")[0] ?? "";
  if (head.startsWith("rule_skip:error:")) return "rule_skip:error";
  if (head.startsWith("error:")) return "error";
  return head === "" ? "(none)" : head;
}

export type GroupStat = {
  event: string;
  bucket: string;
  rows: number;
  scored: number;
  logged_skip: number;
  skip: Record<VariantName, number>;
};

export type SuspiciousRow = {
  item_id: string;
  event_key: string | null;
  event: string;
  bucket: string;
  variants: VariantName[];
  why: string[];
};

/** Option 1 on page.created rows (the small test before the canary). */
export type Option1Summary = {
  page_created_rows: number;
  page_created_scored: number;
  eligible: number;
  would_skip: number;
  /** Would-skips the Worker would actually skip live: no sampled full model, or the full model agrees. */
  live_skip: number;
  full_sampled_among_skips: number;
  /** Sampled full model said would_wake on a flash would-skip (kept awake live; a disagreement to grade). */
  full_model_wakes_among_skips: number;
  /** Would-skips carrying a Needs John / Sensitive / John signal (must be 0). */
  needs_john_or_sensitive_skips: number;
  /** live_skip rows found in the input (CLEF_SKIP_PAGE_CREATED_LIVE=1 was on); not counted above. */
  live_skip_rows_in_input: number;
};

export type ReplayReport = {
  total: number;
  scored: number;
  /** Rows whose logged clef_decision differs from decideClefOutcome today (only rows Clef decided). */
  baseline_mismatch: number;
  groups: GroupStat[];
  totals: Record<VariantName, number>;
  suspicious: SuspiciousRow[];
  option1: Option1Summary;
};

const VARIANTS: VariantName[] = ["current", "variant1", "variant2", "option1"];

function fullAgreesWithSkip(r: ReplayRow): boolean {
  if (r.sampled_full_decision === null) return true;
  if (r.sampled_full_p_action !== null && r.sampled_full_q_when !== null) {
    return decideClefOutcomeForEvent(r.sampled_full_p_action, 0, r.sampled_full_q_when, r.event) === "would_skip";
  }
  return r.sampled_full_decision === "would_skip";
}
const SUSPICIOUS_REASON = /needs_john|sensitive|john_authored|john_mention|john_comment/;

export function suspicionReasons(r: ReplayRow): string[] {
  const why: string[] = [];
  if (r.needs_john === true) why.push("needs_john");
  if (r.sensitive === true) why.push("sensitive");
  if (r.author_kind === "john") why.push("author_john");
  const m = SUSPICIOUS_REASON.exec(r.reason);
  if (m) why.push(`reason:${m[0]}`);
  if (r.sampled_full_decision === "would_wake") why.push("sampled_full_wake");
  return why;
}

function loggedByClef(r: ReplayRow): boolean {
  return r.decision !== "rule_skip" && /(^|;)clef_ok($|;)/.test(r.reason);
}

export function replay(rows: ReplayRow[]): ReplayReport {
  const groups = new Map<string, GroupStat>();
  const totals: Record<VariantName, number> = { current: 0, variant1: 0, variant2: 0, option1: 0 };
  const suspicious: SuspiciousRow[] = [];
  const o1: Option1Summary = {
    page_created_rows: 0, page_created_scored: 0, eligible: 0, would_skip: 0, live_skip: 0,
    full_sampled_among_skips: 0, full_model_wakes_among_skips: 0, needs_john_or_sensitive_skips: 0,
    live_skip_rows_in_input: 0,
  };
  let scored = 0;
  let mismatch = 0;
  for (const r of rows) {
    if (r.live_skip) {
      // Second row for an event already counted by its wake-path row.
      o1.live_skip_rows_in_input += 1;
      continue;
    }
    if (r.event === "page.created") {
      o1.page_created_rows += 1;
      if (isScored(r)) o1.page_created_scored += 1;
      if (isScored(r) && option1Eligible(r)) o1.eligible += 1;
      if (variantOutcome(r, "option1") === "would_skip" && option1Eligible(r)) {
        o1.would_skip += 1;
        if (r.sampled_full_decision !== null) o1.full_sampled_among_skips += 1;
        if (r.sampled_full_decision === "would_wake") o1.full_model_wakes_among_skips += 1;
        if (fullAgreesWithSkip(r)) o1.live_skip += 1;
        if (suspicionReasons(r).some((w) => w !== "sampled_full_wake")) o1.needs_john_or_sensitive_skips += 1;
      }
    }
    const bucket = reasonBucket(r.reason);
    const key = `${r.event}\u0000${bucket}`;
    let g = groups.get(key);
    if (!g) {
      g = { event: r.event, bucket, rows: 0, scored: 0, logged_skip: 0, skip: { current: 0, variant1: 0, variant2: 0, option1: 0 } };
      groups.set(key, g);
    }
    g.rows += 1;
    if (r.clef_decision === "would_skip") g.logged_skip += 1;
    if (!isScored(r)) continue;
    scored += 1;
    g.scored += 1;
    if (
      loggedByClef(r) &&
      r.clef_decision !== variantOutcome(r, "current") &&
      r.clef_decision !== variantOutcome(r, "option1")
    ) {
      mismatch += 1;
    }
    const skipped: VariantName[] = [];
    for (const v of VARIANTS) {
      if (variantOutcome(r, v) === "would_skip") {
        g.skip[v] += 1;
        totals[v] += 1;
        skipped.push(v);
      }
    }
    const why = skipped.length > 0 ? suspicionReasons(r) : [];
    if (why.length > 0) {
      suspicious.push({ item_id: r.item_id, event_key: r.event_key, event: r.event, bucket, variants: skipped, why });
    }
  }
  const sorted = [...groups.values()].sort((a, b) => a.event.localeCompare(b.event) || b.rows - a.rows);
  return { total: rows.length, scored, baseline_mismatch: mismatch, groups: sorted, totals, suspicious, option1: o1 };
}

function rate(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`;
}

export function formatReport(rep: ReplayReport, meta: { skippedLines?: number; otherStreams?: number } = {}): string {
  const out: string[] = [];
  out.push(`clef_wake_shadow rows: ${rep.total} (scored ${rep.scored}); skipped lines ${meta.skippedLines ?? 0}; other streams ${meta.otherStreams ?? 0}`);
  out.push(`baseline mismatches (logged clef_decision vs decideClefOutcome / Option 1): ${rep.baseline_mismatch}`);
  out.push("variant1 = current + (p_action<=0.05 && q_when=ignore ⇒ skip); variant2 = current + (p_action<=0.3 && q_when=ignore ⇒ skip)");
  out.push("option1 = the shipped rule: variant1 on eligible page.created wake-path rows only (reason clef_ok, no fallback)");
  out.push("rates are would-skips / scored rows in the group");
  out.push("");
  const header = ["event", "reason_bucket", "rows", "scored", "logged_skip", "cur_skip", "cur_rate", "v1_skip", "v1_rate", "v2_skip", "v2_rate", "o1_skip", "o1_rate"];
  const lines: string[][] = [header];
  for (const g of rep.groups) {
    lines.push([
      g.event,
      g.bucket,
      String(g.rows),
      String(g.scored),
      String(g.logged_skip),
      String(g.skip.current),
      rate(g.skip.current, g.scored),
      String(g.skip.variant1),
      rate(g.skip.variant1, g.scored),
      String(g.skip.variant2),
      rate(g.skip.variant2, g.scored),
      String(g.skip.option1),
      rate(g.skip.option1, g.scored),
    ]);
  }
  lines.push([
    "TOTAL",
    "",
    String(rep.total),
    String(rep.scored),
    String(rep.groups.reduce((s, g) => s + g.logged_skip, 0)),
    String(rep.totals.current),
    rate(rep.totals.current, rep.scored),
    String(rep.totals.variant1),
    rate(rep.totals.variant1, rep.scored),
    String(rep.totals.variant2),
    rate(rep.totals.variant2, rep.scored),
    String(rep.totals.option1),
    rate(rep.totals.option1, rep.scored),
  ]);
  const widths = header.map((_, i) => Math.max(...lines.map((l) => (l[i] ?? "").length)));
  for (const l of lines) out.push(l.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd());
  out.push("");
  const o = rep.option1;
  out.push(
    `option1 page.created: rows ${o.page_created_rows}, scored ${o.page_created_scored}, eligible ${o.eligible}, would_skip ${o.would_skip}, live_skip (full agrees or unsampled) ${o.live_skip}`,
  );
  out.push(
    `option1 page.created: full sampled among skips ${o.full_sampled_among_skips}, full-model wakes among skips ${o.full_model_wakes_among_skips}, needs_john/sensitive skips ${o.needs_john_or_sensitive_skips}, live_skip rows in input ${o.live_skip_rows_in_input}`,
  );
  out.push("");
  out.push(`suspicious would-skips: ${rep.suspicious.length}`);
  for (const s of rep.suspicious) {
    out.push(`  ${s.item_id}  event_key=${s.event_key ?? "-"}  ${s.event}  ${s.bucket}  variants=${s.variants.join(",")}  why=${s.why.join(",")}`);
  }
  return out.join("\n");
}
