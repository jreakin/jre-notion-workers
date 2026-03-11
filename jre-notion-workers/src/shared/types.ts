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
  /** Override the default digest type from agent config (e.g. "Docs Cleanup Report" for Docs Librarian). */
  digest_type_override?: string;
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

// --- lint-agents-file ---
export interface LintAgentsFileInput {
  repo: string;
  path?: string;
  ref?: string;
}

export interface LintFinding {
  rule: string;
  status: "PASS" | "FAIL";
  message: string;
}

export interface LintAgentsFileOutput {
  file: string;
  ref: string;
  passed: boolean;
  score: string;
  findings: LintFinding[];
  raw_url: string;
}

// --- read-repo-file ---
export interface ReadRepoFileInput {
  repo: string;
  path: string;
  ref?: string;
  max_chars?: number;
}

export type ReadRepoFileOutput =
  | {
      found: true;
      content: string;
      repo: string;
      path: string;
      ref: string;
      char_count: number;
      truncated: boolean;
      raw_url: string;
    }
  | {
      found: false;
      content: null;
      message: string;
    };

// --- check-url-status ---
export interface UrlCheckEntry {
  url: string;
  label: string;
  expected_text?: string;
  max_age_hours?: number;
}

export interface CheckUrlStatusInput {
  urls: UrlCheckEntry[];
  timeout_ms?: number;
}

export interface UrlCheckResult {
  label: string;
  url: string;
  reachable: boolean;
  status_code: number | null;
  last_modified: string | null;
  age_hours: number | null;
  stale: boolean;
  content_match: boolean | null;
  error: string | null;
}

export type OverallUrlStatus = "ok" | "degraded" | "failed";

export interface CheckUrlStatusOutput {
  checked_at: string;
  overall_status: OverallUrlStatus;
  results: UrlCheckResult[];
  summary: string;
}

// --- sync-github-items ---
export interface GitHubSource {
  name: string;
  type: "org" | "user";
}

export interface SyncGitHubItemsInput {
  /** @deprecated Use `sources` instead. Kept for backward compat — treated as a single org source. */
  org_name?: string;
  /** One or more GitHub accounts to scan. Each has a name and type ("org" or "user"). */
  sources?: GitHubSource[];
  include_forks?: boolean;
  include_archived?: boolean;
  /** Whether to sync issues for each repo (default: true). */
  include_issues?: boolean;
  /** Whether to sync pull requests for each repo (default: true). */
  include_prs?: boolean;
  dry_run?: boolean;
  /**
   * Only fetch GitHub items updated within this many days.
   * Dramatically reduces API calls for incremental syncs.
   * Omit for a full initial sync.
   */
  updated_since_days?: number;
  /**
   * Maximum number of Notion creates + updates per invocation.
   * Prevents timeouts during large migrations by spreading writes
   * across multiple runs. Omit or 0 for unlimited.
   */
  max_writes_per_run?: number;
}

export type SyncGitHubItemsOutput =
  | {
      success: true;
      repos_found: number;
      issues_found: number;
      prs_found: number;
      created: number;
      updated: number;
      skipped: number;
      errors: number;
      /** Number of repos with no Client relation — agents should follow up. */
      unlinked_repos: number;
      error_details: string[];
      summary: string;
    }
  | { success: false; error: string };

// --- check-agent-staleness ---
export interface CheckAgentStalenessInput {
  agent_names?: string[];
  thresholds?: {
    daily?: number;
    weekly?: number;
    biweekly?: number;
    monthly?: number;
  };
  dry_run?: boolean;
}

export interface StalenessEntry {
  agent_name: string;
  cadence: "daily" | "weekly" | "biweekly" | "monthly";
  last_run_time: string | null;
  age_hours: number | null;
  threshold_hours: number;
  is_stale: boolean;
  dead_letter_created: boolean;
  dead_letter_url: string | null;
  notice: string;
}

export type CheckAgentStalenessOutput =
  | {
      success: true;
      entries: StalenessEntry[];
      total_checked: number;
      total_stale: number;
      total_dead_letters_created: number;
      summary: string;
    }
  | { success: false; error: string };

// --- validate-digest-quality ---
export interface ValidateDigestQualityInput {
  page_id: string;
  agent_name?: string;
  post_comment?: boolean;
}

export interface QualityFinding {
  rule: string;
  status: "PASS" | "FAIL" | "WARN";
  message: string;
}

export type ValidateDigestQualityOutput =
  | {
      success: true;
      page_id: string;
      page_url: string | null;
      title: string;
      passed: boolean;
      score: string;
      findings: QualityFinding[];
      comment_posted: boolean;
    }
  | { success: false; error: string };

// --- archive-old-digests ---
export interface ArchiveOldDigestsInput {
  retention_days?: number;
  target_database?: "docs" | "home_docs" | "both";
  dry_run?: boolean;
  max_pages?: number;
  exclude_doc_types?: string[];
}

export interface ArchivedDigest {
  page_id: string;
  title: string;
  created_time: string;
  age_days: number;
  status_before: string | null;
  archived: boolean;
}

export type ArchiveOldDigestsOutput =
  | {
      success: true;
      database_scanned: string;
      total_candidates: number;
      total_archived: number;
      total_skipped: number;
      total_errors: number;
      digests: ArchivedDigest[];
      summary: string;
    }
  | { success: false; error: string };

// --- auto-link-meeting-client ---
export interface AutoLinkMeetingClientInput {
  meeting_page_id?: string;
  scan_unlinked?: boolean;
  max_pages?: number;
  dry_run?: boolean;
}

export type MatchType = "exact_name" | "contact_name" | "email_domain" | "tag_keyword" | "title_match" | "none";
export type MatchConfidence = "high" | "medium" | "low";

export interface MeetingLinkResult {
  page_id: string;
  title: string;
  client_matched: string | null;
  project_matched: string | null;
  match_type: MatchType;
  confidence: MatchConfidence;
  linked: boolean;
}

export type AutoLinkMeetingClientOutput =
  | {
      success: true;
      processed: number;
      linked_count: number;
      unmatched_count: number;
      results: MeetingLinkResult[];
      summary: string;
    }
  | { success: false; error: string };

// --- tag-untagged-docs ---
export interface TagUntaggedDocsInput {
  target_database?: "docs" | "home_docs" | "both";
  max_pages?: number;
  dry_run?: boolean;
}

export interface TaggedDocResult {
  page_id: string;
  title: string;
  inferred_type: string | null;
  inference_rule: string;
  tagged: boolean;
}

export type TagUntaggedDocsOutput =
  | {
      success: true;
      database_scanned: string;
      total_untagged: number;
      total_tagged: number;
      total_needs_review: number;
      results: TaggedDocResult[];
      summary: string;
    }
  | { success: false; error: string };

// --- validate-project-completeness ---
export interface ValidateProjectCompletenessInput {
  status_filter?: string[];
  client_filter?: string;
  dry_run?: boolean;
}

export interface ProjectIssue {
  severity: "FAIL" | "WARN";
  rule: string;
  message: string;
}

export interface ProjectCompleteness {
  page_id: string;
  project_name: string;
  client_name: string | null;
  status: string;
  issues: ProjectIssue[];
  issue_count: number;
}

export type ValidateProjectCompletenessOutput =
  | {
      success: true;
      total_projects: number;
      total_with_issues: number;
      total_fail: number;
      total_warn: number;
      projects: ProjectCompleteness[];
      summary: string;
    }
  | { success: false; error: string };

// --- resolve-stale-dead-letters ---
export interface ResolveStaleDeadLettersInput {
  agent_name: string;
  successful_run_date: string;
  resolvable_failure_types?: string[];
  dry_run?: boolean;
}

export interface ResolvedDeadLetter {
  record_id: string;
  record_url: string;
  title: string;
  failure_type: string;
  expected_run_date: string;
  resolved: boolean;
}

export type ResolveStaleDeadLettersOutput =
  | {
      success: true;
      agent_name: string;
      successful_run_date: string;
      total_open_found: number;
      total_resolved: number;
      total_skipped: number;
      total_errors: number;
      records: ResolvedDeadLetter[];
      summary: string;
    }
  | { success: false; error: string };

// --- estimate-github-hours ---
export interface EstimateGitHubHoursInput {
  owner: string;
  repo: string;
  number: number;
  type: "pr" | "issue";
}

export interface HoursBreakdown {
  baseEstimate: number;
  labelMultiplier: number;
  complexityFactor: number;
}

export type EstimateGitHubHoursOutput =
  | {
      success: true;
      estimatedHours: number;
      confidence: "low" | "medium" | "high";
      breakdown: HoursBreakdown;
      reasoning: string;
    }
  | { success: false; error: string };

// --- validate-database-references ---
export interface DatabaseReference {
  database_id: string;
  label: string;
  used_by?: string[];
}

export interface ValidateDatabaseReferencesInput {
  references: DatabaseReference[];
  check_schema?: boolean;
  log_dead_letters?: boolean;
}

export interface DatabaseCheckResult {
  database_id: string;
  label: string;
  used_by: string[];
  accessible: boolean;
  status_code: number;
  property_count: number | null;
  error: string | null;
}

export type ValidateDatabaseReferencesOutput =
  | {
      success: true;
      checked_at: string;
      total_checked: number;
      total_accessible: number;
      total_broken: number;
      results: DatabaseCheckResult[];
      broken_references: DatabaseCheckResult[];
      dead_letters_logged: number;
      summary: string;
    }
  | { success: false; error: string };

// --- sync-time-log ---
export interface SyncTimeLogInput {
  /** Days to look back for GitHub Items (default: 7). */
  lookback_days?: number;
  /** Only process items from specific repos (e.g. "Abstract-Data/my-app"). */
  repo_filter?: string[];
  /** Item types to process (default: both). */
  item_types?: ("Issue" | "PR")[];
  dry_run?: boolean;
}

export interface TimeLogEntryResult {
  github_item_id: string;
  github_url: string;
  title: string;
  type: "Issue" | "PR";
  action: "created" | "updated" | "skipped";
  hours: number | null;
  confidence: "low" | "medium" | "high" | null;
  description_prefix: string;
  reason?: string;
}

export type SyncTimeLogOutput =
  | {
      success: true;
      items_scanned: number;
      created: number;
      updated: number;
      skipped: number;
      errors: number;
      total_estimated_hours: number;
      error_details: string[];
      entries: TimeLogEntryResult[];
      summary: string;
    }
  | { success: false; error: string };
