import { decodeNotionPropertyId } from "./fleet-locks-properties.js";
import type { GateEventContext } from "./gate-event-types.js";
import { idInNotionIdSet } from "./notion-ids.js";

export function isTruthyFlag(value: unknown): boolean {
  if (value === false || value === null || value === undefined) {
    return false;
  }
  if (value === "" || value === 0) {
    return false;
  }
  return true;
}

function normalizeUpdatedPropertyId(id: string): string {
  const trimmed = id.trim();
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

function normalizedIdSet(ids: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    out.add(normalizeUpdatedPropertyId(id));
    out.add(decodeNotionPropertyId(id));
  }
  return out;
}

export function submittedPropertyChanged(ctx: GateEventContext): boolean {
  if (isTruthyFlag((ctx.properties as { submittedChanged?: unknown })?.submittedChanged)) {
    return true;
  }
  const ids = ctx.updatedPropertyIds;
  const notionType = ctx.notionType || "";
  if (!ids.length) {
    if (notionType === "page.properties_updated") {
      return true;
    }
    return false;
  }
  const submitted = normalizedIdSet(ctx.submittedPropertyIds);
  const nonSubmitted = normalizedIdSet(ctx.nonSubmittedPropertyIds);
  const normalizedUpdated = ids.map((id) => normalizeUpdatedPropertyId(id));
  if (normalizedUpdated.some((id) => submitted.has(id))) {
    return true;
  }
  if (nonSubmitted.size > 0 && normalizedUpdated.every((id) => nonSubmitted.has(id))) {
    return false;
  }
  return true;
}

export function isJohn(ctx: GateEventContext): boolean {
  const ids = ctx.webhookAuthorIds ?? (ctx.authorId ? [ctx.authorId] : []);
  if (ids.some((id) => idInNotionIdSet(id, ctx.johnUserIds))) {
    return true;
  }
  const name = ctx.authorName;
  if (typeof name !== "string") {
    return false;
  }
  const normalized = name.trim().toLowerCase();
  return normalized === "john" || normalized === "john eakin";
}

export function anyJohnUserId(johnUserIds: Set<string>, candidateIds: Iterable<string>): boolean {
  for (const id of candidateIds) {
    if (idInNotionIdSet(id, johnUserIds)) {
      return true;
    }
  }
  return false;
}
