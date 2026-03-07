/**
 * Notion Workers entry — registers all tools with Worker.
 */
import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";
import { executeWriteAgentDigest } from "./workers/write-agent-digest.js";
import { executeCheckUpstreamStatus } from "./workers/check-upstream-status.js";
import { executeCreateHandoffMarker } from "./workers/create-handoff-marker.js";
import { executeMonitorFleetStatus } from "./workers/monitor-fleet-status.js";
import { executeScanBriefingFailures } from "./workers/scan-briefing-failures.js";
import { executeLogDeadLetter } from "./workers/log-dead-letter.js";
import { executeCalculateCreditForecast } from "./workers/calculate-credit-forecast.js";
import type {
  WriteAgentDigestInput,
  CheckUpstreamStatusInput,
  CreateHandoffMarkerInput,
  MonitorFleetStatusInput,
  ScanBriefingFailuresInput,
  LogDeadLetterInput,
  CalculateCreditForecastInput,
} from "./shared/types.js";

const worker = new Worker();
export default worker;

// ── write-agent-digest ───────────────────────────────────────────────

const taskRefSchema = j.object({
  name: j.string(),
  notion_url: j.string(),
});

worker.tool("write-agent-digest", {
  title: "Write Agent Digest",
  description:
    "Creates a governance-compliant agent digest or report page in the Docs database. Handles all formatting, status line formatting, section ordering, and ERROR-title naming automatically.",
  schema: j.object({
    agent_name: j.string(),
    agent_emoji: j.string(),
    status_type: j.enum("sync", "snapshot", "report", "heartbeat"),
    status_value: j.enum("complete", "partial", "failed", "full_report", "stub"),
    run_time_chicago: j.string(),
    scope: j.string(),
    input_versions: j.string(),
    flagged_items: j.array(
      j.object({
        description: j.string(),
        task_link: j.string(),
        no_task_reason: j.string(),
      })
    ),
    actions_taken: j.object({
      created_tasks: j.array(taskRefSchema),
      updated_tasks: j.array(taskRefSchema),
    }),
    summary: j.string(),
    needs_review: j.array(j.object({ description: j.string() })),
    escalations: j.array(
      j.object({
        escalated_to: j.string(),
        escalation_reason: j.string(),
        escalation_owner: j.string(),
        handoff_complete: j.boolean(),
      })
    ),
    target_database: j.enum("docs", "home_docs"),
    doc_type: j.string(),
    client_relation_ids: j.array(j.string()),
    project_relation_ids: j.array(j.string()),
  }),
  execute: (input, context) =>
    executeWriteAgentDigest(input as unknown as WriteAgentDigestInput, context.notion),
});

// ── check-upstream-status ────────────────────────────────────────────

worker.tool("check-upstream-status", {
  title: "Check Upstream Status",
  description:
    "Finds the most recent digest page for a given agent, reads its machine-readable status line and run timestamp, and returns a structured status object.",
  schema: j.object({
    agent_name: j.string(),
    max_age_hours: j.number(),
    require_current_cycle: j.boolean(),
  }),
  execute: (input, context) =>
    executeCheckUpstreamStatus(input as unknown as CheckUpstreamStatusInput, context.notion) as never,
});

// ── create-handoff-marker ────────────────────────────────────────────

worker.tool("create-handoff-marker", {
  title: "Create Handoff Marker",
  description:
    "Creates a structured handoff record when an agent needs to escalate to another agent. Returns a pre-formatted Escalations block and optionally creates a tracking Task in Notion.",
  schema: j.object({
    source_agent: j.string(),
    target_agent: j.string(),
    escalation_reason: j.string(),
    source_digest_url: j.string(),
    create_task: j.boolean(),
    task_priority: j.enum("🔴 High", "🟡 Medium", "🟢 Low"),
    client_relation_ids: j.array(j.string()),
    project_relation_ids: j.array(j.string()),
  }),
  execute: (input, context) =>
    executeCreateHandoffMarker(input as unknown as CreateHandoffMarkerInput, context.notion) as never,
});

// ── monitor-fleet-status ─────────────────────────────────────────────

worker.tool("monitor-fleet-status", {
  title: "Monitor Fleet Status",
  description:
    "Batch-queries all monitored agents' latest digests and returns fleet-wide status data. Returns per-agent status, run times, degraded flags, and a heartbeat summary message.",
  schema: j.object({
    agent_names: j.array(j.string()).nullable(),
  }),
  execute: (input, context) =>
    executeMonitorFleetStatus(input as unknown as MonitorFleetStatusInput, context.notion) as never,
});

// ── scan-briefing-failures ───────────────────────────────────────────

worker.tool("scan-briefing-failures", {
  title: "Scan Briefing Failures",
  description:
    "Reads today's Morning Briefing digest and extracts structured failure signals (missing digests, partial runs, failed runs, stale snapshots). Used by Dead Letter Logger.",
  schema: j.object({
    briefing_date: j.string().nullable(),
  }),
  execute: (input, context) =>
    executeScanBriefingFailures(input as unknown as ScanBriefingFailuresInput, context.notion) as never,
});

// ── log-dead-letter ──────────────────────────────────────────────────

worker.tool("log-dead-letter", {
  title: "Log Dead Letter",
  description:
    "Creates a structured record in the Dead Letters database for a single agent failure. Sets Resolution Status to Open. Never modifies or deletes existing records.",
  schema: j.object({
    agent_name: j.string(),
    expected_run_date: j.string(),
    failure_type: j.enum("Missing Digest", "Partial Run", "Failed Run", "Stale Snapshot"),
    detected_by: j.enum("Dead Letter Logger", "Morning Briefing", "Manual"),
    notes: j.string(),
    linked_task_id: j.string().nullable(),
  }),
  execute: (input, context) =>
    executeLogDeadLetter(input as unknown as LogDeadLetterInput, context.notion) as never,
});

// ── calculate-credit-forecast ────────────────────────────────────────

worker.tool("calculate-credit-forecast", {
  title: "Calculate Credit Forecast",
  description:
    "Pure calculation tool: takes agent credit data, computes monthly burn projection with buffer, week-over-week delta, and dollar estimate. Returns structured forecast for digest writing.",
  schema: j.object({
    agent_data: j.array(
      j.object({
        agent_name: j.string(),
        est_runs_per_month: j.number(),
        est_credits_per_run: j.number(),
        is_suspended: j.boolean(),
      })
    ),
    previous_buffered_total: j.number().nullable(),
    pricing_rate: j.number().nullable(),
    buffer_percentage: j.number().nullable(),
  }),
  execute: (input) =>
    executeCalculateCreditForecast(input as unknown as CalculateCreditForecastInput) as never,
});
