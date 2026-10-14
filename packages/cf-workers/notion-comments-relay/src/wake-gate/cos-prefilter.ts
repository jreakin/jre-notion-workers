/**
 * Chief of Staff pre-filter (LOCK-61): events that should never wake CoS.
 *
 *  1. ack_only            comment whose whole text is an acknowledgement ("thanks", "ok", "+1", "done",
 *                          emoji-only, ...);
 *  2. self_echo_bot       comment posted by the GrokBot Fleet Comments integration bot (CoS's own reply);
 *     self_echo_lane      comment that starts with a lane prefix ("CoS:", "[BCH]", "Chief of Staff —", ...);
 *  3. non_actionable_property  page.properties_updated touching neither Submitted nor Needs John (the
 *                          existing properties_updated rule; inert until SUBMITTED_PROPERTY_IDS and
 *                          NEEDS_JOHN_PROPERTY_IDS are both set).
 *
 * Hard overrides always win (never dropped): John authored, any John @mention, Needs John (set or
 * changed), Submitted changed. Unknown / missing text never counts as an ack.
 *
 * Mode: COS_PREFILTER_LIVE=1 drops the forward; otherwise SHADOW — log `would_drop` and forward anyway.
 * Rows go to stream `cos_prefilter` with an opaque `event_key` shared with the Clef rows for the same
 * event, so gradeRelayWindow can check every would_drop against Clef's verdict.
 */
import type { Env } from "../env.js";
import { payloadHasJohnMention } from "./clef-overrides.js";
import {
  explicitPropertyRuleActive,
  isJohn,
  isTruthyFlag,
  needsJohnPropertyChanged,
  submittedPropertyChanged,
} from "./gate-context-safety.js";
import type { GateEventContext } from "./gate-event-types.js";
import { idInNotionIdSet } from "./notion-ids.js";
import { enqueueGateLogRow } from "../gate-log-ring.js";

/** GrokBot Fleet Comments integration bot user (posts CoS's replies). Always treated as self. */
export const GROKBOT_FLEET_COMMENTS_BOT_ID = "3d87d7f5-6298-8165-8af9-0027a153ccbd";

export const COS_PREFILTER_STREAM = "cos_prefilter" as const;

export type CosPrefilterReason =
  | "ack_only"
  | "self_echo_bot"
  | "self_echo_lane"
  | "non_actionable_property";

export type CosPrefilterVerdict =
  | { decision: "would_drop"; reason: CosPrefilterReason }
  | { decision: "pass"; reason: string };

const ACK_PHRASES = new Set([
  "thanks", "thank you", "thank you so much", "thanks so much", "thanks a lot", "thx", "ty", "tysm", "tks",
  "ok", "okay", "k", "kk", "okey", "ok thanks", "ok thank you", "okay thanks", "ok thx", "ok ty",
  "+1", "plus one", "ack", "acked", "noted", "got it", "gotcha", "roger", "cool", "nice", "great",
  "awesome", "perfect", "sounds good", "will do", "done", "all done", "done thanks", "yep", "yup",
  "great thanks", "perfect thanks", "cool thanks", "nice thanks", "got it thanks", "noted thanks",
]);

/** Lane prefixes used by fleet agents when they sign a comment. Case-insensitive. */
const DEFAULT_LANE_PREFIXES = [
  "CoS", "Chief of Staff", "BCH", "Bot Computer Harness", "AS", "Abstract Secretary", "dr eggbot", "Clef",
  "Grok Bot", "GrokBot",
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function lanePrefixRe(env: Pick<Env, "COS_PREFILTER_LANE_PREFIXES">): RegExp {
  const extra = (env.COS_PREFILTER_LANE_PREFIXES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const alts = [...DEFAULT_LANE_PREFIXES, ...extra].map(escapeRe).join("|");
  // "CoS:" / "CoS —" / "[CoS]" / "**CoS:**" at the very start.
  return new RegExp(`^[\\s*_]*(?:\\[(?:${alts})\\]|(?:${alts})[\\s*_]*(?::|—|–|-\\s))`, "i");
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

/** Comment text from the webhook payload, or null when the payload carries none. */
export function commentText(parsed: Record<string, unknown>): string | null {
  const data = asRecord(parsed.data);
  if (!data) return null;
  if (typeof data.text === "string") return data.text;
  const rich = data.rich_text ?? data.content;
  if (!Array.isArray(rich)) return null;
  let out = "";
  for (const part of rich) {
    const rec = asRecord(part);
    // Any mention makes it non-ack (could be a person/page reference that carries meaning).
    if (rec?.type === "mention") return `\u0000mention`;
    if (rec && typeof rec.plain_text === "string") out += rec.plain_text;
  }
  return out;
}

const EMOJI_RE = /\p{Extended_Pictographic}/u;
const EMOJI_STRIP_RE = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f\u20e3]/gu;

/** True when the whole comment is an acknowledgement. Empty / unknown text is NOT an ack. */
export function isAckOnly(text: string | null): boolean {
  if (text === null) return false;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 60 || trimmed.includes("\u0000")) return false;
  // Questions are never acks ("ok?", "done?").
  if (trimmed.includes("?")) return false;
  const noEmoji = trimmed.replace(EMOJI_STRIP_RE, "");
  if (EMOJI_RE.test(trimmed) && !/[\p{L}\p{N}]/u.test(noEmoji)) return true; // emoji-only
  const norm = noEmoji
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}+\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!norm) return false;
  if (/^\+\s?1+$/.test(norm)) return true;
  if (ACK_PHRASES.has(norm)) return true;
  // "ok ok", "thanks thanks", "done 👍" (emoji already stripped)
  const words = norm.split(" ");
  if (words.length <= 4) {
    let i = 0;
    while (i < words.length) {
      const two = i + 1 < words.length ? `${words[i]} ${words[i + 1]}` : "";
      if (two && ACK_PHRASES.has(two)) i += 2;
      else if (ACK_PHRASES.has(words[i]!)) i += 1;
      else return false;
    }
    return true;
  }
  return false;
}

function isSelfBot(ctx: GateEventContext): boolean {
  const ids = ctx.webhookAuthorIds?.length ? ctx.webhookAuthorIds : ctx.authorId ? [ctx.authorId] : [];
  if (!ids.length) return false;
  const bots = new Set([...ctx.fleetCommentsBotIds, GROKBOT_FLEET_COMMENTS_BOT_ID]);
  // Every author must be the bot (a mixed-author event is not a pure self-echo).
  return ids.every((id) => idInNotionIdSet(id, bots));
}

/** Hard overrides: never dropped. Returns the override name or null. */
export function cosPrefilterOverride(ctx: GateEventContext, parsed: Record<string, unknown>): string | null {
  if (isJohn(ctx)) return "john_authored";
  if (payloadHasJohnMention(parsed, ctx)) return "john_mention";
  // Plain-text "@John" (no mention node) still counts.
  const text = commentText(parsed);
  if (text && /@john\b/i.test(text)) return "john_mention";
  if (submittedPropertyChanged(ctx)) return "submitted_changed";
  if (needsJohnPropertyChanged(ctx)) return "needs_john_changed";
  if (isTruthyFlag(ctx.needsJohnNow) || isTruthyFlag(ctx.properties?.needsJohn)) return "needs_john";
  return null;
}

export function decideCosPrefilter(
  ctx: GateEventContext,
  parsed: Record<string, unknown>,
  env: Pick<Env, "COS_PREFILTER_LANE_PREFIXES">,
): CosPrefilterVerdict {
  try {
    const override = cosPrefilterOverride(ctx, parsed);
    if (override) return { decision: "pass", reason: `override:${override}` };
    const type = ctx.notionType ?? "";
    if (type === "comment.created" || type === "comment.updated") {
      if (isSelfBot(ctx)) return { decision: "would_drop", reason: "self_echo_bot" };
      const text = commentText(parsed);
      if (text !== null && lanePrefixRe(env).test(text)) return { decision: "would_drop", reason: "self_echo_lane" };
      if (isAckOnly(text)) return { decision: "would_drop", reason: "ack_only" };
      return { decision: "pass", reason: text === null ? "comment_text_unavailable" : "actionable_comment" };
    }
    if (type === "page.properties_updated") {
      // Same rule as comments-echo-gate: only when both id sets are configured and ids were listed.
      if (explicitPropertyRuleActive(ctx)) return { decision: "would_drop", reason: "non_actionable_property" };
      return { decision: "pass", reason: "property_rule_inactive" };
    }
    return { decision: "pass", reason: "not_filtered_type" };
  } catch (err) {
    return { decision: "pass", reason: `error:${err instanceof Error ? err.name : "Error"}` };
  }
}

export function cosPrefilterLive(env: Pick<Env, "COS_PREFILTER_LIVE">): boolean {
  return env.COS_PREFILTER_LIVE?.trim() === "1";
}

/** Log one prefilter row (stdout + gate_log ring, fail-open). Never logs text or raw ids. */
export async function logCosPrefilter(
  env: Env,
  ctx: GateEventContext,
  verdict: CosPrefilterVerdict,
): Promise<void> {
  const row = {
    stream: COS_PREFILTER_STREAM,
    ts: new Date().toISOString(),
    event: ctx.notionType,
    event_key: ctx.eventKey ?? "unknown",
    decision: verdict.decision,
    reason: verdict.reason,
    mode: cosPrefilterLive(env) ? "live" : "shadow",
    dropped: verdict.decision === "would_drop" && cosPrefilterLive(env),
  };
  console.log(JSON.stringify(row));
  try {
    await enqueueGateLogRow(env, row);
  } catch {
    // fail-open
  }
}
