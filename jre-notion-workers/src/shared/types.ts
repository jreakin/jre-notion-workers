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
