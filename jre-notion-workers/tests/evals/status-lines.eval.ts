/**
 * Golden input/output pairs for status line parsing.
 */
import type { ParsedStatus } from "../../src/shared/status-parser.js";

export const STATUS_LINE_EVALS: Array<{ lines: string[]; expected: ParsedStatus | null }> = [
  {
    lines: ["Sync Status: ✅ Complete", "Run Time: 2026-02-28 09:00 (America/Chicago)"],
    expected: { status_type: "sync", status_value: "complete", raw_line: "Sync Status: ✅ Complete" },
  },
  {
    lines: ["Snapshot Status: ⚠️ Partial"],
    expected: { status_type: "snapshot", status_value: "partial", raw_line: "Snapshot Status: ⚠️ Partial" },
  },
  {
    lines: ["Report Status: ❌ Failed"],
    expected: { status_type: "report", status_value: "failed", raw_line: "Report Status: ❌ Failed" },
  },
  {
    lines: ["Report Status: ✅ Full report"],
    expected: { status_type: "report", status_value: "full_report", raw_line: "Report Status: ✅ Full report" },
  },
  {
    lines: ["Heartbeat: no actionable items"],
    expected: null,
  },
  {
    lines: [],
    expected: null,
  },
  {
    lines: ["Just some content", "No status here"],
    expected: null,
  },
];
