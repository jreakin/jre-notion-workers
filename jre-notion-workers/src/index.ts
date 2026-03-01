/**
 * Notion Workers entry — registers all tools with Worker.
 */
import { Worker } from "@notionhq/workers";
import { executeWriteAgentDigest } from "./workers/write-agent-digest.js";
import { executeCheckUpstreamStatus } from "./workers/check-upstream-status.js";
import { executeCreateHandoffMarker } from "./workers/create-handoff-marker.js";
import type { WriteAgentDigestInput, CheckUpstreamStatusInput, CreateHandoffMarkerInput } from "./shared/types.js";

const worker = new Worker();

const writeDigestSchema = {
  type: "object" as const,
  properties: {
    agent_name: { type: "string" as const },
    agent_emoji: { type: "string" as const },
    status_type: { type: "string" as const, enum: ["sync", "snapshot", "report", "heartbeat"] },
    status_value: { type: "string" as const, enum: ["complete", "partial", "failed", "full_report", "stub"] },
    run_time_chicago: { type: "string" as const },
    scope: { type: "string" as const },
    input_versions: { type: "string" as const },
    flagged_items: { type: "array" as const, items: { type: "object" as const, properties: { description: { type: "string" as const }, task_link: { type: "string" as const }, no_task_reason: { type: "string" as const } }, required: ["description", "task_link", "no_task_reason"] as const, additionalProperties: false as const } },
    actions_taken: { type: "object" as const, properties: { created_tasks: { type: "array" as const, items: { type: "object" as const, properties: { name: { type: "string" as const }, notion_url: { type: "string" as const } }, required: ["name", "notion_url"] as const, additionalProperties: false as const } }, updated_tasks: { type: "array" as const, items: { type: "object" as const, properties: { name: { type: "string" as const }, notion_url: { type: "string" as const } }, required: ["name", "notion_url"] as const, additionalProperties: false as const } } }, required: ["created_tasks", "updated_tasks"] as const, additionalProperties: false as const },
    summary: { type: "string" as const },
    needs_review: { type: "array" as const, items: { type: "object" as const, properties: { description: { type: "string" as const } }, required: ["description"] as const, additionalProperties: false as const } },
    escalations: { type: "array" as const, items: { type: "object" as const, properties: { escalated_to: { type: "string" as const }, escalation_reason: { type: "string" as const }, escalation_owner: { type: "string" as const }, handoff_complete: { type: "boolean" as const } }, required: ["escalated_to", "escalation_reason", "escalation_owner", "handoff_complete"] as const, additionalProperties: false as const } },
    target_database: { type: "string" as const, enum: ["docs", "home_docs"] },
    doc_type: { type: "string" as const },
    client_relation_ids: { type: "array" as const, items: { type: "string" as const } },
    project_relation_ids: { type: "array" as const, items: { type: "string" as const } },
  },
  required: [
    "agent_name", "agent_emoji", "status_type", "status_value", "run_time_chicago", "scope", "input_versions",
    "flagged_items", "actions_taken", "summary", "needs_review", "escalations", "target_database", "doc_type",
    "client_relation_ids", "project_relation_ids",
  ] as const,
  additionalProperties: false as const,
};

worker.tool("write-agent-digest", {
  title: "Write Agent Digest",
  description:
    "Creates a governance-compliant agent digest or report page in the Docs database. Handles all formatting, status line formatting, section ordering, and ERROR-title naming automatically.",
  schema: writeDigestSchema as never,
  execute: (input, context) => executeWriteAgentDigest(input as unknown as WriteAgentDigestInput, context.notion),
});

worker.tool("check-upstream-status", {
  title: "Check Upstream Status",
  description:
    "Finds the most recent digest page for a given agent, reads its machine-readable status line and run timestamp, and returns a structured status object.",
  schema: {
    type: "object" as const,
    properties: {
      agent_name: { type: "string" as const },
      max_age_hours: { type: "number" as const },
      require_current_cycle: { type: "boolean" as const },
    },
    required: ["agent_name", "max_age_hours", "require_current_cycle"] as const,
    additionalProperties: false as const,
  } as never,
  execute: (input, context) => executeCheckUpstreamStatus(input as unknown as CheckUpstreamStatusInput, context.notion) as never,
});

worker.tool("create-handoff-marker", {
  title: "Create Handoff Marker",
  description:
    "Creates a structured handoff record when an agent needs to escalate to another agent. Returns a pre-formatted Escalations block and optionally creates a tracking Task in Notion.",
  schema: {
    type: "object" as const,
    properties: {
      source_agent: { type: "string" as const },
      target_agent: { type: "string" as const },
      escalation_reason: { type: "string" as const },
      source_digest_url: { type: "string" as const },
      create_task: { type: "boolean" as const },
      task_priority: { type: "string" as const, enum: ["🔴 High", "🟡 Medium", "🟢 Low"] },
      client_relation_ids: { type: "array" as const, items: { type: "string" as const } },
      project_relation_ids: { type: "array" as const, items: { type: "string" as const } },
    },
    required: ["source_agent", "target_agent", "escalation_reason", "source_digest_url", "create_task", "task_priority", "client_relation_ids", "project_relation_ids"] as const,
    additionalProperties: false as const,
  } as never,
  execute: (input, context) => executeCreateHandoffMarker(input as unknown as CreateHandoffMarkerInput, context.notion) as never,
});

export default worker;
