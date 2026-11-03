/**
 * Offline replay, Mode A (no AI): re-decide exported clef_wake_shadow rows with the live
 * decideClefOutcome and two candidate skip variants. Pure functions; no I/O.
 *
 * Input rows are masked exports (Steward/BCH, from gate_log:v1 KV values). Only the fields below are
 * read; everything else (and any free text) is ignored, so titles or content can never reach output.
 */
import { decideClefOutcome } from "../../src/wake-gate/clef-decision-logic.js";

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
  /** Optional masked annotations an exporter may add (joined from other streams). */
  author_kind: string | null;
  needs_john: boolean | null;
  sensitive: boolean | null;
};

export type ParseResult = { rows: ReplayRow[]; skippedLines: number; otherStreams: number };

export type VariantName = "current" | "variant1" | "variant2";

/** variant1: also skip p_action <= 0.05 && q_when = ignore. variant2: same at p_action <= 0.3. */
export const VARIANT_P_ACTION_MAX: Readonly<Record<Exclude<VariantName, "current">, number>> = {
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

/** Outcome under a variant; null when the row carries no Clef scores (override, cap, dedupe, error). */
export function variantOutcome(r: ReplayRow, variant: VariantName): string | null {
  if (!isScored(r)) return null;
  const base = decideClefOutcome(r.p_action, r.p_dup, r.q_when);
  if (variant === "current") return base;
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

export type ReplayReport = {
  total: number;
  scored: number;
  /** Rows whose logged clef_decision differs from decideClefOutcome today (only rows Clef decided). */
  baseline_mismatch: number;
  groups: GroupStat[];
  totals: Record<VariantName, number>;
  suspicious: SuspiciousRow[];
};

const VARIANTS: VariantName[] = ["current", "variant1", "variant2"];
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
  const totals: Record<VariantName, number> = { current: 0, variant1: 0, variant2: 0 };
  const suspicious: SuspiciousRow[] = [];
  let scored = 0;
  let mismatch = 0;
  for (const r of rows) {
    const bucket = reasonBucket(r.reason);
    const key = `${r.event}\u0000${bucket}`;
    let g = groups.get(key);
    if (!g) {
      g = { event: r.event, bucket, rows: 0, scored: 0, logged_skip: 0, skip: { current: 0, variant1: 0, variant2: 0 } };
      groups.set(key, g);
    }
    g.rows += 1;
    if (r.clef_decision === "would_skip") g.logged_skip += 1;
    if (!isScored(r)) continue;
    scored += 1;
    g.scored += 1;
    if (loggedByClef(r) && r.clef_decision !== variantOutcome(r, "current")) mismatch += 1;
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
  return { total: rows.length, scored, baseline_mismatch: mismatch, groups: sorted, totals, suspicious };
}

function rate(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`;
}

export function formatReport(rep: ReplayReport, meta: { skippedLines?: number; otherStreams?: number } = {}): string {
  const out: string[] = [];
  out.push(`clef_wake_shadow rows: ${rep.total} (scored ${rep.scored}); skipped lines ${meta.skippedLines ?? 0}; other streams ${meta.otherStreams ?? 0}`);
  out.push(`baseline mismatches (logged clef_decision vs decideClefOutcome today): ${rep.baseline_mismatch}`);
  out.push("variant1 = current + (p_action<=0.05 && q_when=ignore ⇒ skip); variant2 = current + (p_action<=0.3 && q_when=ignore ⇒ skip)");
  out.push("rates are would-skips / scored rows in the group");
  out.push("");
  const header = ["event", "reason_bucket", "rows", "scored", "logged_skip", "cur_skip", "cur_rate", "v1_skip", "v1_rate", "v2_skip", "v2_rate"];
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
  ]);
  const widths = header.map((_, i) => Math.max(...lines.map((l) => (l[i] ?? "").length)));
  for (const l of lines) out.push(l.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd());
  out.push("");
  out.push(`suspicious would-skips: ${rep.suspicious.length}`);
  for (const s of rep.suspicious) {
    out.push(`  ${s.item_id}  event_key=${s.event_key ?? "-"}  ${s.event}  ${s.bucket}  variants=${s.variants.join(",")}  why=${s.why.join(",")}`);
  }
  return out.join("\n");
}
