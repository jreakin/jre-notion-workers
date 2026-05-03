/**
 * Canonical Agent Ops "Run Status" select values.
 *
 * These strings MUST match Notion select options exactly. Do not change
 * casing or punctuation without updating the database schema first.
 */
import type { StatusType, StatusValue } from "./types.js";

export const RUN_STATUS = {
  COMPLETE: "✅ Complete",
  HEARTBEAT: "Heartbeat",
  PARTIAL: "⚠️ Partial",
  FAILED: "❌ Failed",
} as const;

export type RunStatus = (typeof RUN_STATUS)[keyof typeof RUN_STATUS];

export const VALID_RUN_STATUSES: ReadonlyArray<RunStatus> = [
  RUN_STATUS.COMPLETE,
  RUN_STATUS.HEARTBEAT,
  RUN_STATUS.PARTIAL,
  RUN_STATUS.FAILED,
];

/**
 * Map a (status_type, status_value) pair from the existing digest schema to a
 * canonical Run Status value for Agent Ops writes.
 *
 * Heartbeat status_type always maps to "Heartbeat". Otherwise the status_value
 * drives mapping: complete/full_report -> Complete, partial/stub -> Partial,
 * failed -> Failed.
 */
export function mapToRunStatus(statusType: StatusType, statusValue: StatusValue): RunStatus {
  if (statusType === "heartbeat") return RUN_STATUS.HEARTBEAT;
  switch (statusValue) {
    case "complete":
    case "full_report":
      return RUN_STATUS.COMPLETE;
    case "partial":
    case "stub":
      return RUN_STATUS.PARTIAL;
    case "failed":
      return RUN_STATUS.FAILED;
  }
}

/**
 * Normalize an arbitrary stored status string (from a stale or pre-migration
 * row) to a canonical Run Status. Returns null if it cannot be mapped
 * confidently. Callers should treat null as "needs manual review".
 */
export function normalizeStoredStatus(raw: string | null | undefined): RunStatus | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;

  // Already canonical
  if ((VALID_RUN_STATUSES as readonly string[]).includes(s)) return s as RunStatus;

  const lower = s.toLowerCase();
  if (lower.includes("heartbeat")) return RUN_STATUS.HEARTBEAT;
  if (s.includes("✅") || lower === "complete" || lower === "ok" || lower === "success") {
    return RUN_STATUS.COMPLETE;
  }
  if (s.includes("⚠️") || s.includes("⚠") || lower === "partial" || lower.startsWith("warn")) {
    return RUN_STATUS.PARTIAL;
  }
  if (s.includes("❌") || lower === "failed" || lower === "fail" || lower === "error") {
    return RUN_STATUS.FAILED;
  }
  return null;
}

/**
 * True if the given status string is exactly canonical. Used by drift checkers.
 */
export function isCanonicalRunStatus(s: string): s is RunStatus {
  return (VALID_RUN_STATUSES as readonly string[]).includes(s);
}
