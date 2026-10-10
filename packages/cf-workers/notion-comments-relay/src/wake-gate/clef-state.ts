import {
  CLEF_FIELD_SHORT_MAX_CHARS,
  CLEF_SNIPPET_MAX_CHARS,
  CLEF_STATE_MAX_CHARS,
  CLEF_TITLE_MAX_CHARS,
} from "./clef-thresholds.js";
import { isJohn } from "./gate-context-safety.js";
import { idInNotionIdSet } from "./notion-ids.js";
import type { GateEventContext } from "./gate-event-types.js";

export type ClefEventSource = "notion_comment" | "notion_page" | "capture_queue" | "github_merge";

function sanitizeField(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x0d || code === 0x0a) {
      out += " ";
      continue;
    }
    if (code === 0x2028 || code === 0x2029) {
      out += " ";
      continue;
    }
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      continue;
    }
    out += value[i];
  }
  return out.trim();
}

function encodeStateTextField(value: string, maxChars: number): string {
  const clean = truncateCodePoints(value, maxChars);
  return JSON.stringify(clean);
}

function truncateCodePoints(value: string, maxChars: number): string {
  const clean = sanitizeField(value);
  const chars: string[] = [];
  for (const ch of clean) {
    if (chars.length >= maxChars) {
      break;
    }
    chars.push(ch);
  }
  if (chars.length < clean.length) {
    return `${chars.join("")}…`;
  }
  return chars.join("");
}

function truncateStateSafe(state: string): string {
  const max = CLEF_STATE_MAX_CHARS - 1;
  const chars: string[] = [];
  for (const ch of state) {
    if (chars.length >= max) {
      break;
    }
    chars.push(ch);
  }
  return chars.join("");
}

export function mapClefSource(_ctx: GateEventContext, notionType: string | null): ClefEventSource {
  const t = notionType || "";
  if (t.startsWith("comment.")) {
    return "notion_comment";
  }
  if (t.includes("github") && t.includes("merge")) {
    return "github_merge";
  }
  if (t.includes("capture")) {
    return "capture_queue";
  }
  return "notion_page";
}

export function authorKind(ctx: GateEventContext): "john" | "agent" | "bot" | "other" {
  if (isJohn(ctx)) {
    return "john";
  }
  const authorId = ctx.authorId;
  if (authorId && idInNotionIdSet(authorId, ctx.fleetCommentsBotIds)) {
    return "bot";
  }
  const kind = ctx.properties?.kind?.toLowerCase() ?? "";
  if (kind.includes("agent")) {
    return "agent";
  }
  return "other";
}

function triStateFlag(
  ctx: GateEventContext,
  value: boolean | undefined,
): "true" | "false" | "unknown" {
  if (!ctx.propertiesAvailable) {
    return "unknown";
  }
  return value === true ? "true" : "false";
}

function readSnippetFromPayload(parsed: Record<string, unknown>): string {
  const data = parsed.data;
  if (!data || typeof data !== "object") {
    return "";
  }
  const rec = data as Record<string, unknown>;
  const text = rec.text;
  if (typeof text === "string") {
    return truncateCodePoints(text, CLEF_SNIPPET_MAX_CHARS);
  }
  const rich = rec.rich_text ?? rec.content;
  if (Array.isArray(rich)) {
    let out = "";
    for (const part of rich) {
      if (part && typeof part === "object" && "plain_text" in part) {
        const pt = (part as { plain_text?: unknown }).plain_text;
        if (typeof pt === "string") {
          out += pt;
        }
      }
    }
    return truncateCodePoints(out, CLEF_SNIPPET_MAX_CHARS);
  }
  return "";
}

export function buildClefStateString(
  ctx: GateEventContext,
  notionType: string | null,
  parsed: Record<string, unknown>,
  pageEventsLast60s: number,
  isBotEcho: boolean,
): string {
  const props = ctx.properties ?? {};
  const parentDb = truncateCodePoints(
    ctx.parentDatabaseTitle ?? "unknown",
    CLEF_FIELD_SHORT_MAX_CHARS,
  );
  const kind = truncateCodePoints(props.kind ?? "", CLEF_FIELD_SHORT_MAX_CHARS);
  const authorLane = truncateCodePoints(props.authorLane ?? "", CLEF_FIELD_SHORT_MAX_CHARS);
  const targetLane = truncateCodePoints(props.authorLane ?? "", CLEF_FIELD_SHORT_MAX_CHARS);
  const status = truncateCodePoints(
    ctx.fleetLocksFields?.statusName ?? "",
    CLEF_FIELD_SHORT_MAX_CHARS,
  );

  const lines = [
    `source=${mapClefSource(ctx, notionType)}`,
    `event=${truncateCodePoints(notionType ?? "unknown", CLEF_FIELD_SHORT_MAX_CHARS)}`,
    `author_kind=${authorKind(ctx)}`,
    `parent_db=${parentDb}`,
    `kind=${kind}`,
    `status=${status}`,
    `author_lane=${authorLane}`,
    `needs_john=${triStateFlag(ctx, props.needsJohn)}`,
    `sensitive=${triStateFlag(ctx, props.sensitive)}`,
    `target_lane=${targetLane}`,
    `page_events_60s=${pageEventsLast60s}`,
    `bot_echo=${isBotEcho}`,
    `title=${encodeStateTextField(props.title ?? "", CLEF_TITLE_MAX_CHARS)}`,
    `snippet=${encodeStateTextField(readSnippetFromPayload(parsed), CLEF_SNIPPET_MAX_CHARS)}`,
  ];
  return truncateStateSafe(lines.join("\n"));
}
