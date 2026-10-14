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

/**
 * True when the explicit properties_updated change rule can decide: event is page.properties_updated,
 * the webhook listed updated property ids, and BOTH SUBMITTED_PROPERTY_IDS and NEEDS_JOHN_PROPERTY_IDS
 * are configured. Otherwise callers keep the old conservative behavior (opaque update ⇒ wake).
 */
export function explicitPropertyRuleActive(ctx: GateEventContext): boolean {
  return (
    (ctx.notionType || "") === "page.properties_updated" &&
    ctx.updatedPropertyIds.length > 0 &&
    ctx.submittedPropertyIds.size > 0 &&
    (ctx.needsJohnPropertyIds?.size ?? 0) > 0
  );
}

function updatedTouches(ctx: GateEventContext, ids: Set<string>): boolean {
  const set = normalizedIdSet(ids);
  return ctx.updatedPropertyIds.some((id) => set.has(normalizeUpdatedPropertyId(id)));
}

/**
 * Needs John hard override for page.properties_updated, independent of the env id sets:
 * the page's Needs John flag is set (enriched/fetched properties), OR NEEDS_JOHN_PROPERTY_IDS is set
 * and a listed updated id is one of them. (An unreadable page is already the `properties_unavailable`
 * override; page-event dedupe is off unless both id sets are configured.)
 */
export function needsJohnPropertyChanged(ctx: GateEventContext): boolean {
  if ((ctx.notionType || "") !== "page.properties_updated") return false;
  if (isTruthyFlag(ctx.properties?.needsJohn)) return true;
  const njIds = ctx.needsJohnPropertyIds ?? new Set<string>();
  return njIds.size > 0 && ctx.updatedPropertyIds.length > 0 && updatedTouches(ctx, njIds);
}

export function submittedPropertyChanged(ctx: GateEventContext): boolean {
  if (isTruthyFlag((ctx.properties as { submittedChanged?: unknown })?.submittedChanged)) {
    return true;
  }
  if (explicitPropertyRuleActive(ctx)) {
    // Both id sets configured and ids listed: Submitted changed iff a listed id is a Submitted id.
    return updatedTouches(ctx, ctx.submittedPropertyIds);
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
