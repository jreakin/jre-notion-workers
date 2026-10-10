import type { Env } from "../env.js";
import { normalizeNotionUuid, notionIdsEqual } from "./notion-ids.js";
import type { GateEventContext } from "./gate-event-types.js";

export const GATE_LOG_DROP_REASON = "gate_log_event";

function parseNormalizedIdSet(raw: unknown): Set<string> {
  if (typeof raw !== "string" || !raw.trim()) {
    return new Set();
  }
  const out = new Set<string>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed) {
      out.add(normalizeNotionUuid(trimmed));
    }
  }
  return out;
}

function parentIdsMatchGateLog(ctx: GateEventContext, gateLogIds: Set<string>): boolean {
  if (!gateLogIds.size) {
    return false;
  }
  const candidates: string[] = [];
  if (ctx.webhookParentDataSourceId) {
    candidates.push(ctx.webhookParentDataSourceId);
  }
  if (ctx.webhookParentDatabaseId) {
    candidates.push(ctx.webhookParentDatabaseId);
  }
  for (const id of candidates) {
    for (const gateId of gateLogIds) {
      if (notionIdsEqual(id, gateId)) {
        return true;
      }
    }
  }
  return false;
}

export function isGateLogDataSourceEvent(ctx: GateEventContext, env: Env): boolean {
  const gateLogIds = parseNormalizedIdSet(env.GATE_LOG_DATA_SOURCE_IDS);
  return parentIdsMatchGateLog(ctx, gateLogIds);
}

export function shouldDropGateLogEvent(ctx: GateEventContext, env: Env): boolean {
  return isGateLogDataSourceEvent(ctx, env);
}

export function gateLogBlocksForward(parseOk: boolean, ctx: GateEventContext, env: Env): boolean {
  return parseOk && isGateLogDataSourceEvent(ctx, env);
}
