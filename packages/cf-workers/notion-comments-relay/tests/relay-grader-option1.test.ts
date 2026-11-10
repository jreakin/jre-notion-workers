/**
 * Pins gradeRelayWindow for PR B (unchanged grader): sampled echo-filter disagreements are false skips
 * (John's conservative choice: one resets the window), and Option 1 rows are graded as plain Clef calls.
 * Rows are synthetic, masked (opaque ids) and fake.
 */
import { describe, expect, test } from "bun:test";
import { gradeRelayWindow } from "../src/wake-gate/grade-relay.js";

const TS = "2026-11-09T12:00:00.000Z";

function echoCheck(over: Record<string, unknown>): Record<string, unknown> {
  return {
    stream: "clef_wake_shadow", ts: TS, gate: "clef_wake", source: "echo_filter", decision: "rule_skip",
    event: "comment.created", event_key: "opaque:e1", item_id: "opaque:i1", rule_decision: "would_skip",
    mode: "deterministic", actually_ran: "echo_filter", echo_reason: "own_echo", ...over,
  };
}

describe("gradeRelayWindow: echo-filter skips (conservative, unchanged)", () => {
  test("a sampled echo-filter disagreement (Clef would_wake) is a false_skip and fails the window", () => {
    for (const echo_reason of ["own_echo", "agent_prefix", "untracked_property_edit"]) {
      const g = gradeRelayWindow([
        echoCheck({ echo_reason, reason: `rule_skip:${echo_reason}`, scored: false, candidate_false_skip: false }),
        echoCheck({ echo_reason, reason: "rule_skip:clef_ok", scored: true, candidate_false_skip: true, clef_decision: "would_wake" }),
      ]);
      expect(g.false_skips).toBe(1);
      expect(g.pass).toBe(false);
      expect(g.fail_reasons).toContain("false_skip");
    }
  });

  test("a sampled echo-filter agreement passes", () => {
    const g = gradeRelayWindow([
      echoCheck({ reason: "rule_skip:clef_ok", scored: true, candidate_false_skip: false, clef_decision: "would_skip" }),
    ]);
    expect(g.false_skips).toBe(0);
    expect(g.pass).toBe(true);
  });
});

describe("gradeRelayWindow: Option 1 page.created rows", () => {
  const wakePath = {
    stream: "clef_wake_shadow", ts: TS, gate: "clef_wake", item_id: "opaque:p1", event_key: "opaque:e2", event: "page.created",
    rule_decision: "would_wake", clef_decision: "would_skip", p_action: 0.02, p_dup: 0.1, q_when: "ignore",
    mode: "shadow", actually_ran: "coalesce_enqueued", reason: "clef_ok;page_created_ignore", page_created_rule: "would_skip",
  };
  test("the tagged wake-path row counts as one Clef call; the live_skip row is not a second call", () => {
    const g = gradeRelayWindow([
      wakePath,
      { ...wakePath, actually_ran: "clef_live_skipped", mode: "live", reason: "clef_live_skip:page_created_ignore", live_skip: true },
    ]);
    expect(g.days).toEqual([{ day: "2026-11-09", clef_calls: 1, clef_errors: 0, error_rate: 0, over_threshold: false }]);
    expect(g.false_skips).toBe(0);
    expect(g.pass).toBe(true);
  });
});
