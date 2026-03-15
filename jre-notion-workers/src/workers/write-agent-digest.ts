/**
 * write-agent-digest: Creates a governance-compliant agent digest page in Docs or Home Docs.
 */
import type { Client } from "@notionhq/client";
import { getDocsDatabaseId, getHomeDocsDatabaseId } from "../shared/notion-client.js";
import { VALID_AGENT_NAMES, AGENT_DIGEST_PATTERNS, getDefaultDigestType } from "../shared/agent-config.js";
import { buildStatusLine } from "../shared/status-parser.js";
import { formatRunTime } from "../shared/date-utils.js";
import { buildDigestBlocks } from "../shared/block-builder.js";
import type {
  WriteAgentDigestInput,
  WriteAgentDigestOutput,
  FlaggedItem,
  ActionsTaken,
} from "../shared/types.js";

function buildPageTitle(params: {
  emoji: string;
  digestType: string;
  date: string;
  isError: boolean;
}): string {
  const { emoji, digestType, date, isError } = params;
  if (isError) return `${digestType} ERROR — ${date}`;
  return `${emoji} ${digestType} — ${date}`;
}

function isHeartbeat(params: {
  status_type: string;
  flagged_items: FlaggedItem[];
  actions_taken: ActionsTaken;
}): boolean {
  if (params.status_type === "heartbeat") return true;
  const { flagged_items, actions_taken } = params;
  const hasTasks =
    (actions_taken.created_tasks?.length ?? 0) > 0 ||
    (actions_taken.updated_tasks?.length ?? 0) > 0 ||
    (actions_taken.auto_closed_by_pr?.length ?? 0) > 0;
  return flagged_items.length === 0 && !hasTasks;
}

function validateFlaggedItems(items: FlaggedItem[]): string | null {
  for (const item of items) {
    if (item.task_link || item.no_task_reason) continue;
    return `FlaggedItem must have task_link or no_task_reason: "${item.description}"`;
  }
  return null;
}

function buildContentLines(input: WriteAgentDigestInput): string[] {
  const statusLine = buildStatusLine(input.status_type, input.status_value);
  const lines: string[] = [statusLine];
  const heartbeat = isHeartbeat({
    status_type: input.status_type,
    flagged_items: input.flagged_items,
    actions_taken: input.actions_taken,
  });
  if (heartbeat) {
    lines.push("Heartbeat: no actionable items");
  }
  lines.push(`Run Time: ${formatRunTime(input.run_time_chicago)}`);
  lines.push(`Scope: ${input.scope}`);
  lines.push(`Input versions: ${input.input_versions}`);
  lines.push("");

  lines.push("## Flagged Items");
  if (input.flagged_items.length === 0) {
    lines.push("None.");
  } else {
    for (const item of input.flagged_items) {
      const link = item.task_link ? ` [${item.task_link}]` : item.no_task_reason ? ` (${item.no_task_reason})` : "";
      lines.push(`- ${item.description}${link}`);
    }
  }
  lines.push("");

  lines.push("## Actions Taken");
  const created = input.actions_taken.created_tasks ?? [];
  const updated = input.actions_taken.updated_tasks ?? [];
  const autoClosed = input.actions_taken.auto_closed_by_pr ?? [];
  if (created.length > 0) {
    lines.push(`Created Tasks: ${created.map((t) => `[${t.name}](${t.notion_url})`).join(", ")}`);
  }
  if (updated.length > 0) {
    lines.push(`Updated Tasks: ${updated.map((t) => `[${t.name}](${t.notion_url})`).join(", ")}`);
  }
  if (autoClosed.length > 0) {
    lines.push(`Auto-closed by PR Merge: ${autoClosed.map((t) => `[${t.name}](${t.notion_url})`).join(", ")}`);
  }
  if (created.length === 0 && updated.length === 0 && autoClosed.length === 0) {
    lines.push("No Tasks Created");
  }
  lines.push("");

  lines.push("## Routing / Linking Summary");
  lines.push(input.summary);
  lines.push("");

  lines.push("## Unclassified / Needs Review");
  if (input.needs_review.length === 0) {
    lines.push("None.");
  } else {
    for (const r of input.needs_review) {
      lines.push(`- ${r.description}`);
    }
  }
  lines.push("");

  lines.push("## Escalations / Hand-offs");
  if (input.escalations.length === 0) {
    lines.push("None.");
  } else {
    for (const e of input.escalations) {
      lines.push(`Escalated To: ${e.escalated_to}`);
      lines.push(`Escalation Reason: ${e.escalation_reason}`);
      lines.push(`Escalation Owner: ${e.escalation_owner}`);
      lines.push(`Handoff Complete: ${e.handoff_complete ? "Yes" : "No"}`);
      lines.push("");
    }
  }
  return lines;
}

export { buildPageTitle, isHeartbeat, validateFlaggedItems };

export async function executeWriteAgentDigest(
  input: WriteAgentDigestInput,
  notion: Client
): Promise<WriteAgentDigestOutput> {
  if (!input.agent_name || !VALID_AGENT_NAMES.includes(input.agent_name)) {
    return { success: false, error: `Invalid agent_name: ${input.agent_name}` };
  }
  if (!input.status_type || !input.status_value || !input.run_time_chicago || !input.target_database) {
    return { success: false, error: "Missing required fields: status_type, status_value, run_time_chicago, target_database" };
  }
  const err = validateFlaggedItems(input.flagged_items ?? []);
  if (err) return { success: false, error: err };

  // Validate digest_type_override if provided
  if (input.digest_type_override?.trim()) {
    const validPatterns = AGENT_DIGEST_PATTERNS[input.agent_name] ?? [];
    if (!validPatterns.includes(input.digest_type_override.trim())) {
      return {
        success: false,
        error: `digest_type_override "${input.digest_type_override}" is not a valid pattern for ${input.agent_name}. Valid: ${validPatterns.join(", ")}`,
      };
    }
  }

  const heartbeat = isHeartbeat({
    status_type: input.status_type,
    flagged_items: input.flagged_items ?? [],
    actions_taken: input.actions_taken ?? { created_tasks: [], updated_tasks: [] },
  });
  const isErrorTitled =
    input.status_value === "partial" || input.status_value === "failed";
  const digestType = input.digest_type_override?.trim()
    ? input.digest_type_override.trim()
    : getDefaultDigestType(input.agent_name);
  const dateStr = formatRunTime(input.run_time_chicago).slice(0, 10);
  const title = buildPageTitle({
    emoji: input.agent_emoji,
    digestType,
    date: dateStr,
    isError: isErrorTitled,
  });

  const dbId =
    input.target_database === "home_docs" ? getHomeDocsDatabaseId() : getDocsDatabaseId();

  const contentLines = buildContentLines(input);
  const blocks = buildDigestBlocks(contentLines);

  // Property names differ between Docs and Home Docs databases
  const isHomeDocs = input.target_database === "home_docs";
  const titleProp = isHomeDocs ? "Doc" : "Name";
  const docTypeProp = isHomeDocs ? "Doc Type" : "Document Type";

  const properties: Record<string, unknown> = {
    [titleProp]: { title: [{ text: { content: title } }] },
    [docTypeProp]: { select: { name: input.doc_type } },
  };
  if (!isHomeDocs && input.client_relation_ids?.length) {
    properties["Clients"] = { relation: input.client_relation_ids.map((id) => ({ id })) };
  }
  if (input.project_relation_ids?.length) {
    properties["Project"] = { relation: input.project_relation_ids.map((id) => ({ id })) };
  }

  try {
    const page = await notion.pages.create({
      parent: { database_id: dbId },
      properties: properties as never,
      children: blocks as never[],
    });
    const pageId = "id" in page ? (page as { id: string }).id : "";
    const pageUrl = "url" in page ? (page as { url: string }).url : "";
    console.log("[write-agent-digest] created page", pageId, title);
    return {
      success: true,
      page_url: pageUrl,
      page_id: pageId,
      title,
      is_error_titled: isErrorTitled,
      is_heartbeat: heartbeat,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[write-agent-digest] Notion API error", message);
    return { success: false, error: message };
  }
}
