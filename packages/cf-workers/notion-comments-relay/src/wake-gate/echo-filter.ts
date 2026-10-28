/**
 * Deterministic (no-AI) echo + untracked-property filter (LOCK-69). LIVE: runs in the forward path
 * after the gate_log drop and BEFORE the CoS pre-filter, the shadow wake gates (incl. Clef) and the
 * coalesce/enqueue. A dropped event gets 200, wakes nobody, and writes ONE deterministic `rule_skip`
 * shadow row to gate_log (stream clef_wake_shadow, scored:false; no Workers AI call, no clef:mode:* read).
 *
 * Rules (config in echo-filter-config.ts):
 *  own_echo      comment.* / page.moved whose authors are ALL fleet bots (explicit id list +
 *                FLEET_COMMENTS_BOT_NOTION_USER_IDS). Never the Notion system bot; never properties_updated.
 *                Fleet-authored comment.deleted drops too.
 *  agent_prefix  comment.created / comment.updated whose text starts with the LOCK-39 full form
 *                "<Lane> Agent for John Eakin —" (or "for Shadow Seeker"). Beats the John keep (agents post
 *                through John's account). The webhook has no body, so the text comes from
 *                GET /v1/comments/{id} (~3 s, fail open: no text ⇒ pass). Short tags ("CoS:", "AS:") never
 *                drop a human author.
 *  untracked_property_edit  page.properties_updated whose parent (data.parent id / data_source_id /
 *                database_id, dashless) is not tracked, or whose parent is a page. Edits touching
 *                SUBMITTED_PROPERTY_IDS / NEEDS_JOHN_PROPERTY_IDS pass FIRST, whatever the parent (Day Logs);
 *                the submitted_changed label applies on Fleet: Artifacts. Allowlist empty ⇒ fail open.
 *
 * John-authored comments otherwise pass (incl. @mentions — the only mention keep). John-authored
 * comment.deleted is kept (conservative). page.created and everything else pass.
 * decideEchoFilter is pure (no I/O) and never throws (errors ⇒ pass).
 */
import type { Env } from "../env.js";
import { enqueueGateLogRow } from "../gate-log-ring.js";
import { opaqueLogItemId } from "./clef-wake-gate.js";
import {
  AUTHOR_ECHO_EVENT_TYPES,
  COMMENT_EVENT_TYPES,
  decodePropertyId,
  FLEET_ARTIFACTS_DATA_SOURCE_ID,
  PROPERTY_ONLY_EVENT_TYPES,
  stripLeadForPrefix,
  type EchoFilterConfig,
} from "./echo-filter-config.js";
import type { GateEventContext } from "./gate-event-types.js";
import { NOTION_VERSION_PAGE } from "./notion-page-fetch.js";
import { normalizeNotionUuid } from "./notion-ids.js";

export const ECHO_FILTER_STREAM = "echo_filter" as const;
/** Comment body fetch budget (spec: ~3 s). Runs before the webhook's 200; fail open on timeout. */
export const COMMENT_FETCH_MS = 3_000;

export type EchoFilterDropReason = "own_echo" | "agent_prefix" | "untracked_property_edit";
export type EchoFilterRule = "fleet_bot_author" | "lock39_full_prefix" | "untracked_parent" | "page_parent";

export type EchoFilterPassReason =
  | "filter_disabled"
  | "author_unknown"
  | "john_authored"
  | "john_deleted_keep"
  | "comment_passed"
  | "not_fleet_author"
  | "allowlist_unset"
  | "parent_unknown"
  | "tracked_parent"
  | "submitted_changed"
  | "must_wake_property"
  | "property_ids_unknown"
  | "not_filtered_type"
  | `error:${string}`;

export type EchoFilterVerdict =
  | {
      decision: "drop";
      reason: EchoFilterDropReason;
      rule: EchoFilterRule;
      parentDataSourceId?: string;
    }
  | { decision: "pass"; reason: EchoFilterPassReason };

/** Existing shadow rule own_echo enforces (kept on own_echo rows for log continuity). */
export const LEGACY_ECHO_GATE = "notion_comments_echo_drop";
export const LEGACY_ECHO_REASON = "fleet_comments_bot_echo";

type Author = { id?: string; type?: string };

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function readAuthors(parsed: Record<string, unknown>): Author[] {
  if (!Array.isArray(parsed.authors)) return [];
  const out: Author[] = [];
  for (const a of parsed.authors) {
    const rec = asRecord(a);
    if (!rec) continue;
    out.push({
      id: typeof rec.id === "string" && rec.id ? rec.id : undefined,
      type: typeof rec.type === "string" ? rec.type : undefined,
    });
  }
  return out;
}

function richTextPlain(rich: unknown): string | null {
  if (!Array.isArray(rich)) return null;
  let out = "";
  for (const part of rich) {
    const rec = asRecord(part);
    if (rec && typeof rec.plain_text === "string") out += rec.plain_text;
  }
  return out;
}

/** Comment text carried in the webhook payload (normally absent), or null. */
export function commentPlainText(parsed: Record<string, unknown>): string | null {
  const data = asRecord(parsed.data);
  if (!data) return null;
  if (typeof data.text === "string") return data.text;
  return richTextPlain(data.rich_text ?? data.content);
}

const isIn = (list: readonly string[], v: string) => list.includes(v);

function isJohnAuthor(a: Author, cfg: EchoFilterConfig): boolean {
  return Boolean(a.id && cfg.johnUserIds.has(normalizeNotionUuid(a.id)));
}

function isFleetAuthor(a: Author, cfg: EchoFilterConfig): boolean {
  return Boolean(a.id && cfg.fleetBotIds.has(normalizeNotionUuid(a.id)));
}

function allFleet(authors: Author[], cfg: EchoFilterConfig): boolean {
  return authors.length > 0 && authors.every((a) => isFleetAuthor(a, cfg));
}

/** Parent ids (data.parent id / data_source_id / database_id + gate context) and whether it is a page. */
function readParent(
  parsed: Record<string, unknown>,
  ctx: GateEventContext,
): { ids: string[]; dataSourceId?: string; isPage: boolean } {
  const ids = new Set<string>();
  let dataSourceId: string | undefined = ctx.webhookParentDataSourceId;
  if (ctx.webhookParentDataSourceId) ids.add(ctx.webhookParentDataSourceId);
  if (ctx.webhookParentDatabaseId) ids.add(ctx.webhookParentDatabaseId);
  let isPage = false;
  const parent = asRecord(asRecord(parsed.data)?.parent);
  if (parent) {
    const t = typeof parent.type === "string" ? parent.type : "";
    if (typeof parent.data_source_id === "string" && parent.data_source_id) {
      ids.add(parent.data_source_id);
      dataSourceId = dataSourceId ?? parent.data_source_id;
    }
    if (typeof parent.database_id === "string" && parent.database_id) ids.add(parent.database_id);
    if (t === "page" || t === "page_id" || (typeof parent.page_id === "string" && parent.page_id)) {
      isPage = true;
    } else if (typeof parent.id === "string" && parent.id && t !== "workspace" && t !== "block_id" && t !== "block") {
      // "match data.parent id OR data_source_id": a database / data_source parent's id.
      ids.add(parent.id);
      if (t === "data_source" || t === "data_source_id") dataSourceId = dataSourceId ?? parent.id;
    }
  }
  return { ids: [...ids], dataSourceId: dataSourceId ?? [...ids][0], isPage: isPage && ids.size === 0 };
}

function submittedTouched(ctx: GateEventContext, cfg: EchoFilterConfig): boolean {
  return ctx.updatedPropertyIds.some((id) => cfg.submittedPropertyIds.has(decodePropertyId(id)));
}

/** NEEDS_JOHN_PROPERTY_IDS touched, or the payload says Needs John is set. */
function needsJohnTouched(ctx: GateEventContext, cfg: EchoFilterConfig): boolean {
  if (ctx.properties?.needsJohn === true) return true;
  return ctx.updatedPropertyIds.some((id) => cfg.needsJohnPropertyIds.has(decodePropertyId(id)));
}

/**
 * @param commentText text fetched for this comment (null = fetch failed / unavailable ⇒ fail open);
 *   undefined = not fetched, use the payload text.
 */
export function decideEchoFilter(
  parsed: Record<string, unknown>,
  ctx: GateEventContext,
  cfg: EchoFilterConfig,
  commentText?: string | null,
): EchoFilterVerdict {
  try {
    if (!cfg.enabled) return { decision: "pass", reason: "filter_disabled" };
    const type = ctx.notionType ?? "";
    const authors = readAuthors(parsed);

    if (isIn(AUTHOR_ECHO_EVENT_TYPES, type) && allFleet(authors, cfg)) {
      return { decision: "drop", reason: "own_echo", rule: "fleet_bot_author" };
    }

    if (isIn(COMMENT_EVENT_TYPES, type)) {
      if (authors.length === 0) return { decision: "pass", reason: "author_unknown" };
      const john = authors.some((a) => isJohnAuthor(a, cfg));
      if (type === "comment.deleted") {
        return { decision: "pass", reason: john ? "john_deleted_keep" : "comment_passed" };
      }
      const text = commentText === undefined ? commentPlainText(parsed) : commentText;
      if (text !== null && cfg.lock39Re.test(stripLeadForPrefix(text))) {
        return { decision: "drop", reason: "agent_prefix", rule: "lock39_full_prefix" };
      }
      return { decision: "pass", reason: john ? "john_authored" : "comment_passed" };
    }

    if (type === "page.moved") return { decision: "pass", reason: "not_fleet_author" };

    if (isIn(PROPERTY_ONLY_EVENT_TYPES, type)) {
      if (cfg.trackedParentIds.size === 0) return { decision: "pass", reason: "allowlist_unset" };
      const parent = readParent(parsed, ctx);
      const tracked = parent.ids.filter((id) => cfg.trackedParentIds.has(normalizeNotionUuid(id)));
      const artifacts = normalizeNotionUuid(FLEET_ARTIFACTS_DATA_SOURCE_ID);
      const submitted = submittedTouched(ctx, cfg);
      // (c) label: Submitted on a tracked Fleet: Artifacts parent.
      if (submitted && tracked.some((id) => normalizeNotionUuid(id) === artifacts)) {
        return { decision: "pass", reason: "submitted_changed" };
      }
      // (a) Submitted / Needs John edits pass whatever the parent (Day Logs are untracked on purpose).
      if (submitted || needsJohnTouched(ctx, cfg)) return { decision: "pass", reason: "must_wake_property" };
      // No updated property ids in the payload: the exemption can't be checked. Fail toward waking only
      // when Needs John ids are configured (otherwise a Needs John edit is undetectable anyway).
      if (ctx.updatedPropertyIds.length === 0 && cfg.needsJohnPropertyIds.size > 0) {
        return { decision: "pass", reason: "property_ids_unknown" };
      }
      // (b) untracked or page parent ⇒ drop.
      if (parent.ids.length === 0) {
        if (parent.isPage) return { decision: "drop", reason: "untracked_property_edit", rule: "page_parent" };
        return { decision: "pass", reason: "parent_unknown" };
      }
      if (tracked.length === 0) {
        return {
          decision: "drop",
          reason: "untracked_property_edit",
          rule: "untracked_parent",
          parentDataSourceId: parent.dataSourceId,
        };
      }
      return { decision: "pass", reason: "tracked_parent" };
    }

    return { decision: "pass", reason: "not_filtered_type" };
  } catch (err) {
    return { decision: "pass", reason: `error:${err instanceof Error ? err.name : "Error"}` };
  }
}

// ---------- comment body fetch (fail open) ----------

export type CommentFetchOutcome =
  | "payload"
  | "not_needed"
  | "ok"
  | "no_token"
  | "no_comment_id"
  | "timeout"
  | "error"
  | `http_${number}`;

/** True when the LOCK-39 check needs the comment body (created/updated, non-fleet author, no payload text). */
export function commentNeedsBodyFetch(
  parsed: Record<string, unknown>,
  ctx: GateEventContext,
  cfg: EchoFilterConfig,
): boolean {
  if (!cfg.enabled) return false;
  const type = ctx.notionType ?? "";
  if (type !== "comment.created" && type !== "comment.updated") return false;
  const authors = readAuthors(parsed);
  if (authors.length === 0 || allFleet(authors, cfg)) return false;
  return commentPlainText(parsed) === null;
}

/** GET /v1/comments/{id}. Never throws: any failure ⇒ { text: null } (caller passes = wake). */
export async function fetchCommentText(
  token: string | undefined,
  commentId: string | undefined,
  opts: { timeoutMs?: number } = {},
): Promise<{ text: string | null; outcome: CommentFetchOutcome }> {
  if (!token?.trim()) return { text: null, outcome: "no_token" };
  if (!commentId) return { text: null, outcome: "no_comment_id" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? COMMENT_FETCH_MS);
  try {
    const res = await fetch(`https://api.notion.com/v1/comments/${encodeURIComponent(commentId)}`, {
      method: "GET",
      headers: { authorization: `Bearer ${token.trim()}`, "notion-version": NOTION_VERSION_PAGE },
      signal: controller.signal,
    });
    if (!res.ok) return { text: null, outcome: `http_${res.status}` };
    const body = asRecord(await res.json());
    const text = richTextPlain(body?.rich_text);
    return text === null ? { text: null, outcome: "error" } : { text, outcome: "ok" };
  } catch (err) {
    return { text: null, outcome: err instanceof Error && err.name === "AbortError" ? "timeout" : "error" };
  } finally {
    clearTimeout(timer);
  }
}

/** Text for decideEchoFilter: undefined when no fetch is needed, else the fetched text (null on failure). */
export async function resolveEchoCommentText(
  env: Pick<Env, "NOTION_API_TOKEN">,
  parsed: Record<string, unknown>,
  ctx: GateEventContext,
  cfg: EchoFilterConfig,
  opts: { timeoutMs?: number } = {},
): Promise<{ text: string | null | undefined; outcome: CommentFetchOutcome }> {
  if (!commentNeedsBodyFetch(parsed, ctx, cfg)) {
    return { text: undefined, outcome: commentPlainText(parsed) === null ? "not_needed" : "payload" };
  }
  return fetchCommentText(env.NOTION_API_TOKEN, ctx.commentId, opts);
}

// ---------- logging ----------

/**
 * The ONE gate_log row for a drop: a deterministic clef_wake_shadow `rule_skip` entry. scored:false,
 * no model fields, mode "deterministic" (clef:mode:* is never read). IDs and reason codes only.
 */
export function echoFilterRuleSkipRow(
  ctx: GateEventContext,
  verdict: Extract<EchoFilterVerdict, { decision: "drop" }>,
): { stream: "clef_wake_shadow" } & Record<string, unknown> {
  const isComment = ctx.isCommentEvent;
  const itemId = (isComment ? ctx.commentId : ctx.pageId) ?? ctx.pageId ?? "unknown";
  return {
    stream: "clef_wake_shadow",
    ts: new Date().toISOString(),
    gate: "clef_wake",
    source: ECHO_FILTER_STREAM,
    decision: "rule_skip",
    event: ctx.notionType,
    notion_type: ctx.notionType,
    event_key: ctx.eventKey ?? "unknown",
    item_id: opaqueLogItemId(itemId),
    rule_decision: "would_skip",
    clef_decision: "would_skip",
    p_action: null,
    p_dup: null,
    q_when: null,
    confidence: null,
    model: null,
    latency_ms: null,
    sampled_full: null,
    mode: "deterministic",
    actually_ran: "echo_filter",
    reason: `rule_skip:${verdict.reason}`,
    echo_reason: verdict.reason,
    rule: verdict.rule,
    scored: false,
    candidate_false_skip: false,
    parent_data_source_id: verdict.parentDataSourceId ?? null,
    ...(isComment ? { comment_id: ctx.commentId ?? null } : { page_id: ctx.pageId ?? null }),
    ...(verdict.reason === "own_echo" ? { legacy_gate: LEGACY_ECHO_GATE, legacy_reason: LEGACY_ECHO_REASON } : {}),
  };
}

/** Pass row (stream echo_filter). IDs and reason codes only. */
export function echoFilterPassRow(
  ctx: GateEventContext,
  verdict: Extract<EchoFilterVerdict, { decision: "pass" }>,
  cfg: Pick<EchoFilterConfig, "enabled">,
  bodyFetch?: CommentFetchOutcome,
): { stream: typeof ECHO_FILTER_STREAM } & Record<string, unknown> {
  return {
    stream: ECHO_FILTER_STREAM,
    ts: new Date().toISOString(),
    gate: ECHO_FILTER_STREAM,
    event: ctx.notionType,
    event_key: ctx.eventKey ?? "unknown",
    decision: "pass",
    reason: verdict.reason,
    mode: cfg.enabled ? "live" : "off",
    dropped: false,
    ...(bodyFetch && bodyFetch !== "not_needed" ? { body_fetch: bodyFetch } : {}),
  };
}

/** Log one verdict: drop ⇒ the rule_skip row; pass ⇒ an echo_filter row. stdout + gate_log, fail-open. */
export async function logEchoFilter(
  env: Env,
  ctx: GateEventContext,
  verdict: EchoFilterVerdict,
  cfg: Pick<EchoFilterConfig, "enabled">,
  bodyFetch?: CommentFetchOutcome,
): Promise<void> {
  const row =
    verdict.decision === "drop" ? echoFilterRuleSkipRow(ctx, verdict) : echoFilterPassRow(ctx, verdict, cfg, bodyFetch);
  console.log(JSON.stringify(row));
  try {
    await enqueueGateLogRow(env, row);
  } catch {
    // fail-open
  }
}
