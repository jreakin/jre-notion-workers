/**
 * Deterministic (no-AI) echo + untracked-property filter (LOCK-69). LIVE: runs in the forward path
 * after the gate_log drop and BEFORE the CoS pre-filter, the shadow wake gates (incl. Clef) and the
 * coalesce/forward. A dropped event gets 200 and wakes nobody.
 *
 * Rules (config lives in echo-filter-config.ts):
 *  1. own_echo        comment.* whose authors are all own-fleet: webhook author type "bot" (any
 *                     integration, incl. this relay's own) or an id in FLEET_COMMENTS_BOT_NOTION_USER_IDS /
 *                     the GrokBot Fleet Comments bot. Enforces the shadow rule notion_comments_echo_drop /
 *                     fleet_comments_bot_echo (rows carry legacy_gate / legacy_reason for log continuity).
 *     agent_prefix    comment.* whose text starts with an agent lane prefix (CoS:, BCH:, AS:, [Steward],
 *                     EC → ...). John-authored comments always pass first (so John @mentioning an agent,
 *                     or even writing "CoS: …", is never dropped). Fails open when JOHN_NOTION_USER_IDS is unset.
 *  2. untracked_property_edit  page.properties_updated whose parent database / data source is not in
 *                     the tracked allowlist. Fails open: allowlist empty, parent unknown, or a Submitted /
 *                     Needs John property change ⇒ pass. page.created and every other type pass.
 *  3. Every verdict (drop AND pass) is logged with a reason code: stdout JSON + gate_log ring stream
 *     `echo_filter`. Never logs comment text, titles, page ids or author ids — parent ids only on
 *     untracked_property_edit drops (so the allowlist can be tuned).
 *
 * decideEchoFilter is pure (no I/O) and never throws (errors ⇒ pass).
 */
import type { Env } from "../env.js";
import { enqueueGateLogRow } from "../gate-log-ring.js";
import {
  BOT_AUTHOR_TYPES,
  COMMENT_EVENT_TYPES,
  PROPERTY_ONLY_EVENT_TYPES,
  type EchoFilterConfig,
} from "./echo-filter-config.js";
import { isTruthyFlag } from "./gate-context-safety.js";
import type { GateEventContext } from "./gate-event-types.js";
import { normalizeNotionUuid } from "./notion-ids.js";

export const ECHO_FILTER_STREAM = "echo_filter" as const;

export type EchoFilterDropReason = "own_echo" | "agent_prefix" | "untracked_property_edit";

export type EchoFilterPassReason =
  | "filter_disabled"
  | "author_unknown"
  | "john_authored"
  | "john_ids_unset"
  | "comment_passed"
  | "allowlist_unset"
  | "must_wake_property"
  | "parent_unknown"
  | "tracked_parent"
  | "not_filtered_type"
  | `error:${string}`;

export type EchoFilterVerdict =
  | { decision: "drop"; reason: EchoFilterDropReason; parentId?: string }
  | { decision: "pass"; reason: EchoFilterPassReason };

/** Existing shadow rule this filter enforces (kept on own_echo rows for log continuity). */
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

/** Comment text (plain_text of every rich text part, mentions included), or null when absent. */
export function commentPlainText(parsed: Record<string, unknown>): string | null {
  const data = asRecord(parsed.data);
  if (!data) return null;
  if (typeof data.text === "string") return data.text;
  const rich = data.rich_text ?? data.content;
  if (!Array.isArray(rich)) return null;
  let out = "";
  for (const part of rich) {
    const rec = asRecord(part);
    if (rec && typeof rec.plain_text === "string") out += rec.plain_text;
  }
  return out;
}

function isJohnAuthor(a: Author, cfg: EchoFilterConfig): boolean {
  return Boolean(a.id && cfg.johnUserIds.has(normalizeNotionUuid(a.id)));
}

function isOwnFleetAuthor(a: Author, cfg: EchoFilterConfig): boolean {
  if (a.type && (BOT_AUTHOR_TYPES as readonly string[]).includes(a.type)) return true;
  return Boolean(a.id && cfg.fleetBotIds.has(normalizeNotionUuid(a.id)));
}

/** Parent database / data source ids from the gate context plus the raw `data.parent` block. */
function parentIds(parsed: Record<string, unknown>, ctx: GateEventContext): string[] {
  const ids = new Set<string>();
  if (ctx.webhookParentDataSourceId) ids.add(ctx.webhookParentDataSourceId);
  if (ctx.webhookParentDatabaseId) ids.add(ctx.webhookParentDatabaseId);
  const parent = asRecord(asRecord(parsed.data)?.parent);
  if (parent) {
    for (const k of ["data_source_id", "database_id"]) {
      if (typeof parent[k] === "string" && parent[k]) ids.add(parent[k] as string);
    }
    const t = parent.type;
    if (
      typeof parent.id === "string" &&
      parent.id &&
      (t === "database" || t === "database_id" || t === "data_source" || t === "data_source_id")
    ) {
      ids.add(parent.id);
    }
  }
  return [...ids];
}

function decodePropId(id: string): string {
  const t = id.trim();
  try {
    return decodeURIComponent(t);
  } catch {
    return t;
  }
}

/**
 * The edit explicitly touches a Submitted (SUBMITTED_PROPERTY_IDS) or Needs John (NEEDS_JOHN_PROPERTY_IDS)
 * property, or the payload says Needs John is set. Deliberately NOT submittedPropertyChanged(): that one
 * treats any unknown property id as "maybe Submitted" (Fleet Locks-specific), which would disable rule 2.
 */
function mustWakePropertyEdit(ctx: GateEventContext): boolean {
  if (isTruthyFlag(ctx.properties?.needsJohn)) return true;
  const watched = new Set<string>();
  for (const id of [...ctx.submittedPropertyIds, ...(ctx.needsJohnPropertyIds ?? [])]) watched.add(decodePropId(id));
  return ctx.updatedPropertyIds.some((id) => watched.has(decodePropId(id)));
}

export function decideEchoFilter(
  parsed: Record<string, unknown>,
  ctx: GateEventContext,
  cfg: EchoFilterConfig,
): EchoFilterVerdict {
  try {
    if (!cfg.enabled) return { decision: "pass", reason: "filter_disabled" };
    const type = ctx.notionType ?? "";

    if ((COMMENT_EVENT_TYPES as readonly string[]).includes(type)) {
      const authors = readAuthors(parsed);
      if (authors.length === 0) return { decision: "pass", reason: "author_unknown" };
      if (authors.some((a) => isJohnAuthor(a, cfg))) return { decision: "pass", reason: "john_authored" };
      if (authors.every((a) => isOwnFleetAuthor(a, cfg))) return { decision: "drop", reason: "own_echo" };
      const text = commentPlainText(parsed);
      if (text !== null && cfg.lanePrefixRe.test(text)) {
        // Without John's ids a John comment can't be told apart: never drop on text alone.
        if (cfg.johnUserIds.size === 0) return { decision: "pass", reason: "john_ids_unset" };
        return { decision: "drop", reason: "agent_prefix" };
      }
      return { decision: "pass", reason: "comment_passed" };
    }

    if ((PROPERTY_ONLY_EVENT_TYPES as readonly string[]).includes(type)) {
      if (cfg.trackedParentIds.size === 0) return { decision: "pass", reason: "allowlist_unset" };
      if (mustWakePropertyEdit(ctx)) {
        return { decision: "pass", reason: "must_wake_property" };
      }
      const parents = parentIds(parsed, ctx);
      if (parents.length === 0) return { decision: "pass", reason: "parent_unknown" };
      if (parents.some((id) => cfg.trackedParentIds.has(normalizeNotionUuid(id)))) {
        return { decision: "pass", reason: "tracked_parent" };
      }
      return { decision: "drop", reason: "untracked_property_edit", parentId: parents[0] };
    }

    return { decision: "pass", reason: "not_filtered_type" };
  } catch (err) {
    return { decision: "pass", reason: `error:${err instanceof Error ? err.name : "Error"}` };
  }
}

/** Gate-log row for one verdict. IDs and reason codes only. */
export function echoFilterLogRow(
  ctx: GateEventContext,
  verdict: EchoFilterVerdict,
  cfg: Pick<EchoFilterConfig, "enabled">,
): { stream: typeof ECHO_FILTER_STREAM } & Record<string, unknown> {
  return {
    stream: ECHO_FILTER_STREAM,
    ts: new Date().toISOString(),
    gate: ECHO_FILTER_STREAM,
    event: ctx.notionType,
    event_key: ctx.eventKey ?? "unknown",
    decision: verdict.decision,
    reason: verdict.reason,
    mode: cfg.enabled ? "live" : "off",
    dropped: verdict.decision === "drop",
    ...(verdict.decision === "drop" && verdict.reason === "own_echo"
      ? { legacy_gate: LEGACY_ECHO_GATE, legacy_reason: LEGACY_ECHO_REASON }
      : {}),
    ...(verdict.decision === "drop" && verdict.parentId ? { parent_id: verdict.parentId } : {}),
  };
}

/** Log one verdict (stdout + gate_log ring). Fail-open: logging errors never reach the forward path. */
export async function logEchoFilter(
  env: Env,
  ctx: GateEventContext,
  verdict: EchoFilterVerdict,
  cfg: Pick<EchoFilterConfig, "enabled">,
): Promise<void> {
  const row = echoFilterLogRow(ctx, verdict, cfg);
  console.log(JSON.stringify(row));
  try {
    await enqueueGateLogRow(env, row);
  } catch {
    // fail-open
  }
}
