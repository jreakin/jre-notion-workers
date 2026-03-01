import { describe, expect, it } from "bun:test";
import {
  parseStatusLine,
  parseRunTime,
  hasHeartbeatLine,
  buildStatusLine,
} from "../../../src/shared/status-parser.js";
import { STATUS_LINE_EVALS } from "../../evals/status-lines.eval.js";

describe("parseStatusLine", () => {
  it("parses sync complete", () => {
    const result = parseStatusLine([
      "Sync Status: ✅ Complete",
      "Run Time: 2026-02-28 09:00 (America/Chicago)",
    ]);
    expect(result).toEqual({
      status_type: "sync",
      status_value: "complete",
      raw_line: "Sync Status: ✅ Complete",
    });
  });

  it("returns null when no status line in first 10 lines", () => {
    expect(parseStatusLine(["Just some content", "No status here"])).toBeNull();
  });

  it("handles empty array", () => {
    expect(parseStatusLine([])).toBeNull();
  });

  for (const { lines, expected } of STATUS_LINE_EVALS) {
    it(`eval: ${lines[0] ?? "(empty)"}`, () => {
      const result = parseStatusLine(lines);
      if (expected === null) {
        expect(result).toBeNull();
      } else {
        expect(result).toMatchObject(expected);
      }
    });
  }
});

describe("parseRunTime", () => {
  it("finds Run Time line", () => {
    const result = parseRunTime([
      "Sync Status: ✅ Complete",
      "Run Time: 2026-02-28 09:00 (America/Chicago)",
    ]);
    expect(result).toBe("2026-02-28 09:00 (America/Chicago)");
  });

  it("returns null when not in first 10 lines", () => {
    expect(parseRunTime(["Line 1", "Line 2"])).toBeNull();
  });
});

describe("hasHeartbeatLine", () => {
  it("returns true when heartbeat string present", () => {
    expect(hasHeartbeatLine(["Heartbeat: no actionable items"])).toBe(true);
  });
  it("returns false when absent", () => {
    expect(hasHeartbeatLine(["Sync Status: ✅ Complete"])).toBe(false);
  });
});

describe("buildStatusLine", () => {
  it("formats sync complete", () => {
    expect(buildStatusLine("sync", "complete")).toBe("Sync Status: ✅ Complete");
  });
  it("formats report stub", () => {
    expect(buildStatusLine("report", "stub")).toBe("Report Status: ⚠️ Stub");
  });
  it("formats heartbeat as sync complete", () => {
    expect(buildStatusLine("heartbeat", "complete")).toBe("Sync Status: ✅ Complete");
  });
});
