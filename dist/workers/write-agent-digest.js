import { resolveTargetDatabaseId, extractErrorMessage } from "../shared/notion-client.js";
import { VALID_AGENT_NAMES, AGENT_DIGEST_PATTERNS, AGENT_CADENCE, getDefaultDigestType, resolveAgentName } from "../shared/agent-config.js";
import { buildStatusLine } from "../shared/status-parser.js";
import { formatRunTime, toIsoDateTime } from "../shared/date-utils.js";
import { buildDigestBlocks } from "../shared/block-builder.js";
function buildPageTitle(params) {
    const { emoji, digestType, date, isError } = params;
    if (isError)
        return `${digestType} ERROR — ${date}`;
    return `${emoji} ${digestType} — ${date}`;
}
function isHeartbeat(params) {
    if (params.status_type === "heartbeat")
        return true;
    const { flagged_items, actions_taken } = params;
    const hasTasks = (actions_taken.created_tasks?.length ?? 0) > 0 ||
        (actions_taken.updated_tasks?.length ?? 0) > 0 ||
        (actions_taken.auto_closed_by_pr?.length ?? 0) > 0;
    return flagged_items.length === 0 && !hasTasks;
}
function validateFlaggedItems(items) {
    for (const item of items) {
        if (item.task_link || item.no_task_reason)
            continue;
        return `FlaggedItem must have task_link or no_task_reason: "${item.description}"`;
    }
    return null;
}
function buildContentLines(input) {
    const statusLine = buildStatusLine(input.status_type, input.status_value);
    const lines = [statusLine];
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
    }
    else {
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
    }
    else {
        for (const r of input.needs_review) {
            lines.push(`- ${r.description}`);
        }
    }
    lines.push("");
    lines.push("## Escalations / Hand-offs");
    if (input.escalations.length === 0) {
        lines.push("None.");
    }
    else {
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
export async function executeWriteAgentDigest(input, notion) {
    // Normalise display names (e.g. "Abstract Data - Inbox Manager" → "Inbox Manager")
    const agentName = input.agent_name ? resolveAgentName(input.agent_name) : "";
    if (!agentName || !VALID_AGENT_NAMES.includes(agentName)) {
        return { success: false, error: `Invalid agent_name: ${input.agent_name}. Valid names: ${VALID_AGENT_NAMES.join(", ")}` };
    }
    if (!input.status_type || !input.status_value || !input.run_time_chicago || !input.target_database) {
        return { success: false, error: "Missing required fields: status_type, status_value, run_time_chicago, target_database" };
    }
    const runTimeIso = toIsoDateTime(input.run_time_chicago);
    if (!runTimeIso) {
        return {
            success: false,
            error: `Invalid run_time_chicago "${input.run_time_chicago}". Expected ISO-8601 (e.g. "2026-04-27T20:31:00-05:00") or "YYYY-MM-DD HH:mm" treated as America/Chicago wall-clock.`,
        };
    }
    const err = validateFlaggedItems(input.flagged_items ?? []);
    if (err)
        return { success: false, error: err };
    // Validate digest_type_override if provided
    if (input.digest_type_override?.trim()) {
        const validPatterns = AGENT_DIGEST_PATTERNS[agentName] ?? [];
        if (!validPatterns.includes(input.digest_type_override.trim())) {
            return {
                success: false,
                error: `digest_type_override "${input.digest_type_override}" is not a valid pattern for ${agentName}. Valid: ${validPatterns.join(", ")}`,
            };
        }
    }
    const heartbeat = isHeartbeat({
        status_type: input.status_type,
        flagged_items: input.flagged_items ?? [],
        actions_taken: input.actions_taken ?? { created_tasks: [], updated_tasks: [] },
    });
    const isErrorTitled = input.status_value === "failed";
    const digestType = input.digest_type_override?.trim()
        ? input.digest_type_override.trim()
        : getDefaultDigestType(agentName);
    const dateStr = formatRunTime(input.run_time_chicago).slice(0, 10);
    const title = buildPageTitle({
        emoji: input.agent_emoji,
        digestType,
        date: dateStr,
        isError: isErrorTitled,
    });
    const dbId = resolveTargetDatabaseId(input.target_database);
    const contentLines = buildContentLines(input);
    const blocks = buildDigestBlocks(contentLines);
    // Property names differ between databases
    const isHomeDocs = input.target_database === "home_docs";
    const isAgentOps = input.target_database === "agent_ops";
    const properties = {};
    if (isAgentOps) {
        // Agent Ops schema: Name (title), Agent Name (select), Run Status (select),
        // Run Time (date), Cadence (select), Summary (text)
        properties["Name"] = { title: [{ text: { content: title } }] };
        properties["Agent Name"] = { select: { name: agentName } };
        properties["Run Status"] = { select: { name: input.status_value } };
        properties["Run Time"] = { date: { start: runTimeIso } };
        const cadence = AGENT_CADENCE[agentName];
        if (cadence) {
            properties["Cadence"] = { select: { name: cadence } };
        }
        properties["Summary"] = { rich_text: [{ text: { content: input.summary.slice(0, 2000) } }] };
    }
    else {
        // Docs / Home Docs schema
        const titleProp = isHomeDocs ? "Doc" : "Name";
        const docTypeProp = isHomeDocs ? "Doc Type" : "Document Type";
        properties[titleProp] = { title: [{ text: { content: title } }] };
        properties[docTypeProp] = { select: { name: input.doc_type } };
        if (!isHomeDocs && input.client_relation_ids?.length) {
            properties["Clients"] = { relation: input.client_relation_ids.map((id) => ({ id })) };
        }
        if (input.project_relation_ids?.length) {
            properties["Project"] = { relation: input.project_relation_ids.map((id) => ({ id })) };
        }
    }
    try {
        const page = await notion.pages.create({
            parent: { database_id: dbId },
            properties: properties,
            children: blocks,
        });
        const pageId = "id" in page ? page.id : "";
        const pageUrl = "url" in page ? page.url : "";
        console.log("[write-agent-digest] created page", pageId, title);
        return {
            success: true,
            page_url: pageUrl,
            page_id: pageId,
            title,
            is_error_titled: isErrorTitled,
            is_heartbeat: heartbeat,
        };
    }
    catch (e) {
        const message = extractErrorMessage(e);
        console.error("[write-agent-digest] Notion API error", message);
        return { success: false, error: message };
    }
}
