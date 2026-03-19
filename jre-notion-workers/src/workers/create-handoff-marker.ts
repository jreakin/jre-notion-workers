/**
 * create-handoff-marker: Creates handoff record and optionally a Notion Task. Circuit breaker + escalation cap.
 */
import type { Client } from "@notionhq/client";
import { getTasksDatabaseId } from "../shared/notion-client.js";
import { VALID_AGENT_NAMES } from "../shared/agent-config.js";
import { nextBusinessDay } from "../shared/date-utils.js";
import type { CreateHandoffMarkerInput, CreateHandoffMarkerOutput, DegradedCapability, TaskPriority } from "../shared/types.js";

const HANDOFF_WINDOW_DAYS = 7;
const ESCALATION_CAP = 2;

function buildHandoffBlock(params: {
  target_agent: string;
  escalation_reason: string;
  source_digest_url: string;
}): string {
  return [
    `Escalated To: ${params.target_agent}`,
    `Escalation Reason: ${params.escalation_reason}`,
    `Escalation Owner: ${params.target_agent}`,
    "Handoff Complete: No",
    `Source: ${params.source_digest_url}`,
  ].join("\n");
}

export async function executeCreateHandoffMarker(
  input: CreateHandoffMarkerInput,
  notion: Client
): Promise<CreateHandoffMarkerOutput> {
  if (!input.source_agent || !VALID_AGENT_NAMES.includes(input.source_agent)) {
    return {
      success: false,
      error: `Invalid source_agent: ${input.source_agent}`,
    };
  }
  if (!input.target_agent || !VALID_AGENT_NAMES.includes(input.target_agent)) {
    return {
      success: false,
      error: `Invalid target_agent: ${input.target_agent}`,
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
  let taskUrl: string | null = null;
  let taskId: string | null = null;
  let duplicatePrevented = false;
  let existingTaskUrl: string | null = null;
  let escalationCapped = false;
  let needsManualReview = false;

  if (input.create_task) {
    try {
      const tasksDbId = getTasksDatabaseId();
      const since = new Date();
      since.setDate(since.getDate() - HANDOFF_WINDOW_DAYS);
      const sinceMs = since.getTime();

      const existingResponse = await notion.databases.query({
        database_id: tasksDbId,
        filter: {
          property: "Task Name",
          title: {
            contains: `Handoff: ${input.source_agent} → ${input.target_agent}`,
          },
        },
        sorts: [{ timestamp: "created_time", direction: "descending" }],
        page_size: 20,
      });

      type PageWithCreated = { id: string; url?: string; created_time?: string; properties?: Record<string, unknown> };
      const withinWindow = ((existingResponse.results ?? []) as PageWithCreated[]).filter((p) => {
        const ct = p.created_time;
        if (!ct) return false;
        return new Date(ct).getTime() >= sinceMs;
      });

      // Circuit breaker: prevent duplicate if ANY matching handoff task exists
      // in the window — open OR recently closed (e.g. auto-closed by PR merge).
      // Previously only checked open tasks, which caused duplicates when the
      // GitHub PR "Merged → Done" rule auto-closed a handoff task.
      if (withinWindow.length > 0) {
        const first = withinWindow[0] as { id?: string; url?: string };
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

      const taskProps: Record<string, unknown> = {
        "Task Name": { title: [{ text: { content: taskTitle } }] },
        "Priority": { select: { name: input.task_priority as TaskPriority } },
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
        properties: taskProps as never,
        children: [
          {
            type: "paragraph",
            paragraph: {
              rich_text: [{ type: "text", text: { content: taskNotes } }],
            },
          },
        ] as never[],
      });
      taskId = "id" in taskPage ? (taskPage as { id: string }).id : null;
      taskUrl = "url" in taskPage ? (taskPage as { url: string }).url : null;
      taskCreated = true;
      console.log("[create-handoff-marker] created task", taskId, taskTitle);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const isPermission = message.includes("403") || message.includes("Unauthorized") || message.includes("Could not find");
      console.error("[create-handoff-marker] task creation failed:", message);

      // Degrade gracefully — handoff block (core output) is still valid
      const degraded: DegradedCapability = {
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
