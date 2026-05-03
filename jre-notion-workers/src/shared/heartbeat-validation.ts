/**
 * Heartbeat validation.
 *
 * A heartbeat-shaped run says "no actionable items" — by definition it cannot
 * also be Partial or Failed. If a caller produces such a contradiction we
 * coerce the run to a heartbeat (Complete + heartbeat status type) and
 * surface a structured warning so the publishing layer can log it.
 */
import type { ActionsTaken, FlaggedItem, Escalation, NeedsReview, StatusType, StatusValue } from "./types.js";

export interface HeartbeatShape {
  flagged_items?: FlaggedItem[];
  needs_review?: NeedsReview[];
  escalations?: Escalation[];
  actions_taken?: ActionsTaken;
}

export interface HeartbeatValidation {
  is_heartbeat_shape: boolean;
  status_type: StatusType;
  status_value: StatusValue;
  /** True if the caller's declared status was inconsistent with heartbeat shape. */
  coerced: boolean;
  warnings: string[];
}

/**
 * A run is heartbeat-shaped when there is nothing actionable: no flagged
 * items, no needs_review, no escalations, and no created/updated/auto-closed
 * tasks.
 */
export function isHeartbeatShape(shape: HeartbeatShape): boolean {
  const flagged = shape.flagged_items ?? [];
  const needs = shape.needs_review ?? [];
  const esc = shape.escalations ?? [];
  const actions = shape.actions_taken ?? { created_tasks: [], updated_tasks: [] };
  const created = actions.created_tasks ?? [];
  const updated = actions.updated_tasks ?? [];
  const auto = actions.auto_closed_by_pr ?? [];
  return (
    flagged.length === 0 &&
    needs.length === 0 &&
    esc.length === 0 &&
    created.length === 0 &&
    updated.length === 0 &&
    auto.length === 0
  );
}

/**
 * Validate (and if necessary, coerce) the declared status against the shape.
 *
 * - If declared status_type === "heartbeat" but shape has actionable items,
 *   the run is NOT a heartbeat. Coerce to the appropriate non-heartbeat type.
 * - If shape is heartbeat but declared status_value is partial/failed, coerce
 *   to status_value=complete and status_type=heartbeat.
 * - Otherwise pass through.
 */
export function validateHeartbeat(
  shape: HeartbeatShape,
  declaredStatusType: StatusType,
  declaredStatusValue: StatusValue
): HeartbeatValidation {
  const warnings: string[] = [];
  const heartbeatShape = isHeartbeatShape(shape);

  if (declaredStatusType === "heartbeat" && !heartbeatShape) {
    warnings.push(
      "Declared status_type=heartbeat but run has actionable items (flagged/needs_review/escalations/actions). Coerced to sync."
    );
    return {
      is_heartbeat_shape: false,
      status_type: "sync",
      status_value: declaredStatusValue,
      coerced: true,
      warnings,
    };
  }

  if (heartbeatShape && (declaredStatusValue === "partial" || declaredStatusValue === "failed")) {
    warnings.push(
      `Run reports no actionable items but status_value=${declaredStatusValue}. Coerced to heartbeat (Complete).`
    );
    return {
      is_heartbeat_shape: true,
      status_type: "heartbeat",
      status_value: "complete",
      coerced: true,
      warnings,
    };
  }

  return {
    is_heartbeat_shape: heartbeatShape,
    status_type: declaredStatusType,
    status_value: declaredStatusValue,
    coerced: false,
    warnings,
  };
}
