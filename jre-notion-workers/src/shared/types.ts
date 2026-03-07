/**
 * Shared types for Notion Workers — write-agent-digest, check-upstream-status, create-handoff-marker.
 */

export type StatusType = "sync" | "snapshot" | "report" | "heartbeat";
export type StatusValue = "complete" | "partial" | "failed" | "full_report" | "stub";
export type TargetDatabase = "docs" | "home_docs";
export type TaskPriority = "🔴 High" | "🟡 Medium" | "🟢 Low";

export interface FlaggedItem {
  description: string;
  task_link?: string;
  no_task_reason?: string;
}

export interface TaskRef {
  name: string;
  notion_url: string;
}

export interface ActionsTaken {
  created_tasks: TaskRef[];
  updated_tasks: TaskRef[];
}

export interface NeedsReview {
  description: string;
}

export interface Escalation {
  escalated_to: string;
  escalation_reason: string;
  escalation_owner: string;
  handoff_complete: boolean;
}

// --- write-agent-digest ---
export interface WriteAgentDigestInput {
  agent_name: string;
  agent_emoji: string;
  status_type: StatusType;
  status_value: StatusValue;
  run_time_chicago: string;
  scope: string;
  input_versions: string;
  flagged_items: FlaggedItem[];
  actions_taken: ActionsTaken;
  summary: string;
  needs_review: NeedsReview[];
  escalations: Escalation[];
  target_database: TargetDatabase;
  doc_type: string;
  client_relation_ids?: string[];
  project_relation_ids?: string[];
}

export type WriteAgentDigestOutput =
  | {
      success: true;
      page_url: string;
      page_id: string;
      title: string;
      is_error_titled: boolean;
      is_heartbeat: boolean;
    }
  | { success: false; error: string };

// --- check-upstream-status ---
export interface CheckUpstreamStatusInput {
  agent_name: string;
  max_age_hours?: number;
  require_current_cycle?: boolean;
}

export type UpstreamStatus =
  | "complete"
  | "partial"
  | "failed"
  | "full_report"
  | "stub"
  | "not_found"
  | "stale"
  | "unknown";

export interface CheckUpstreamStatusOutput {
  found: boolean;
  agent_name: string;
  status: UpstreamStatus;
  status_type: StatusType | null;
  run_time: string | null;
  run_time_age_hours: number | null;
  is_stale: boolean;
  is_heartbeat: boolean;
  is_error_titled: boolean;
  page_url: string | null;
  page_id: string | null;
  degraded: boolean;
  data_completeness_notice: string;
}

// --- create-handoff-marker ---
export interface CreateHandoffMarkerInput {
  source_agent: string;
  target_agent: string;
  escalation_reason: string;
  source_digest_url: string;
  create_task: boolean;
  task_priority?: TaskPriority;
  client_relation_ids?: string[];
  project_relation_ids?: string[];
}

export type CreateHandoffMarkerOutput =
  | {
      success: true;
      handoff_block: string;
      task_created: boolean;
      task_url: string | null;
      task_id: string | null;
      duplicate_prevented: boolean;
      existing_task_url: string | null;
      escalation_capped: boolean;
      needs_manual_review: boolean;
    }
  | { success: false; error: string };

// --- monitor-fleet-status ---
export interface MonitorFleetStatusInput {
  /** Restrict to specific agents. If empty/omitted, scan all non-suspended. */
  agent_names?: string[];
}

export interface AgentFleetEntry {
  agent_name: string;
  found: boolean;
  status: UpstreamStatus;
  status_type: StatusType | null;
  run_time: string | null;
  run_time_age_hours: number | null;
  is_degraded: boolean;
  is_stale: boolean;
  is_error_titled: boolean;
  digest_page_url: string | null;
  notice: string;
}

export type MonitorFleetStatusOutput =
  | {
      success: true;
      agents: AgentFleetEntry[];
      total_scanned: number;
      total_current: number;
      total_missing: number;
      total_degraded: number;
      heartbeat_message: string;
    }
  | { success: false; error: string };

// --- scan-briefing-failures ---
export type FailureType = "Missing Digest" | "Partial Run" | "Failed Run" | "Stale Snapshot";

export interface BriefingFailure {
  agent_name: string;
  failure_type: FailureType;
  signal_line: string;
}

export interface ScanBriefingFailuresInput {
  /** YYYY-MM-DD. Defaults to today in America/Chicago. */
  briefing_date?: string;
}

export type ScanBriefingFailuresOutput =
  | {
      success: true;
      briefing_found: boolean;
      briefing_page_url: string | null;
      failures: BriefingFailure[];
      total_failures: number;
    }
  | { success: false; error: string };

// --- log-dead-letter ---
export type DetectedBy = "Dead Letter Logger" | "Morning Briefing" | "Manual";

export interface LogDeadLetterInput {
  agent_name: string;
  expected_run_date: string;
  failure_type: FailureType;
  detected_by: DetectedBy;
  notes: string;
  linked_task_id?: string;
}

export type LogDeadLetterOutput =
  | {
      success: true;
      record_id: string;
      record_url: string;
    }
  | { success: false; error: string };

// --- calculate-credit-forecast ---
export interface AgentCreditEntry {
  agent_name: string;
  est_runs_per_month: number;
  est_credits_per_run: number;
  is_suspended: boolean;
}

export interface CalculateCreditForecastInput {
  agent_data: AgentCreditEntry[];
  previous_buffered_total?: number;
  pricing_rate?: number;
  buffer_percentage?: number;
}

export type CalculateCreditForecastOutput =
  | {
      success: true;
      active_agents: Array<AgentCreditEntry & { est_credits_per_month: number }>;
      suspended_agents: string[];
      fleet_total_base: number;
      fleet_total_buffered: number;
      dollar_estimate: number;
      buffer_percentage: number;
      pricing_rate: number;
      week_over_week_delta: number | null;
      delta_exceeds_threshold: boolean;
      missing_estimates: string[];
      summary_line: string;
      report_status_line: string;
    }
  | { success: false; error: string };
