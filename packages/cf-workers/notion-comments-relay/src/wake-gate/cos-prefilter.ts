/**
 * Chief of Staff pre-filter (LOCK-61): events that should never wake CoS.
 *
 *  1. ack_only            comment whose whole text is an acknowledgement ("thanks", "ok", "+1", or only
 *                          POSITIVE emoji from an allowlist). "done" / "will do" are NOT acks (a teammate
 *                          reporting completion still wakes CoS). 👎 ❌ 🛑 ⚠️ ❓ and any other emoji pass;
 *  2. self_echo_bot       comment posted only by the GrokBot Fleet Comments integration bot (CoS's own reply);
 *     self_echo_lane      comment by a bot author (Fleet Comments bot or FLEET_COMMENTS_BOT_NOTION_USER_IDS)
 *                          that starts with a CoS lane prefix ("CoS:", "[Chief of Staff]", ...). Humans
 *                          writing "CoS: can you…" always pass;
 *  3. non_actionable_property  page.properties_updated touching neither Submitted nor Needs John (the
 *                          existing properties_updated rule; inert until SUBMITTED_PROPERTY_IDS and
 *                          NEEDS_JOHN_PROPERTY_IDS are both set).
 *
 * Fail open: JOHN_NOTION_USER_IDS unset → never drop (john_ids_unset, as Clef). The decision is made
 * AFTER the page fetch (decideCosPrefilterAfterFetch), so Needs John / Sensitive / Kind are real; a
 * failed fetch passes. Overrides: John authored, plus the shared MUST_WAKE_OVERRIDE_NAMES list
 * (clef-overrides.ts) also used by the Clef gate and gradeRelayWindow. Unknown text is never an ack.
 *
 * Mode: COS_PREFILTER_LIVE=1|true drops the forward; otherwise SHADOW — log `would_drop`, forward anyway.
 * Rows go to stream `cos_prefilter` with an opaque `event_key` shared with the Clef rows for the same
 * event, so gradeRelayWindow can check every would_drop against Clef's verdict.
 */
import type { Env } from "../env.js";
import { mustWakeOverrideReason } from "./clef-overrides.js";
import { enrichContextFromNotionPage, fetchNotionPageOutcome } from "./gate-orchestration.js";
import { parseAdDocsPropertiesFromNotionPage } from "./fleet-locks-properties.js";
import type { PageFetchResult } from "./notion-page-fetch.js";
import { explicitPropertyRuleActive, isJohn } from "./gate-context-safety.js";
import type { GateEventContext } from "./gate-event-types.js";
import { idInNotionIdSet } from "./notion-ids.js";
import { enqueueGateLogRow } from "../gate-log-ring.js";
import {
  COS_LANE_PREFIX_NAMES,
  GROKBOT_FLEET_COMMENTS_BOT_ID,
  buildLanePrefixRe,
  splitCsv,
} from "./echo-filter-config.js";

/** GrokBot Fleet Comments integration bot user (posts CoS's replies). Always treated as self. */
export { GROKBOT_FLEET_COMMENTS_BOT_ID };

export const COS_PREFILTER_STREAM = "cos_prefilter" as const;

export type CosPrefilterReason =
  | "ack_only"
  | "self_echo_bot"
  | "self_echo_lane"
  | "non_actionable_property";

/** Page fetch done for the decision (absent when no fetch was needed). */
export type CosPrefilterFetch = { ms: number; outcome: string; fetches: number; cached: number };

export type CosPrefilterVerdict =
  | { decision: "would_drop"; reason: CosPrefilterReason; fetch?: CosPrefilterFetch }
  | { decision: "pass"; reason: string; fetch?: CosPrefilterFetch };

/** Prefilter page-fetch budget: it runs before the webhook's 200, so keep it short. Fail open on timeout. */
export const PREFILTER_FETCH_MS = 1_000;

const ACK_PHRASES = new Set([
  "thanks", "thank you", "thank you so much", "thanks so much", "thanks a lot", "thx", "ty", "tysm", "tks",
  "ok", "okay", "k", "kk", "okey", "ok thanks", "ok thank you", "okay thanks", "ok thx", "ok ty",
  "+1", "plus one", "ack", "acked", "noted", "got it", "gotcha", "roger", "cool", "nice", "great",
  "awesome", "perfect", "sounds good", "yep", "yup",
  "great thanks", "perfect thanks", "cool thanks", "nice thanks", "got it thanks", "noted thanks",
]);

/** CoS's own lane prefixes (only checked on bot-authored comments). Case-insensitive. Lives in echo-filter-config. */
const DEFAULT_LANE_PREFIXES = COS_LANE_PREFIX_NAMES;

/** Positive / acknowledging emoji. Emoji-only comments drop only when every emoji is in this set. */
const ACK_EMOJI = new Set([
  "👍", "🙏", "✅", "✔", "☑", "🎉", "🥳", "❤", "🧡", "💛", "💚", "💙", "💜", "🤍", "🖤", "💯", "👌", "🙌", "👏",
  "😊", "🙂", "😀", "😃", "😄", "😁", "🤝", "✨", "🚀", "🔥", "💪", "⭐", "🌟", "😍", "🥰", "🫡", "🆗", "👋",
]);

export function lanePrefixRe(env: Pick<Env, "COS_PREFILTER_LANE_PREFIXES">): RegExp {
  // "CoS:" / "CoS —" / "[CoS]" / "**CoS:**" at the very start (shared matcher, case-insensitive here).
  return buildLanePrefixRe([...DEFAULT_LANE_PREFIXES, ...splitCsv(env.COS_PREFILTER_LANE_PREFIXES)], "i");
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

const EMOJI_RE = /\p{Extended_Pictographic}/gu;
const EMOJI_STRIP_RE = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f\u20e3]/gu;
const SKIN_TONE_RE = /[\p{Emoji_Modifier}\u200d\ufe0f\u20e3]/gu;

/** Every pictographic emoji in the text is on the positive allowlist (and there is at least one). */
function emojisAllPositive(text: string): boolean {
  const found = text.replace(SKIN_TONE_RE, "").match(EMOJI_RE) ?? [];
  return found.every((e) => ACK_EMOJI.has(e));
}

/** True when the whole comment is an acknowledgement. Empty / unknown text is NOT an ack. */
export function isAckOnly(text: string | null): boolean {
  if (text === null) return false;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 60 || trimmed.includes("\u0000")) return false;
  // Questions are never acks ("ok?", "done?").
  if (trimmed.includes("?")) return false;
  // Any non-allowlisted emoji (👎 ❌ 🛑 ⚠️ ❓ …) means "not an ack", alone or next to "ok".
  if (!emojisAllPositive(trimmed)) return false;
  const noEmoji = trimmed.replace(EMOJI_STRIP_RE, "");
  if (/\p{Extended_Pictographic}/u.test(trimmed) && !/[\p{L}\p{N}]/u.test(noEmoji)) return true; // emoji-only
  const norm = noEmoji
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}+\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!norm) return false;
  if (/^\+\s?1+$/.test(norm)) return true;
  if (ACK_PHRASES.has(norm)) return true;
  // "ok ok", "thanks thanks", "ok 👍" (emoji already stripped)
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

function authorIds(ctx: GateEventContext): string[] {
  return ctx.webhookAuthorIds?.length ? ctx.webhookAuthorIds : ctx.authorId ? [ctx.authorId] : [];
}

/** Every author is the GrokBot Fleet Comments bot (CoS's own reply). Mixed authors are not self-echo. */
function isFleetCommentsBot(ctx: GateEventContext): boolean {
  const ids = authorIds(ctx);
  return ids.length > 0 && ids.every((id) => idInNotionIdSet(id, new Set([GROKBOT_FLEET_COMMENTS_BOT_ID])));
}

/** Every author is a bot: the Fleet Comments bot or a configured FLEET_COMMENTS_BOT_NOTION_USER_IDS id. */
function isBotAuthor(ctx: GateEventContext): boolean {
  const ids = authorIds(ctx);
  const bots = new Set([...ctx.fleetCommentsBotIds, GROKBOT_FLEET_COMMENTS_BOT_ID]);
  return ids.length > 0 && ids.every((id) => idInNotionIdSet(id, bots));
}

/** Hard overrides: never dropped. Returns the override name or null. */
export function cosPrefilterOverride(ctx: GateEventContext, parsed: Record<string, unknown>): string | null {
  // Fail open, matching Clef: without John's ids we cannot tell John's comments apart.
  if (ctx.johnUserIds.size === 0) return "john_ids_unset";
  if (isJohn(ctx)) return "john_authored";
  if (ctx.notionFetchFailReason) return ctx.notionFetchFailReason;
  const shared = mustWakeOverrideReason(ctx, parsed);
  if (shared) return shared;
  // Plain-text "@John" (no mention node) still counts.
  const text = commentText(parsed);
  if (text && /@john\b/i.test(text)) return "john_mention";
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
      if (isFleetCommentsBot(ctx)) return { decision: "would_drop", reason: "self_echo_bot" };
      const text = commentText(parsed);
      if (text !== null && isBotAuthor(ctx) && lanePrefixRe(env).test(text)) {
        return { decision: "would_drop", reason: "self_echo_lane" };
      }
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

/**
 * Decide after the page fetch. A cheap pre-check skips the fetch when nothing would drop anyway; for a
 * candidate drop the page is fetched (gate enrichment, plus Needs John / Sensitive / Kind for comment
 * pages) and the decision re-made with real properties. Any fetch failure → pass (fail open).
 */
export async function decideCosPrefilterAfterFetch(
  env: Env,
  ctx: GateEventContext,
  parsed: Record<string, unknown>,
): Promise<CosPrefilterVerdict> {
  const pre = decideCosPrefilter(ctx, parsed, env);
  if (pre.decision !== "would_drop") return pre;
  const fetch: CosPrefilterFetch = { ms: 0, outcome: "ok", fetches: 0, cached: 0 };
  const opts = {
    timeoutMs: PREFILTER_FETCH_MS,
    scope: ctx.fetchScope,
    caller: "cos_prefilter",
    logLatency: true,
    onResult: (r: PageFetchResult) => {
      fetch.ms += r.ms;
      fetch.fetches += 1;
      if (r.cached) fetch.cached += 1;
      if (r.outcome !== "ok" && fetch.outcome === "ok") fetch.outcome = r.outcome;
    },
  };
  try {
    await enrichContextFromNotionPage(env, ctx, ctx.notionType, opts);
    if (ctx.isCommentEvent && !ctx.propertiesAvailable && !ctx.notionFetchFailReason) {
      if (!ctx.pageId) {
        ctx.notionFetchFailReason = "notion_page_unreadable";
      } else {
        const fetched = await fetchNotionPageOutcome(ctx.pageId, env, opts);
        if (!fetched.ok) {
          ctx.notionFetchFailReason = fetched.reason;
        } else {
          const props = parseAdDocsPropertiesFromNotionPage(fetched.page);
          if (!props.ok) {
            ctx.properties = { ...(ctx.properties ?? {}), adDocsParseOk: false };
          } else {
            ctx.properties = { ...(ctx.properties ?? {}), ...props.properties, adDocsParseOk: true };
            ctx.propertiesAvailable = true;
            ctx.needsJohnNow = props.properties.needsJohn === true;
          }
        }
      }
    }
  } catch (err) {
    ctx.notionFetchFailReason = `error:${err instanceof Error ? err.name : "Error"}`;
  }
  if (ctx.notionFetchFailReason && fetch.outcome === "ok") fetch.outcome = ctx.notionFetchFailReason;
  const verdict = decideCosPrefilter(ctx, parsed, env);
  return fetch.fetches > 0 || fetch.outcome !== "ok" ? { ...verdict, fetch } : verdict;
}

/** COS_PREFILTER_LIVE: "1" or "true" (any case) = LIVE; anything else (unset, "", "0", …) = SHADOW. */
export function cosPrefilterLive(env: Pick<Env, "COS_PREFILTER_LIVE">): boolean {
  const v = env.COS_PREFILTER_LIVE?.trim().toLowerCase();
  return v === "1" || v === "true";
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
    ...(verdict.fetch
      ? { fetch_outcome: verdict.fetch.outcome, fetch_ms: verdict.fetch.ms, fetch_cached: verdict.fetch.cached }
      : {}),
  };
  console.log(JSON.stringify(row));
  try {
    await enqueueGateLogRow(env, row);
  } catch {
    // fail-open
  }
}
