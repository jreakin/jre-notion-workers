/**
 * Shared input/output contracts for every worker.
 *
 * RECOVERED SOURCE — the compiled dist/shared/types.js is 124 bytes because
 * TypeScript erases type-only modules. These declarations are reconstructed
 * from the tool registration schemas in dist/index.js and from each worker's
 * observed property access. See docs/ADR/0005-orphan-dist.md.
 */

/* ── Cross-cutting ─────────────────────────────────────────────────── */

/**
 * Digest destinations. NOTE: the canonical generation added "agent_ops",
 * which the pre-migration tree does not have.
 */
export type TargetDatabase = "docs" | "home_docs" | "agent_ops";

export type StatusType = "sync" | "snapshot" | "report" | "heartbeat";

export type StatusValue =
  | "complete"
  | "partial"
  | "failed"
  | "full_report"
  | "stub";

export type TaskPriority = "🔴 High" | "🟡 Medium" | "🟢 Low";
