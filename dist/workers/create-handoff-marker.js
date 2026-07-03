import { getTasksDatabaseId, APIResponseError, extractErrorMessage, queryDatabase } from "../shared/notion-client.js";
import { VALID_AGENT_NAMES, resolveAgentName } from "../shared/agent-config.js";
import { nextBusinessDay } from "../shared/date-utils.js";
const HANDOFF_WINDOW_DAYS = 7;
const ESCALATION_CAP = 2;
function buildHandoffBlock(params) {
    return [
        `Escalated To: ${params.target_agent}`,
        `Escalation Reason: ${params.escalation_reason}`,
        `Escalation Owner: ${params.target_agent}`,
        "Handoff Complete: No",
        `Source: ${params.source_digest_url}`,
    ].join("\n");
}
export async function executeCreateHandoffMarker(input, notion) {
    const sourceAgent = input.source_agent ? resolveAgentName(input.source_agent) : "";
    const targetAgent = input.target_agent ? resolveAgentName(input.target_agent) : "";
    if (!sourceAgent || !VALID_AGENT_NAMES.includes(sourceAgent)) {
        return {
            success: false,
            error: `Invalid source_agent: ${input.source_agent}. Valid names: ${VALID_AGENT_NAMES.join(", ")}`,
        };
    }
    if (!targetAgent || !VALID_AGENT_NAMES.includes(targetAgent)) {
        return {
            success: false,
            error: `Invalid target_agent: ${input.target_agent}. Valid names: ${VALID_AGENT_NAMES.join(", ")}`,
        };
    }
    if (!input.escalation_reason?.trim() || !input.source_digest_url?.trim()) {
        return {
            success: false,
            error: "escalation_reason and source_digest_url are required",
        };
    }
    if (input.create_task && !input.task_priority) {
        return {
            success: false,
            error: "task_priority is required when create_task is true",
        };
    }
    const handoffBlock = buildHandoffBlock({
        target_agent: input.target_agent,
        escalation_reason: input.escalation_reason,
        source_digest_url: input.source_digest_url,
    });
    let taskCreated = false;
    let taskUrl = null;
    let taskId = null;
    let duplicatePrevented = false;
    let existingTaskUrl = null;
    let escalationCapped = false;
    let needsManualReview = false;
    if (input.create_task) {
        try {
            const tasksDbId = getTasksDatabaseId();
            const since = new Date();
            since.setDate(since.getDate() - HANDOFF_WINDOW_DAYS);
            const sinceMs = since.getTime();
            const existingResponse = await queryDatabase(notion, tasksDbId, {
                filter: {
                    property: "Task Name",
                    title: {
                        contains: `Handoff: ${input.source_agent} → ${input.target_agent}`,
                    },
                },
                sorts: [{ timestamp: "created_time", direction: "descending" }],
                page_size: 20,
            });
            const withinWindow = (existingResponse.results ?? []).filter((p) => {
                const ct = p.created_time;
                if (!ct)
                    return false;
                return new Date(ct).getTime() >= sinceMs;
            });
            // Circuit breaker: prevent duplicate if ANY matching handoff task exists
            // in the window — open OR recently closed (e.g. auto-closed by PR merge).
            // Previously only checked open tasks, which caused duplicates when the
            // GitHub PR "Merged → Done" rule auto-closed a handoff task.
            if (withinWindow.length > 0) {
                const first = withinWindow[0];
                duplicatePrevented = true;
                existingTaskUrl = first.url ?? null;
                console.log("[create-handoff-marker] circuit breaker: existing handoff task", first.id);
                return {
                    success: true,
                    handoff_block: handoffBlock,
                    task_created: false,
                    task_url: null,
                    task_id: null,
                    duplicate_prevented: true,
                    existing_task_url: existingTaskUrl,
                    escalation_capped: false,
                    needs_manual_review: false,
                };
            }
            const countSameDirection = withinWindow.length;
            if (countSameDirection >= ESCALATION_CAP) {
                escalationCapped = true;
                needsManualReview = true;
                console.log("[create-handoff-marker] escalation cap reached", input.source_agent, "→", input.target_agent);
                return {
                    success: true,
                    handoff_block: handoffBlock,
                    task_created: false,
                    task_url: null,
                    task_id: null,
                    duplicate_prevented: false,
                    existing_task_url: null,
                    escalation_capped: true,
                    needs_manual_review: true,
                };
            }
            const dueDate = nextBusinessDay();
            const dueStr = dueDate.toISOString().slice(0, 10);
            const taskTitle = `Handoff: ${input.source_agent} → ${input.target_agent} — ${dueStr}`;
            const taskNotes = `Escalation from ${input.source_agent}. Reason: ${input.escalation_reason}. Source digest: ${input.source_digest_url}`;
            const taskProps = {
                "Task Name": { title: [{ text: { content: taskTitle } }] },
                "Priority": { select: { name: input.task_priority } },
                "Due": { date: { start: dueStr } },
            };
            if (input.client_relation_ids?.length) {
                taskProps["Client"] = { relation: input.client_relation_ids.map((id) => ({ id })) };
            }
            if (input.project_relation_ids?.length) {
                taskProps["Project"] = { relation: input.project_relation_ids.map((id) => ({ id })) };
            }
            const taskPage = await notion.pages.create({
                parent: { database_id: tasksDbId },
                properties: taskProps,
                children: [
                    {
                        type: "paragraph",
                        paragraph: {
                            rich_text: [{ type: "text", text: { content: taskNotes } }],
                        },
                    },
                ],
            });
            taskId = "id" in taskPage ? taskPage.id : null;
            taskUrl = "url" in taskPage ? taskPage.url : null;
            taskCreated = true;
            console.log("[create-handoff-marker] created task", taskId, taskTitle);
        }
        catch (e) {
            const message = extractErrorMessage(e);
            const isPermission = (e instanceof APIResponseError &&
                (e.code === "object_not_found" || e.code === "unauthorized")) ||
                message.includes("403");
            console.error("[create-handoff-marker] task creation failed:", message);
            // Degrade gracefully — handoff block (core output) is still valid
            const degraded = {
                capability: "task_creation",
                status: isPermission ? "denied" : "error",
                message,
            };
            return {
                success: true,
                handoff_block: handoffBlock,
                task_created: false,
                task_url: null,
                task_id: null,
                duplicate_prevented: duplicatePrevented,
                existing_task_url: existingTaskUrl,
                escalation_capped: escalationCapped,
                needs_manual_review: false,
                degraded_capabilities: [degraded],
            };
        }
    }
    return {
        success: true,
        handoff_block: handoffBlock,
        task_created: taskCreated,
        task_url: taskUrl,
        task_id: taskId,
        duplicate_prevented: duplicatePrevented,
        existing_task_url: existingTaskUrl,
        escalation_capped: escalationCapped,
        needs_manual_review: needsManualReview,
    };
}
