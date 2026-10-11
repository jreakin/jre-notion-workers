import { FLEET_LOCKS_STATUS_ADOPTED, type ParsedFleetLocksFields } from "./fleet-locks-properties.js";
import { anyJohnUserId, isJohn, submittedPropertyChanged } from "./gate-context-safety.js";
import type { GateEventContext, WakeGateDecision } from "./gate-event-types.js";

const GATE_NAME = "fleet_locks_adopted_change";

function wake(gateName: string, reason: string, ctx: GateEventContext): WakeGateDecision {
  return {
    gate_name: gateName,
    decision: "would_wake",
    reason,
    inputs: {
      notion_type: ctx.notionType,
      page_id: ctx.pageId,
      fleet_locks_parent: ctx.fleetLocksParentKnown,
    },
    ts: new Date().toISOString(),
    mode: "shadow",
  };
}

function skip(gateName: string, reason: string, ctx: GateEventContext): WakeGateDecision {
  return {
    gate_name: gateName,
    decision: "would_skip",
    reason,
    inputs: {
      notion_type: ctx.notionType,
      page_id: ctx.pageId,
      adopted_at: ctx.fleetLocksAdoptedAt,
    },
    ts: new Date().toISOString(),
    mode: "shadow",
  };
}

function isFleetLocksPageEvent(ctx: GateEventContext): boolean {
  const t = ctx.notionType || "";
  return (
    t === "page.properties_updated" ||
    t === "page.created" ||
    t === "page.added" ||
    t === "page_created"
  );
}

function collectAuthorCandidateIds(
  ctx: GateEventContext,
  fields: ParsedFleetLocksFields,
): string[] {
  const ids: string[] = [];
  for (const id of ctx.webhookAuthorIds ?? []) {
    ids.push(id);
  }
  if (ctx.pageCreatedById) {
    ids.push(ctx.pageCreatedById);
  }
  if (ctx.pageLastEditedById) {
    ids.push(ctx.pageLastEditedById);
  }
  if (ctx.pageAuthorId) {
    ids.push(ctx.pageAuthorId);
  }
  if (ctx.authorId) {
    ids.push(ctx.authorId);
  }
  for (const id of fields.adoptedByPersonIds ?? []) {
    ids.push(id);
  }
  return ids;
}

function evaluateFleetLocksRow(
  ctx: GateEventContext,
  fields: ParsedFleetLocksFields,
): WakeGateDecision {
  if (!fields.parseOk) {
    return wake(GATE_NAME, "notion_page_unreadable", ctx);
  }

  if (fields.grandfathered && !fields.adoptedAt) {
    return skip(GATE_NAME, "lock_grandfathered_no_adopted_at", ctx);
  }

  if (fields.statusName !== FLEET_LOCKS_STATUS_ADOPTED) {
    return skip(GATE_NAME, "lock_not_adopted", ctx);
  }

  if (!fields.adoptedAt) {
    return wake(GATE_NAME, "lock_adopted_at_missing", ctx);
  }

  if (!fields.adoptedBySet) {
    return wake(GATE_NAME, "lock_adopted_by_missing", ctx);
  }

  const authorIds = collectAuthorCandidateIds(ctx, fields);
  if (authorIds.length === 0) {
    return wake(GATE_NAME, "lock_author_unknown", ctx);
  }
  if (!anyJohnUserId(ctx.johnUserIds, authorIds)) {
    return skip(GATE_NAME, "lock_author_not_john", ctx);
  }

  if (ctx.adoptedAtAlreadyWoken && ctx.fleetLocksAdoptedAt === ctx.adoptedAtAlreadyWoken) {
    return skip(GATE_NAME, "adopted_already_woken", ctx);
  }

  return wake(GATE_NAME, "adopted_change", ctx);
}

export function decideAdoptedChangeGate(ctx: GateEventContext): WakeGateDecision {
  try {
    if (ctx.isCommentEvent && isJohn(ctx)) {
      return wake(GATE_NAME, "john_comment", ctx);
    }
    if (submittedPropertyChanged(ctx)) {
      return wake(GATE_NAME, "submitted_changed", ctx);
    }

    if (!isFleetLocksPageEvent(ctx)) {
      return wake(GATE_NAME, "not_page_event", ctx);
    }

    const fleetDs = ctx.fleetLocksDataSourceId?.trim();
    const fleetDb = ctx.fleetLocksDatabaseId?.trim();
    if (!fleetDs && !fleetDb) {
      return wake(GATE_NAME, "fleet_locks_data_source_unset", ctx);
    }

    if (ctx.fleetLocksParentKnown === false && !ctx.webhookIndicatedFleetLocks) {
      return wake(GATE_NAME, "not_fleet_locks", ctx);
    }

    if (ctx.fleetLocksParentKnown !== true) {
      return wake(GATE_NAME, ctx.notionFetchFailReason ?? "notion_page_unreadable", ctx);
    }

    if (!ctx.fleetLocksFields) {
      return wake(GATE_NAME, ctx.notionFetchFailReason ?? "notion_page_unreadable", ctx);
    }

    return evaluateFleetLocksRow(ctx, ctx.fleetLocksFields);
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    return wake(GATE_NAME, `error:${name}`, ctx);
  }
}

export { GATE_NAME as adoptedChangeGateName };
