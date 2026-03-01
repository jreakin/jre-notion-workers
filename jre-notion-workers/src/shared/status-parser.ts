/**
 * Parse status lines and Run Time from digest page content (first 10 lines).
 */
import type { StatusType, StatusValue } from "./types.js";

export interface ParsedStatus {
  status_type: StatusType;
  status_value: StatusValue;
  raw_line: string;
}

const STATUS_PREFIXES = ["Sync Status:", "Snapshot Status:", "Report Status:"] as const;
const EMOJI_MAP: Record<string, StatusValue> = {
  "✅": "complete",
  "⚠️": "partial",
  "❌": "failed",
};

function statusPrefixToType(prefix: string): StatusType {
  if (prefix.startsWith("Sync")) return "sync";
  if (prefix.startsWith("Snapshot")) return "snapshot";
  if (prefix.startsWith("Report")) return "report";
  return "sync";
}

/**
 * Scan first 10 lines for Sync Status / Snapshot Status / Report Status and parse value from emoji.
 */
export function parseStatusLine(lines: string[]): ParsedStatus | null {
  const slice = lines.slice(0, 10);
  for (const line of slice) {
    const trimmed = line.trim();
    for (const prefix of STATUS_PREFIXES) {
      if (trimmed.startsWith(prefix)) {
        const rest = trimmed.slice(prefix.length).trim();
        // Map first emoji to status_value; default to "complete" for ✅
        let status_value: StatusValue = "complete";
        if (rest.startsWith("⚠️")) status_value = "partial";
        else if (rest.startsWith("❌")) status_value = "failed";
        else if (rest.toLowerCase().includes("stub")) status_value = "stub";
        else if (rest.toLowerCase().includes("full")) status_value = "full_report";
        return {
          status_type: statusPrefixToType(prefix),
          status_value,
          raw_line: trimmed,
        };
      }
    }
  }
  return null;
}

/**
 * Find Run Time: YYYY-MM-DD HH:mm (America/Chicago) and return ISO-ish string for parsing.
 */
export function parseRunTime(lines: string[]): string | null {
  const slice = lines.slice(0, 10);
  for (const line of slice) {
    const trimmed = line.trim();
    if (trimmed.startsWith("Run Time:")) {
      const value = trimmed.slice("Run Time:".length).trim();
      return value || null;
    }
  }
  return null;
}

/**
 * Check if content contains the exact heartbeat string.
 */
export function hasHeartbeatLine(lines: string[]): boolean {
  return lines.some((l) => l.includes("Heartbeat: no actionable items"));
}

/** Build status line string for write-agent-digest. */
export function buildStatusLine(statusType: StatusType, statusValue: StatusValue): string {
  if (statusType === "heartbeat") {
    return "Sync Status: ✅ Complete";
  }
  const emoji = statusValue === "complete" || statusValue === "full_report" ? "✅" : statusValue === "partial" || statusValue === "stub" ? "⚠️" : "❌";
  const label =
    statusType === "sync"
      ? "Sync Status"
      : statusType === "snapshot"
        ? "Snapshot Status"
        : "Report Status";
  const value =
    statusType === "sync"
      ? statusValue === "complete"
        ? "Complete"
        : statusValue === "partial"
          ? "Partial"
          : "Failed"
      : statusType === "snapshot"
        ? statusValue === "complete"
          ? "Complete"
          : "Partial"
        : statusValue === "full_report"
          ? "Full report"
          : statusValue === "stub"
            ? "Stub"
            : "Failed";
  return `${label}: ${emoji} ${value}`;
}
