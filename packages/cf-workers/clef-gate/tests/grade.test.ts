import { describe, expect, test } from "bun:test";
import { ERROR_RATE_MAX, gradeWindow } from "../src/grade.js";
import type { EmailShadowLogEntry } from "../src/shadow.js";

let n = 0;
function row(over: Partial<EmailShadowLogEntry>): EmailShadowLogEntry {
  n += 1;
  return {
    event: "decision", ts: "2026-10-14T12:00:00Z", msg_id_hash: `h${n}`, shadow_label: "escalate",
    error_reason: null, triage_disposition: "archive_fyi", triage_escalated: false, triage_rescued: false,
    false_skip: false, ...over,
  } as EmailShadowLogEntry;
}

describe("gradeWindow", () => {
  test("clean window passes; error rate reported per day", () => {
    const rows = [...Array.from({ length: 99 }, () => row({})), row({ shadow_label: "error", error_reason: "clef_timeout" })];
    const g = gradeWindow(rows);
    expect(ERROR_RATE_MAX).toBe(0.02);
    expect(g.days).toEqual([{ day: "2026-10-14", decided: 100, errors: 1, error_rate: 0.01, over_threshold: false }]);
    expect(g.pass).toBe(true);
  });
  test("error rate above 2% on any day fails", () => {
    const rows = [
      ...Array.from({ length: 10 }, () => row({ ts: "2026-10-13T01:00:00Z" })),
      ...Array.from({ length: 97 }, () => row({})),
      ...Array.from({ length: 3 }, () => row({ shadow_label: "error", error_reason: "clef_error:AiGatewayError" })),
    ];
    const g = gradeWindow(rows);
    expect(g.pass).toBe(false);
    expect(g.fail_reasons).toEqual(["error_rate_over_threshold"]);
    expect(g.days.find((d) => d.day === "2026-10-14")?.error_rate).toBeCloseTo(0.03);
  });
  test("any gateway-unset / AI-unbound row fails, even under the rate", () => {
    const rows = [...Array.from({ length: 200 }, () => row({})), row({ shadow_label: "error", error_reason: "clef_gateway_unset" })];
    expect(gradeWindow(rows).fail_reasons).toEqual(["config_error"]);
    const r2 = [...Array.from({ length: 200 }, () => row({})), row({ shadow_label: "error", error_reason: "clef_ai_unbound" })];
    expect(gradeWindow(r2).config_errors).toBe(1);
  });
  test("error rows whose triage acted are listed as unmeasured wakes; false skip fails", () => {
    const acted = row({ shadow_label: "error", error_reason: "clef_timeout", triage_disposition: "escalate_john", triage_escalated: true });
    const handoff = row({ shadow_label: "error", error_reason: "clef_timeout", triage_disposition: "handoff_lane" });
    const notActed = row({ shadow_label: "error", error_reason: "clef_timeout", triage_disposition: "spam" });
    const fs = row({ shadow_label: "would_skip", false_skip: true });
    const g = gradeWindow([acted, handoff, notActed, fs, ...Array.from({ length: 300 }, () => row({}))]);
    expect(g.unmeasured_wakes).toEqual([acted.msg_id_hash as string, handoff.msg_id_hash as string]);
    expect(g.false_skips).toBe(1);
    expect(g.fail_reasons).toContain("false_skip");
  });
  test("pending rows (no label) are ignored", () => {
    expect(gradeWindow([row({ shadow_label: null })]).days).toEqual([]);
  });
});

import { liveActionLabel } from "../src/clef-email.js";
test("live guard: error fails open to escalate", () => {
  expect(liveActionLabel("error")).toBe("escalate");
  expect(liveActionLabel("would_skip")).toBe("would_skip");
});
