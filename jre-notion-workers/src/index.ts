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
import { executeLintAgentsFile } from "./workers/lint-agents-file.js";
import { executeReadRepoFile } from "./workers/read-repo-file.js";
import { executeCheckUrlStatus } from "./workers/check-url-status.js";
import { executeSyncGitHubItems } from "./workers/sync-github-items.js";
import { executeCheckAgentStaleness } from "./workers/check-agent-staleness.js";
import { executeValidateDigestQuality } from "./workers/validate-digest-quality.js";
import { executeArchiveOldDigests } from "./workers/archive-old-digests.js";
import { executeAutoLinkMeetingClient } from "./workers/auto-link-meeting-client.js";
import { executeTagUntaggedDocs } from "./workers/tag-untagged-docs.js";
import { executeValidateProjectCompleteness } from "./workers/validate-project-completeness.js";
import { executeResolveStaleDeadLetters } from "./workers/resolve-stale-dead-letters.js";
import { executeValidateDatabaseReferences } from "./workers/validate-database-references.js";
import { executeEstimateGitHubHours } from "./workers/estimate-github-hours.js";
import { executeSyncTimeLog } from "./workers/sync-time-log.js";
import { executeWriteAgentOpsRun } from "./workers/write-agent-ops-run.js";
import { executeNormalizeAgentOpsOptions } from "./workers/normalize-agent-ops-options.js";
import { executeValidateClientShareScope } from "./workers/validate-client-share-scope.js";
import { executeRedactClientDocument } from "./workers/redact-client-document.js";
import { executePrepareClientDocUpdate } from "./workers/prepare-client-doc-update.js";
import { executeDetectClientDocDrift } from "./workers/detect-client-doc-drift.js";
import { executePublishClientDocUpdate } from "./workers/publish-client-doc-update.js";
import { executeCreateClientReviewTask } from "./workers/create-client-review-task.js";
import { executeSyncClientPortalIndex } from "./workers/sync-client-portal-index.js";
import { executeAuditClientPortalAccess } from "./workers/audit-client-portal-access.js";
import { executeRevokeClientAccess } from "./workers/revoke-client-access.js";
import { executeLogClientShareEvent } from "./workers/log-client-share-event.js";
import { getNotionClient } from "./shared/notion-client.js";
import type {
  WriteAgentDigestInput,
  CheckUpstreamStatusInput,
  CreateHandoffMarkerInput,
  MonitorFleetStatusInput,
  ScanBriefingFailuresInput,
  LogDeadLetterInput,
  CalculateCreditForecastInput,
  LintAgentsFileInput,
  ReadRepoFileInput,
  CheckUrlStatusInput,
  SyncGitHubItemsInput,
  CheckAgentStalenessInput,
  ValidateDigestQualityInput,
  ArchiveOldDigestsInput,
  AutoLinkMeetingClientInput,
  TagUntaggedDocsInput,
  ValidateProjectCompletenessInput,
  ResolveStaleDeadLettersInput,
  ValidateDatabaseReferencesInput,
  EstimateGitHubHoursInput,
  SyncTimeLogInput,
  WriteAgentOpsRunInput,
  NormalizeAgentOpsOptionsInput,
  ClientShareScopeInput,
  RedactClientDocumentInput,
  PrepareClientDocUpdateInput,
  DetectClientDocDriftInput,
  PublishClientDocUpdateInput,
  CreateClientReviewTaskInput,
  SyncClientPortalIndexInput,
  AuditClientPortalAccessInput,
  RevokeClientAccessInput,
  LogClientShareEventInput,
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
      auto_closed_by_pr: j.array(taskRefSchema),
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
    digest_type_override: j.string().nullable(),
  }),
  execute: (input, context) =>
    executeWriteAgentDigest(input as unknown as WriteAgentDigestInput, getNotionClient()),
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
    executeCheckUpstreamStatus(input as unknown as CheckUpstreamStatusInput, getNotionClient()) as never,
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
    executeCreateHandoffMarker(input as unknown as CreateHandoffMarkerInput, getNotionClient()) as never,
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
    executeMonitorFleetStatus(input as unknown as MonitorFleetStatusInput, getNotionClient()) as never,
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
    executeScanBriefingFailures(input as unknown as ScanBriefingFailuresInput, getNotionClient()) as never,
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
    detected_by: j.enum("Dead Letter Logger", "Morning Briefing", "Manual", "Fleet Ops Agent", "check-agent-staleness"),
    notes: j.string(),
    linked_task_id: j.string().nullable(),
  }),
  execute: (input, context) =>
    executeLogDeadLetter(input as unknown as LogDeadLetterInput, getNotionClient()) as never,
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

// ── lint-agents-file ───────────────────────────────────────────────

worker.tool("lint-agents-file", {
  title: "Lint AGENTS File",
  description:
    "Fetches an AGENTS.md file (or overlay) from a GitHub repository and validates it against the AGENTS.md CI Linter Spec. Returns pass/fail with per-rule findings.",
  schema: j.object({
    repo: j.string(),
    path: j.string(),
    ref: j.string(),
  }),
  execute: (input) =>
    executeLintAgentsFile(input as unknown as LintAgentsFileInput) as never,
});

// ── read-repo-file ─────────────────────────────────────────────────

worker.tool("read-repo-file", {
  title: "Read Repo File",
  description:
    "Fetches the raw text content of a file from a GitHub repository. Use this to read AGENTS.md overlays, config files, or any other text file in a private or public repo.",
  schema: j.object({
    repo: j.string(),
    path: j.string(),
    ref: j.string(),
    max_chars: j.number(),
  }),
  execute: (input) =>
    executeReadRepoFile(input as unknown as ReadRepoFileInput) as never,
});

// ── check-url-status ───────────────────────────────────────────────

worker.tool("check-url-status", {
  title: "Check URL Status",
  description:
    "Checks whether one or more upstream URLs are reachable and optionally validates that expected content is present. Returns a structured status for each URL so agents can gate their run on data freshness.",
  schema: j.object({
    urls: j.array(
      j.object({
        url: j.string(),
        label: j.string(),
        expected_text: j.string(),
        max_age_hours: j.number(),
      })
    ),
    timeout_ms: j.number(),
  }),
  execute: (input) =>
    executeCheckUrlStatus(input as unknown as CheckUrlStatusInput) as never,
});

// ── sync-github-items ─────────────────────────────────────────────

worker.tool("sync-github-items", {
  title: "Sync GitHub Items",
  description:
    "Syncs GitHub repos, issues, and PRs from configured sources (orgs/users) into the Notion GitHub Items database. Creates new rows for items not yet tracked, updates existing rows when GitHub data is newer. Uses GitHub URL as the unique idempotent key.",
  schema: j.object({
    sources: j
      .array(
        j.object({
          name: j.string(),
          type: j.enum("org", "user"),
        })
      )
      .nullable(),
    org_name: j.string().nullable(),
    include_forks: j.boolean().nullable(),
    include_archived: j.boolean().nullable(),
    include_issues: j.boolean().nullable(),
    include_prs: j.boolean().nullable(),
    dry_run: j.boolean().nullable(),
    updated_since_days: j.number().nullable(),
    max_writes_per_run: j.number().nullable(),
    open_only: j.boolean().nullable(),
    max_repos_per_run: j.number().nullable(),
    max_items_per_run: j.number().nullable(),
    max_seconds: j.number().nullable(),
    resume_cursor: j.object({
      repo_index: j.number(),
      phase: j.enum("issues", "prs"),
    }).nullable(),
  }),
  execute: (input, context) =>
    executeSyncGitHubItems(input as unknown as SyncGitHubItemsInput, getNotionClient()) as never,
});

// ── check-agent-staleness ──────────────────────────────────────────

worker.tool("check-agent-staleness", {
  title: "Check Agent Staleness",
  description:
    "Checks each agent's last digest timestamp against cadence-based staleness thresholds. Creates Dead Letter records for overdue agents.",
  schema: j.object({
    agent_names: j.array(j.string()).nullable(),
    thresholds: j.object({
      daily: j.number().nullable(),
      weekly: j.number().nullable(),
      biweekly: j.number().nullable(),
      monthly: j.number().nullable(),
    }).nullable(),
    dry_run: j.boolean().nullable(),
  }),
  execute: (input, context) =>
    executeCheckAgentStaleness(input as unknown as CheckAgentStalenessInput, getNotionClient()) as never,
});

// ── validate-digest-quality ────────────────────────────────────────

worker.tool("validate-digest-quality", {
  title: "Validate Digest Quality",
  description:
    "Inspects a digest page for governance compliance: status lines, run times, section structure, and task linking. Returns pass/fail findings.",
  schema: j.object({
    page_id: j.string(),
    agent_name: j.string().nullable(),
    post_comment: j.boolean().nullable(),
  }),
  execute: (input, context) =>
    executeValidateDigestQuality(input as unknown as ValidateDigestQualityInput, getNotionClient()) as never,
});

// ── archive-old-digests ────────────────────────────────────────────

worker.tool("archive-old-digests", {
  title: "Archive Old Digests",
  description:
    "Enforces digest retention policy by setting Status to Archived on digest pages older than the retention period. Does NOT delete pages.",
  schema: j.object({
    retention_days: j.number().nullable(),
    target_database: j.enum("docs", "home_docs", "both").nullable(),
    dry_run: j.boolean().nullable(),
    max_pages: j.number().nullable(),
    exclude_patterns: j.array(j.string()).nullable(),
  }),
  execute: (input, context) =>
    executeArchiveOldDigests(input as unknown as ArchiveOldDigestsInput, getNotionClient()) as never,
});

// ── auto-link-meeting-client ───────────────────────────────────────

worker.tool("auto-link-meeting-client", {
  title: "Auto-Link Meeting to Client",
  description:
    "Fuzzy-matches AI Meeting Notes pages against the Clients and Contacts databases to set Client and Project relations. Processes a specific page or scans all unlinked meetings.",
  schema: j.object({
    meeting_page_id: j.string().nullable(),
    scan_unlinked: j.boolean().nullable(),
    max_pages: j.number().nullable(),
    dry_run: j.boolean().nullable(),
  }),
  execute: (input, context) =>
    executeAutoLinkMeetingClient(input as unknown as AutoLinkMeetingClientInput, getNotionClient()) as never,
});

// ── tag-untagged-docs ──────────────────────────────────────────────

worker.tool("tag-untagged-docs", {
  title: "Tag Untagged Docs",
  description:
    "Finds documents with empty Document Type and infers the correct type from title patterns. Tags them or flags for manual review.",
  schema: j.object({
    target_database: j.enum("docs", "home_docs", "both").nullable(),
    max_pages: j.number().nullable(),
    dry_run: j.boolean().nullable(),
  }),
  execute: (input, context) =>
    executeTagUntaggedDocs(input as unknown as TagUntaggedDocsInput, getNotionClient()) as never,
});

// ── validate-project-completeness ──────────────────────────────────

worker.tool("validate-project-completeness", {
  title: "Validate Project Completeness",
  description:
    "Scans active Projects for data completeness issues: missing descriptions, unlinked clients, no tasks, past-due dates. Read-only — never modifies data.",
  schema: j.object({
    status_filter: j.array(j.string()).nullable(),
    client_filter: j.string().nullable(),
    dry_run: j.boolean().nullable(),
  }),
  execute: (input, context) =>
    executeValidateProjectCompleteness(input as unknown as ValidateProjectCompletenessInput, getNotionClient()) as never,
});

// ── resolve-stale-dead-letters ─────────────────────────────────────

worker.tool("resolve-stale-dead-letters", {
  title: "Resolve Stale Dead Letters",
  description:
    "Auto-resolves Open dead letters for an agent when a successful run supersedes prior transient failures (Stale Snapshot, Missing Digest). Call after confirming a successful agent run.",
  schema: j.object({
    agent_name: j.string(),
    successful_run_date: j.string(),
    resolvable_failure_types: j.array(j.string()).nullable(),
    dry_run: j.boolean().nullable(),
  }),
  execute: (input, context) =>
    executeResolveStaleDeadLetters(input as unknown as ResolveStaleDeadLettersInput, getNotionClient()) as never,
});

// ── validate-database-references ───────────────────────────────────

worker.tool("validate-database-references", {
  title: "Validate Database References",
  description:
    "Checks that a list of Notion database IDs are accessible. Catches broken references before they cascade into agent failures. Optionally logs Dead Letters for broken refs.",
  schema: j.object({
    references: j.array(
      j.object({
        database_id: j.string(),
        label: j.string(),
        used_by: j.array(j.string()).nullable(),
      })
    ),
    check_schema: j.boolean().nullable(),
    log_dead_letters: j.boolean().nullable(),
  }),
  execute: (input, context) =>
    executeValidateDatabaseReferences(input as unknown as ValidateDatabaseReferencesInput, getNotionClient()) as never,
});

// ── estimate-github-hours ──────────────────────────────────────────

worker.tool("estimate-github-hours", {
  title: "Estimate GitHub Hours",
  description:
    "Estimates hours for a GitHub PR or issue based on diff stats, labels, and complexity signals. Returns a structured estimate with confidence level.",
  schema: j.object({
    owner: j.string(),
    repo: j.string(),
    number: j.number(),
    type: j.enum("pr", "issue"),
  }),
  execute: (input) =>
    executeEstimateGitHubHours(input as unknown as EstimateGitHubHoursInput) as never,
});

// ── sync-time-log ──────────────────────────────────────────────────────

worker.tool("sync-time-log", {
  title: "Sync Time Log",
  description:
    "Scans GitHub Items for recent PRs/issues and auto-creates Time Log entries with hour estimates. Uses estimate-github-hours logic internally. Deduplicates against existing entries. Respects [EST*] prefix conventions.",
  schema: j.object({
    lookback_days: j.number().nullable(),
    repo_filter: j.array(j.string()).nullable(),
    item_types: j.array(j.enum("Issue", "PR")).nullable(),
    dry_run: j.boolean().nullable(),
  }),
  execute: (input, context) =>
    executeSyncTimeLog(input as unknown as SyncTimeLogInput, getNotionClient()) as never,
});

// ── write-agent-ops-run ────────────────────────────────────────────────

worker.tool("write-agent-ops-run", {
  title: "Write Agent Ops Run",
  description:
    "Records the outcome of an agent run in the Agent Ops database. Maps to canonical Run Status values and applies heartbeat coercion when input is contradictory.",
  schema: j.object({
    agent_name: j.string(),
    run_date: j.string(),
    status_type: j.enum("sync", "snapshot", "report", "heartbeat"),
    status_value: j.enum("complete", "partial", "failed", "full_report", "stub"),
    digest_page_id: j.string().nullable(),
    digest_page_url: j.string().nullable(),
    notes: j.string().nullable(),
    flagged_count: j.number().nullable(),
    needs_review_count: j.number().nullable(),
    escalation_count: j.number().nullable(),
    warnings: j.array(j.string()).nullable(),
  }),
  execute: (input, context) =>
    executeWriteAgentOpsRun(input as unknown as WriteAgentOpsRunInput, getNotionClient()) as never,
});

// ── normalize-agent-ops-options ────────────────────────────────────────

worker.tool("normalize-agent-ops-options", {
  title: "Normalize Agent Ops Options",
  description:
    "One-shot migration tool: scans the Agent Ops database and rewrites lowercase / stale Run Status values to canonical Notion options. Read-only by default (dry_run=true).",
  schema: j.object({
    dry_run: j.boolean().nullable(),
    max_pages: j.number().nullable(),
    status_property: j.string().nullable(),
  }),
  execute: (input, context) =>
    executeNormalizeAgentOpsOptions(input as unknown as NormalizeAgentOpsOptionsInput, getNotionClient()) as never,
});

// ── validate-client-share-scope ────────────────────────────────────────

worker.tool("validate-client-share-scope", {
  title: "Validate Client Share Scope",
  description:
    "Read-only safety check. Verifies a source document is approved, not sensitive, has a single client scope, and identifies internal links/mentions/embedded blocks before publishing.",
  schema: j.object({
    source_page_id: j.string(),
    client_relation_ids: j.array(j.string()).nullable(),
    project_relation_ids: j.array(j.string()).nullable(),
    strict: j.boolean().nullable(),
  }),
  execute: (input, context) =>
    executeValidateClientShareScope(input as unknown as ClientShareScopeInput, getNotionClient()) as never,
});

// ── redact-client-document ─────────────────────────────────────────────

worker.tool("redact-client-document", {
  title: "Redact Client Document",
  description:
    "Strips internal Notion URLs and mentions out of a body of text. Pure logic — no Notion API calls. Returns the redacted text and a list of redactions.",
  schema: j.object({
    text: j.string(),
    internal_mention_placeholder: j.string().nullable(),
  }),
  execute: (input) => executeRedactClientDocument(input as unknown as RedactClientDocumentInput) as never,
});

// ── prepare-client-doc-update ──────────────────────────────────────────

worker.tool("prepare-client-doc-update", {
  title: "Prepare Client Doc Update",
  description:
    "Reads a source page, validates scope, and produces a sanitized title and body that can be safely written to a client portal. Read-only.",
  schema: j.object({
    source_page_id: j.string(),
    client_id: j.string().nullable(),
    project_id: j.string().nullable(),
    dry_run: j.boolean().nullable(),
    strict: j.boolean().nullable(),
  }),
  execute: (input, context) =>
    executePrepareClientDocUpdate(input as unknown as PrepareClientDocUpdateInput, getNotionClient()) as never,
});

// ── detect-client-doc-drift ────────────────────────────────────────────

worker.tool("detect-client-doc-drift", {
  title: "Detect Client Doc Drift",
  description:
    "Compares a source document against its published client copy and reports whether the published copy is out of sync.",
  schema: j.object({
    source_page_id: j.string(),
    published_page_id: j.string().nullable(),
  }),
  execute: (input, context) =>
    executeDetectClientDocDrift(input as unknown as DetectClientDocDriftInput, getNotionClient()) as never,
});

// ── publish-client-doc-update ──────────────────────────────────────────

worker.tool("publish-client-doc-update", {
  title: "Publish Client Doc Update",
  description:
    "Runs scope checks, sanitizes content, and writes a client-safe copy to CLIENT_SHARED_DOCUMENTS_DATABASE_ID. Supports dry_run and force (accept WARN-level issues). Logs a client share event for every outcome.",
  schema: j.object({
    source_page_id: j.string(),
    dry_run: j.boolean().nullable(),
    force: j.boolean().nullable(),
  }),
  execute: (input, context) =>
    executePublishClientDocUpdate(input as unknown as PublishClientDocUpdateInput, getNotionClient()) as never,
});

// ── create-client-review-task ──────────────────────────────────────────

worker.tool("create-client-review-task", {
  title: "Create Client Review Task",
  description:
    "Creates a Task asking a human to review a client publishing decision (e.g. WARN-level scope issues).",
  schema: j.object({
    source_page_id: j.string(),
    client_id: j.string(),
    reason: j.string(),
    priority: j.enum("🔴 High", "🟡 Medium", "🟢 Low").nullable(),
  }),
  execute: (input, context) =>
    executeCreateClientReviewTask(input as unknown as CreateClientReviewTaskInput, getNotionClient()) as never,
});

// ── sync-client-portal-index ───────────────────────────────────────────

worker.tool("sync-client-portal-index", {
  title: "Sync Client Portal Index",
  description:
    "Reports the current published documents for a given client, sourced from CLIENT_SHARED_DOCUMENTS_DATABASE_ID.",
  schema: j.object({
    client_id: j.string(),
    dry_run: j.boolean().nullable(),
  }),
  execute: (input, context) =>
    executeSyncClientPortalIndex(input as unknown as SyncClientPortalIndexInput, getNotionClient()) as never,
});

// ── audit-client-portal-access ─────────────────────────────────────────

worker.tool("audit-client-portal-access", {
  title: "Audit Client Portal Access",
  description:
    "Reports per-client publish footprint and flags clients that have shared documents but no portal configured.",
  schema: j.object({
    client_id: j.string().nullable(),
  }),
  execute: (input, context) =>
    executeAuditClientPortalAccess(input as unknown as AuditClientPortalAccessInput, getNotionClient()) as never,
});

// ── revoke-client-access ───────────────────────────────────────────────

worker.tool("revoke-client-access", {
  title: "Revoke Client Access",
  description:
    "Archives all client-shared documents for a given client so they no longer appear on the client portal. Default: dry_run=true.",
  schema: j.object({
    client_id: j.string(),
    reason: j.string(),
    dry_run: j.boolean().nullable(),
  }),
  execute: (input, context) =>
    executeRevokeClientAccess(input as unknown as RevokeClientAccessInput, getNotionClient()) as never,
});

// ── log-client-share-event ─────────────────────────────────────────────

worker.tool("log-client-share-event", {
  title: "Log Client Share Event",
  description:
    "Logs a client publishing event to Agent Ops (when configured) and creates a deduped Dead Letter for non-success events.",
  schema: j.object({
    source_page_id: j.string(),
    client_id: j.string(),
    event_type: j.enum("publish", "block", "partial", "fail", "revoke"),
    message: j.string(),
    published_page_id: j.string().nullable(),
  }),
  execute: (input, context) =>
    executeLogClientShareEvent(input as unknown as LogClientShareEventInput, getNotionClient()) as never,
});
