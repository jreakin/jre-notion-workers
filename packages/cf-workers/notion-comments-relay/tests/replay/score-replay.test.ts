/** Mode A replay (no AI): variants, buckets, suspicious list, masking. Rows are synthetic and fake. */
import { describe, expect, test } from "bun:test";
import { formatReport, maskedId, parseReplayInput, reasonBucket, replay, variantOutcome, type ReplayRow } from "./replay-lib.js";

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stream: "clef_wake_shadow",
    ts: "2026-11-01T00:00:00.000Z",
    gate: "clef_wake",
    item_id: "opaque:aaaa1111",
    event_key: "opaque:ev0001",
    source: "notion_page",
    event: "page.created",
    rule_decision: "would_wake",
    clef_decision: "would_batch",
    p_action: 0.02,
    p_dup: 0.1,
    q_when: "ignore",
    confidence: 0.9,
    model: "fake-model",
    latency_ms: 10,
    sampled_full: null,
    mode: "shadow",
    actually_ran: "rules",
    reason: "clef_ok",
    ...over,
  };
}

function jsonl(rows: Record<string, unknown>[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n");
}

function one(over: Record<string, unknown>): ReplayRow {
  const r = parseReplayInput(JSON.stringify(row(over))).rows[0];
  if (!r) throw new Error("no row");
  return r;
}

describe("replay Mode A", () => {
  test("current matches decideClefOutcome; variants only add ignore-skips under their p_action max", () => {
    expect(variantOutcome(one({}), "current")).toBe("would_batch");
    expect(variantOutcome(one({}), "variant1")).toBe("would_skip");
    expect(variantOutcome(one({}), "variant2")).toBe("would_skip");

    const mid = one({ p_action: 0.2 });
    expect(variantOutcome(mid, "variant1")).toBe("would_batch");
    expect(variantOutcome(mid, "variant2")).toBe("would_skip");

    const high = one({ p_action: 0.31 });
    expect(variantOutcome(high, "variant2")).toBe("would_wake");

    const batch = one({ q_when: "batch" });
    expect(variantOutcome(batch, "variant2")).toBe("would_batch");

    const realSkip = one({ p_action: 0.01, p_dup: 0.9, q_when: "now" });
    for (const v of ["current", "variant1", "variant2"] as const) expect(variantOutcome(realSkip, v)).toBe("would_skip");

    expect(variantOutcome(one({ p_action: null, reason: "notion_fetch_failed" }), "variant2")).toBeNull();
  });

  test("table groups by event and reason bucket with counts and rates", () => {
    const input = jsonl([
      row({}),
      row({ item_id: "opaque:b2", p_action: 0.2 }),
      row({ item_id: "opaque:b3", p_action: 0.9, q_when: "now", clef_decision: "would_wake" }),
      row({ item_id: "opaque:b4", p_action: null, p_dup: null, q_when: null, reason: "notion_fetch_failed", clef_decision: "would_wake" }),
      row({ item_id: "opaque:c1", event: "comment.created", decision: "rule_skip", reason: "rule_skip:clef_ok", source: "echo_filter" }),
      row({ item_id: "opaque:c2", event: "comment.created", reason: "error:TypeError", p_action: null }),
    ]);
    const parsed = parseReplayInput(input);
    const rep = replay(parsed.rows);
    expect(rep.total).toBe(6);
    expect(rep.scored).toBe(4);
    expect(rep.baseline_mismatch).toBe(0);
    const pc = rep.groups.find((g) => g.event === "page.created" && g.bucket === "clef_ok");
    expect(pc).toEqual({
      event: "page.created",
      bucket: "clef_ok",
      rows: 3,
      scored: 3,
      logged_skip: 0,
      skip: { current: 0, variant1: 1, variant2: 2, option1: 1 },
    });
    expect(rep.groups.find((g) => g.bucket === "notion_fetch_failed")?.scored).toBe(0);
    expect(rep.groups.find((g) => g.bucket === "error")?.rows).toBe(1);
    expect(rep.totals).toEqual({ current: 0, variant1: 2, variant2: 3, option1: 1 });
    const text = formatReport(rep, parsed);
    expect(text).toContain("v1_rate");
    expect(text).toContain("66.7%");
  });

  test("baseline mismatch counts logged Clef decisions that today's rule would decide differently", () => {
    const rep = replay(parseReplayInput(jsonl([row({ clef_decision: "would_wake" })])).rows);
    expect(rep.baseline_mismatch).toBe(1);
  });

  test("suspicious: needs_john / sensitive / author john / sampled_full wake / override labels", () => {
    const rep = replay(
      parseReplayInput(
        jsonl([
          row({ item_id: "opaque:s1", needs_john: true }),
          row({ item_id: "opaque:s2", sensitive: true }),
          row({ item_id: "opaque:s3", author_kind: "john" }),
          row({ item_id: "opaque:s4", sampled_full: { decision: "would_wake", p_action: 0.7, p_dup: 0.1, q_when: "now", model: "m" } }),
          row({ item_id: "opaque:s5", reason: "clef_ok;needs_john_changed" }),
          row({ item_id: "opaque:ok" }),
          row({ item_id: "opaque:nowake", needs_john: true, p_action: 0.9, q_when: "now" }),
        ]),
      ).rows,
    );
    const ids = rep.suspicious.map((s) => s.item_id);
    expect(ids).toEqual(["opaque:s1", "opaque:s2", "opaque:s3", "opaque:s4", "opaque:s5"]);
    expect(rep.suspicious[0]?.why).toEqual(["needs_john"]);
    expect(rep.suspicious[3]?.why).toEqual(["sampled_full_wake"]);
    expect(rep.suspicious[0]?.variants).toEqual(["variant1", "variant2", "option1"]);
  });

  test("accepts gate_log:v1 KV values, skips bad lines and other streams, never echoes content", () => {
    const kvValue = JSON.stringify({
      v: 1,
      flushed_at: "2026-11-01T00:00:00.000Z",
      rows: [row({}), { stream: "wake_gate_shadow", decision: "wake" }, row({ item_id: "fa4e0000-0000-4000-8000-000000000001" })],
    });
    const parsed = parseReplayInput(`${kvValue}\nnot json SECRET-TITLE\n[1,2]\n`);
    expect(parsed.rows.length).toBe(2);
    expect(parsed.otherStreams).toBe(1);
    expect(parsed.skippedLines).toBe(2);
    expect(parsed.rows[1]?.item_id).toBe("[unmasked]");
    const out = formatReport(replay(parsed.rows), parsed);
    expect(out).not.toContain("SECRET-TITLE");
    expect(out).not.toContain("fa4e0000");
  });

  test("helpers", () => {
    expect(reasonBucket("rule_skip:error:TypeError")).toBe("rule_skip:error");
    expect(reasonBucket("john_authored;clef_mode_off")).toBe("john_authored");
    expect(reasonBucket("")).toBe("(none)");
    expect(maskedId("opaque:abc")).toBe("opaque:abc");
    expect(maskedId("raw-page-id")).toBe("[unmasked]");
  });

  test("option1: page.created eligible rows only; full-model wakes and live_skip rows reported", () => {
    const full = (decision: string, p_action: number, q_when: string) => ({ decision, p_action, p_dup: 0.1, q_when, model: "m" });
    const rep = replay(
      parseReplayInput(
        jsonl([
          row({ item_id: "opaque:o1" }),
          row({ item_id: "opaque:o2", reason: "clef_ok;page_created_ignore", clef_decision: "would_skip" }),
          row({ item_id: "opaque:o3", sampled_full: full("would_wake", 0.8, "now") }),
          row({ item_id: "opaque:o4", sampled_full: full("would_batch", 0.01, "ignore") }),
          row({ item_id: "opaque:o5", reason: "clef_ok;clef_mode_invalid" }),
          row({ item_id: "opaque:o6", event: "page.properties_updated" }),
          row({ item_id: "opaque:o7", decision: "rule_skip", reason: "rule_skip:clef_ok" }),
          row({ item_id: "opaque:o8", p_action: 0.9, q_when: "now", clef_decision: "would_wake" }),
          row({ item_id: "opaque:o2", reason: "clef_live_skip:page_created_ignore", clef_decision: "would_skip", live_skip: true }),
        ]),
      ).rows,
    );
    expect(rep.baseline_mismatch).toBe(0);
    expect(rep.option1).toEqual({
      page_created_rows: 7,
      page_created_scored: 7,
      eligible: 5,
      would_skip: 4,
      live_skip: 3,
      full_sampled_among_skips: 2,
      full_model_wakes_among_skips: 1,
      needs_john_or_sensitive_skips: 0,
      live_skip_rows_in_input: 1,
    });
    expect(variantOutcome(one({ event: "page.properties_updated" }), "option1")).toBe("would_batch");
    expect(variantOutcome(one({ needs_john: true }), "option1")).toBe("would_skip");
    const nj = replay(parseReplayInput(jsonl([row({ needs_john: true })])).rows);
    expect(nj.option1.needs_john_or_sensitive_skips).toBe(1);
  });
});
