import { adoptedChangeGateName } from "./adopted-change-gate.js";
import { idInNotionIdSet } from "./notion-ids.js";
import { FLEET_LOCKS_STATUS_ADOPTED } from "./fleet-locks-properties.js";
import { isJohn, isTruthyFlag, needsJohnPropertyChanged, submittedPropertyChanged } from "./gate-context-safety.js";
import type { GateEventContext, WakeGateDecision } from "./gate-event-types.js";

const IRREVERSIBLE_KEYWORD = /\b(send|pay|delete|publish|merge)\b/i;
const CHEAP_BOT_PLAIN_MENTION = /@(?:fleet[- ]?comments|gate[- ]?log)\b/i;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function mentionUserId(mention: Record<string, unknown>): string | undefined {
  const user = asRecord(mention.user);
  if (user && typeof user.id === "string") {
    return user.id;
  }
  return undefined;
}

function isJohnMentionNode(rec: Record<string, unknown>, ctx: GateEventContext): boolean {
  if (rec.type !== "mention") {
    return false;
  }
  const mention = asRecord(rec.mention);
  if (!mention) {
    return false;
  }
  const userId = mentionUserId(mention);
  if (userId && isJohn({ ...ctx, authorId: userId, webhookAuthorIds: [userId] })) {
    return true;
  }
  return false;
}

function isBotMentionNode(rec: Record<string, unknown>, ctx: GateEventContext): boolean {
  if (rec.type !== "mention") {
    return false;
  }
  const mention = asRecord(rec.mention);
  if (!mention) {
    return false;
  }
  if (mention.type === "bot") {
    return true;
  }
  const user = asRecord(mention.user);
  if (user?.type === "bot") {
    const userId = typeof user.id === "string" ? user.id : undefined;
    if (userId && !isJohn({ ...ctx, authorId: userId, webhookAuthorIds: [userId] })) {
      return true;
    }
  }
  const userId = mentionUserId(mention);
  if (
    userId &&
    !isJohn({ ...ctx, authorId: userId, webhookAuthorIds: [userId] }) &&
    idInNotionIdSet(userId, ctx.fleetCommentsBotIds)
  ) {
    return true;
  }
  return false;
}

function walkMentions(
  value: unknown,
  ctx: GateEventContext,
  depth: number,
  onNode: (rec: Record<string, unknown>) => boolean,
): boolean {
  if (depth > 12 || value === null || value === undefined) {
    return false;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (walkMentions(entry, ctx, depth + 1, onNode)) {
        return true;
      }
    }
    return false;
  }
  if (typeof value !== "object") {
    return false;
  }
  const rec = value as Record<string, unknown>;
  if (onNode(rec)) {
    return true;
  }
  if (typeof rec.plain_text === "string" && CHEAP_BOT_PLAIN_MENTION.test(rec.plain_text)) {
    return true;
  }
  for (const child of Object.values(rec)) {
    if (walkMentions(child, ctx, depth + 1, onNode)) {
      return true;
    }
  }
  return false;
}

export function payloadHasBotMention(
  parsed: Record<string, unknown>,
  ctx: GateEventContext,
): boolean {
  return walkMentions(parsed, ctx, 0, (rec) => isBotMentionNode(rec, ctx));
}

export function payloadHasJohnMention(
  parsed: Record<string, unknown>,
  ctx: GateEventContext,
): boolean {
  return walkMentions(parsed, ctx, 0, (rec) => isJohnMentionNode(rec, ctx));
}

function commentPayloadHasInspectableContent(parsed: Record<string, unknown>): boolean {
  const data = asRecord(parsed.data);
  if (!data) {
    return false;
  }
  if (typeof data.text === "string" && data.text.trim() !== "") {
    return true;
  }
  const rich = data.rich_text ?? data.content;
  if (!Array.isArray(rich) || rich.length === 0) {
    return false;
  }
  for (const part of rich) {
    const rec = asRecord(part);
    if (rec && typeof rec.plain_text === "string" && rec.plain_text.trim() !== "") {
      return true;
    }
    if (rec?.type === "mention") {
      return true;
    }
  }
  return false;
}

function isFleetCommentsBotAuthor(ctx: GateEventContext): boolean {
  const ids = ctx.webhookAuthorIds ?? (ctx.authorId ? [ctx.authorId] : []);
  return ids.some((id) => idInNotionIdSet(id, ctx.fleetCommentsBotIds));
}

function structuredIrreversible(ctx: GateEventContext): boolean {
  const chunks: string[] = [];
  const props = ctx.properties;
  if (props?.kind) {
    chunks.push(props.kind);
  }
  if (props?.documentType) {
    chunks.push(props.documentType);
  }
  if (ctx.fleetLocksFields?.statusName) {
    chunks.push(ctx.fleetLocksFields.statusName);
  }
  if (props?.authorLane) {
    chunks.push(props.authorLane);
  }
  const joined = chunks.join(" ");
  return IRREVERSIBLE_KEYWORD.test(joined);
}

/**
 * Shared must-wake overrides: the event must reach CoS whatever any gate says. Used by the Clef gate
 * (clefHardOverrideReason), the CoS pre-filter and gradeRelayWindow (a prefilter drop on an event
 * whose Clef row carries one of these names is a breach). Order = reason label precedence.
 */
export const MUST_WAKE_OVERRIDE_NAMES = [
  "john_mention",
  "submitted_changed",
  "needs_john_changed",
  "needs_john_or_sensitive",
  "bot_mention",
  "notion_page_unreadable",
  "irreversible_action_field",
] as const;
export type MustWakeOverride = (typeof MUST_WAKE_OVERRIDE_NAMES)[number];

export function mustWakeOverrideReason(
  ctx: GateEventContext,
  parsed: Record<string, unknown>,
): MustWakeOverride | null {
  if (payloadHasJohnMention(parsed, ctx)) {
    return "john_mention";
  }
  if (submittedPropertyChanged(ctx)) {
    return "submitted_changed";
  }
  if (needsJohnPropertyChanged(ctx)) {
    return "needs_john_changed";
  }
  const props = ctx.properties;
  if (isTruthyFlag(ctx.needsJohnNow) || isTruthyFlag(props?.needsJohn) || isTruthyFlag(props?.sensitive)) {
    return "needs_john_or_sensitive";
  }
  if (payloadHasBotMention(parsed, ctx)) {
    return "bot_mention";
  }
  if (props?.adDocsParseOk === false) {
    return "notion_page_unreadable";
  }
  if (structuredIrreversible(ctx)) {
    return "irreversible_action_field";
  }
  return null;
}

export function clefHardOverrideReason(
  ctx: GateEventContext,
  parsed: Record<string, unknown>,
  parseOk: boolean,
  ruleDecisions: WakeGateDecision[],
): string | null {
  if (!parseOk) {
    return "unparseable_payload";
  }
  if (ctx.johnUserIds.size === 0) {
    return "john_ids_unset";
  }
  if (ctx.fleetCommentsBotIds.size === 0) {
    return "bot_ids_unset";
  }
  if (isFleetCommentsBotAuthor(ctx)) {
    return "fleet_bot_author";
  }
  if (ctx.notionFetchFailReason) {
    return ctx.notionFetchFailReason;
  }
  if (ctx.isCommentEvent && isJohn(ctx)) {
    return "john_authored";
  }
  if (ctx.isCommentEvent && !commentPayloadHasInspectableContent(parsed)) {
    return "comment_content_unavailable";
  }
  const mustWake = mustWakeOverrideReason(ctx, parsed);
  if (mustWake) {
    return mustWake;
  }
  const adopted = ruleDecisions.find((d) => d.gate_name === adoptedChangeGateName);
  if (adopted?.decision === "would_wake" && adopted.reason === "adopted_change") {
    return "adopted_change";
  }
  if (ctx.fleetLocksFields?.statusName === FLEET_LOCKS_STATUS_ADOPTED) {
    return "adopted_status";
  }
  if (!ctx.propertiesAvailable) {
    return "properties_unavailable";
  }
  const props = ctx.properties;
  if (isTruthyFlag(props?.sourceRepo) && props?.sourceRepo !== "") {
    return "source_repo_set";
  }
  for (const d of ruleDecisions) {
    if (d.decision === "would_wake" && d.reason.startsWith("error:")) {
      return d.reason;
    }
  }
  return null;
}
