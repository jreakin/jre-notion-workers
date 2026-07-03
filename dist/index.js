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
import { executeSyncCrmAccounts, } from "./workers/sync-crm-accounts.js";
import { executeSyncHoursByClient } from "./workers/sync-hours-by-client.js";
import { executeLabelGitHubPrs } from "./workers/label-github-prs.js";
import { executeSyncZohoProjects, } from "./workers/sync-zoho-projects.js";
import { githubItemsSchema, executeSyncGitHubRepos, } from "./workers/sync-github-repos.js";
import { executeScheduler, workerRunsSchema, } from "./workers/scheduler.js";
// Plan tools (create-plan, read-plan-feedback, reply-to-plan-comment,
// update-plan-block, confirm-implementation) migrated to abstract-data serve
// MCP tools — ADR-0009. plan-webhook remains as the server-side event handler.
import { handlePlanWebhookEvents } from "./workers/plan-webhook.js";
import { executeAutofillTaskClients } from "./workers/autofill-task-clients.js";
import { executeAutofillDocsProjects } from "./workers/autofill-docs-projects.js";
import { executeAutofillMeetingDates } from "./workers/autofill-meeting-dates.js";
import { executeAutofillTaskPriority } from "./workers/autofill-task-priority.js";
import { executeAuditTimeLog } from "./workers/audit-time-log.js";
import { executeAuditDevEnvironment } from "./workers/audit-dev-environment.js";
import { executeRunFleetOpsDaily } from "./workers/run-fleet-ops-daily.js";
import { executeComposeMorningBriefing } from "./workers/compose-morning-briefing.js";
import { executeRouteInbox } from "./workers/route-inbox.js";
import { getNotionClient } from "./shared/notion-client.js";
const worker = new Worker();
export default worker;
// ── write-agent-digest ───────────────────────────────────────────────
const taskRefSchema = j.object({
    name: j.string(),
    notion_url: j.string(),
});
worker.tool("write-agent-digest", {
    title: "Write Agent Digest",
    description: "Creates a governance-compliant agent digest or report page in the Docs database. Handles all formatting, status line formatting, section ordering, and ERROR-title naming automatically.",
    schema: j.object({
        agent_name: j.string(),
        agent_emoji: j.string(),
        status_type: j.enum("sync", "snapshot", "report", "heartbeat"),
        status_value: j.enum("complete", "partial", "failed", "full_report", "stub"),
        run_time_chicago: j.string(),
        scope: j.string(),
        input_versions: j.string(),
        flagged_items: j.array(j.object({
            description: j.string(),
            task_link: j.string(),
            no_task_reason: j.string(),
        })),
        actions_taken: j.object({
            created_tasks: j.array(taskRefSchema),
            updated_tasks: j.array(taskRefSchema),
            auto_closed_by_pr: j.array(taskRefSchema),
        }),
        summary: j.string(),
        needs_review: j.array(j.object({ description: j.string() })),
        escalations: j.array(j.object({
            escalated_to: j.string(),
            escalation_reason: j.string(),
            escalation_owner: j.string(),
            handoff_complete: j.boolean(),
        })),
        target_database: j.enum("docs", "home_docs", "agent_ops"),
        doc_type: j.string(),
        client_relation_ids: j.array(j.string()),
        project_relation_ids: j.array(j.string()),
        digest_type_override: j.string().nullable(),
    }),
    execute: (input, context) => executeWriteAgentDigest(input, getNotionClient()),
});
// ── check-upstream-status ────────────────────────────────────────────
worker.tool("check-upstream-status", {
    title: "Check Upstream Status",
    description: 'Finds the most recent digest page for a given agent, reads its machine-readable status line and run timestamp, and returns a structured status object. agent_name must be an exact match from: "Inbox Manager", "Personal Ops Manager", "GitHub Insyncerator", "Client Repo Auditor", "Docs Librarian", "VEP Weekly Reporter", "Home & Life Task Watcher", "Time Log Auditor", "Client Health Scorecard", "Morning Briefing", "Drift Watcher", "Fleet Ops Agent", "Response Drafter", "Client Briefing Agent".',
    schema: j.object({
        agent_name: j.string(),
        max_age_hours: j.number(),
        require_current_cycle: j.boolean(),
    }),
    execute: (input, context) => executeCheckUpstreamStatus(input, getNotionClient()),
});
// ── create-handoff-marker ────────────────────────────────────────────
worker.tool("create-handoff-marker", {
    title: "Create Handoff Marker",
    description: "Creates a structured handoff record when an agent needs to escalate to another agent. Returns a pre-formatted Escalations block and optionally creates a tracking Task in Notion.",
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
    execute: (input, context) => executeCreateHandoffMarker(input, getNotionClient()),
});
// ── monitor-fleet-status ─────────────────────────────────────────────
worker.tool("monitor-fleet-status", {
    title: "Monitor Fleet Status",
    description: "Batch-queries all monitored agents' latest digests and returns fleet-wide status data. Returns per-agent status, run times, degraded flags, and a heartbeat summary message.",
    schema: j.object({
        agent_names: j.array(j.string()).nullable(),
    }),
    execute: (input, context) => executeMonitorFleetStatus(input, getNotionClient()),
});
// ── scan-briefing-failures ───────────────────────────────────────────
worker.tool("scan-briefing-failures", {
    title: "Scan Briefing Failures",
    description: "Reads today's Morning Briefing digest and extracts structured failure signals (missing digests, partial runs, failed runs, stale snapshots). Used by Dead Letter Logger.",
    schema: j.object({
        briefing_date: j.string().nullable(),
    }),
    execute: (input, context) => executeScanBriefingFailures(input, getNotionClient()),
});
// ── log-dead-letter ──────────────────────────────────────────────────
worker.tool("log-dead-letter", {
    title: "Log Dead Letter",
    description: "Creates a structured record in the Dead Letters database for a single agent failure. Sets Resolution Status to Open. Never modifies or deletes existing records.",
    schema: j.object({
        agent_name: j.string(),
        expected_run_date: j.string(),
        failure_type: j.enum("Missing Digest", "Partial Run", "Failed Run", "Stale Snapshot"),
        detected_by: j.enum("Dead Letter Logger", "Morning Briefing", "Manual", "Fleet Ops Agent", "check-agent-staleness"),
        notes: j.string(),
        linked_task_id: j.string().nullable(),
    }),
    execute: (input, context) => executeLogDeadLetter(input, getNotionClient()),
});
// ── calculate-credit-forecast ────────────────────────────────────────
worker.tool("calculate-credit-forecast", {
    title: "Calculate Credit Forecast",
    description: "Pure calculation tool: takes agent credit data, computes monthly burn projection with buffer, week-over-week delta, and dollar estimate. Returns structured forecast for digest writing.",
    schema: j.object({
        agent_data: j.array(j.object({
            agent_name: j.string(),
            est_runs_per_month: j.number(),
            est_credits_per_run: j.number(),
            is_suspended: j.boolean(),
        })),
        previous_buffered_total: j.number().nullable(),
        pricing_rate: j.number().nullable(),
        buffer_percentage: j.number().nullable(),
    }),
    execute: (input) => executeCalculateCreditForecast(input),
});
// ── lint-agents-file ───────────────────────────────────────────────
worker.tool("lint-agents-file", {
    title: "Lint AGENTS File",
    description: "Fetches an AGENTS.md file (or overlay) from a GitHub repository and validates it against the AGENTS.md CI Linter Spec. Returns pass/fail with per-rule findings.",
    schema: j.object({
        repo: j.string(),
        path: j.string(),
        ref: j.string(),
    }),
    execute: (input) => executeLintAgentsFile(input),
});
// ── read-repo-file ─────────────────────────────────────────────────
worker.tool("read-repo-file", {
    title: "Read Repo File",
    description: "Fetches the raw text content of a file from a GitHub repository. Use this to read AGENTS.md overlays, config files, or any other text file in a private or public repo.",
    schema: j.object({
        repo: j.string(),
        path: j.string(),
        ref: j.string(),
        max_chars: j.number(),
    }),
    execute: (input) => executeReadRepoFile(input),
});
// ── check-url-status ───────────────────────────────────────────────
worker.tool("check-url-status", {
    title: "Check URL Status",
    description: "Checks whether one or more upstream URLs are reachable and optionally validates that expected content is present. Returns a structured status for each URL so agents can gate their run on data freshness.",
    schema: j.object({
        urls: j.array(j.object({
            url: j.string(),
            label: j.string(),
            expected_text: j.string(),
            max_age_hours: j.number(),
        })),
        timeout_ms: j.number(),
    }),
    execute: (input) => executeCheckUrlStatus(input),
});
// ── sync-github-items ─────────────────────────────────────────────
worker.tool("sync-github-items", {
    title: "Sync GitHub Items",
    description: "Syncs GitHub repos, issues, and PRs from configured sources (orgs/users) into the Notion GitHub Items database. Creates new rows for items not yet tracked, updates existing rows when GitHub data is newer. Uses GitHub URL as the unique idempotent key. Optional update_github_pr_titles: PATCHes each PR on GitHub so the title reflects linked Notion Project, Client, and Task names (in that order).",
    schema: j.object({
        sources: j
            .array(j.object({
            name: j.string(),
            type: j.enum("org", "user"),
            token_env: j.string().nullable(),
        }))
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
        update_github_pr_titles: j.boolean().nullable(),
    }),
    execute: (input, context) => executeSyncGitHubItems(input, getNotionClient()),
});
// ── check-agent-staleness ──────────────────────────────────────────
worker.tool("check-agent-staleness", {
    title: "Check Agent Staleness",
    description: "Checks each agent's last digest timestamp against cadence-based staleness thresholds. Creates Dead Letter records for overdue agents.",
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
    execute: (input, context) => executeCheckAgentStaleness(input, getNotionClient()),
});
// ── validate-digest-quality ────────────────────────────────────────
worker.tool("validate-digest-quality", {
    title: "Validate Digest Quality",
    description: "Inspects a digest page for governance compliance: status lines, run times, section structure, and task linking. Returns pass/fail findings.",
    schema: j.object({
        page_id: j.string(),
        agent_name: j.string().nullable(),
        post_comment: j.boolean().nullable(),
    }),
    execute: (input, context) => executeValidateDigestQuality(input, getNotionClient()),
});
// ── archive-old-digests ────────────────────────────────────────────
worker.tool("archive-old-digests", {
    title: "Archive Old Digests",
    description: "Enforces digest retention policy by setting Status to Archived on digest pages older than the retention period. Does NOT delete pages.",
    schema: j.object({
        retention_days: j.number().nullable(),
        target_database: j.enum("docs", "home_docs", "agent_ops", "both", "all").nullable(),
        dry_run: j.boolean().nullable(),
        max_pages: j.number().nullable(),
        exclude_patterns: j.array(j.string()).nullable(),
    }),
    execute: (input, context) => executeArchiveOldDigests(input, getNotionClient()),
});
// ── auto-link-meeting-client ───────────────────────────────────────
worker.tool("auto-link-meeting-client", {
    title: "Auto-Link Meeting to Client",
    description: "Fuzzy-matches AI Meeting Notes pages against the Clients and Contacts databases to set Client and Project relations. Processes a specific page or scans all unlinked meetings.",
    schema: j.object({
        meeting_page_id: j.string().nullable(),
        scan_unlinked: j.boolean().nullable(),
        max_pages: j.number().nullable(),
        dry_run: j.boolean().nullable(),
    }),
    execute: (input, context) => executeAutoLinkMeetingClient(input, getNotionClient()),
});
// ── tag-untagged-docs ──────────────────────────────────────────────
worker.tool("tag-untagged-docs", {
    title: "Tag Untagged Docs",
    description: "Finds documents with empty Document Type and infers the correct type from title patterns. Tags them or flags for manual review.",
    schema: j.object({
        target_database: j.enum("docs", "home_docs", "both").nullable(),
        max_pages: j.number().nullable(),
        dry_run: j.boolean().nullable(),
    }),
    execute: (input, context) => executeTagUntaggedDocs(input, getNotionClient()),
});
// ── validate-project-completeness ──────────────────────────────────
worker.tool("validate-project-completeness", {
    title: "Validate Project Completeness",
    description: "Scans active Projects for data completeness issues: missing descriptions, unlinked clients, no tasks, past-due dates. Read-only — never modifies data.",
    schema: j.object({
        status_filter: j.array(j.string()).nullable(),
        client_filter: j.string().nullable(),
        dry_run: j.boolean().nullable(),
    }),
    execute: (input, context) => executeValidateProjectCompleteness(input, getNotionClient()),
});
// ── resolve-stale-dead-letters ─────────────────────────────────────
worker.tool("resolve-stale-dead-letters", {
    title: "Resolve Stale Dead Letters",
    description: "Auto-resolves Open dead letters for an agent when a successful run supersedes prior transient failures (Stale Snapshot, Missing Digest). Call after confirming a successful agent run.",
    schema: j.object({
        agent_name: j.string(),
        successful_run_date: j.string(),
        resolvable_failure_types: j.array(j.string()).nullable(),
        dry_run: j.boolean().nullable(),
    }),
    execute: (input, context) => executeResolveStaleDeadLetters(input, getNotionClient()),
});
// ── validate-database-references ───────────────────────────────────
worker.tool("validate-database-references", {
    title: "Validate Database References",
    description: "Checks that a list of Notion database IDs are accessible. Catches broken references before they cascade into agent failures. Optionally logs Dead Letters for broken refs.",
    schema: j.object({
        references: j.array(j.object({
            database_id: j.string(),
            label: j.string(),
            used_by: j.array(j.string()).nullable(),
        })),
        check_schema: j.boolean().nullable(),
        log_dead_letters: j.boolean().nullable(),
    }),
    execute: (input, context) => executeValidateDatabaseReferences(input, getNotionClient()),
});
// ── estimate-github-hours ──────────────────────────────────────────
worker.tool("estimate-github-hours", {
    title: "Estimate GitHub Hours",
    description: "Estimates hours for a GitHub PR or issue based on diff stats, labels, and complexity signals. Returns a structured estimate with confidence level.",
    schema: j.object({
        owner: j.string(),
        repo: j.string(),
        number: j.number(),
        type: j.enum("pr", "issue"),
    }),
    execute: (input) => executeEstimateGitHubHours(input),
});
// ── sync-time-log ──────────────────────────────────────────────────────
worker.tool("sync-time-log", {
    title: "Sync Time Log",
    description: "Scans GitHub Items for recent PRs/issues and auto-creates Time Log entries with hour estimates. Uses estimate-github-hours logic internally. Deduplicates against existing entries. Respects [EST*] prefix conventions. Pass inherit_relations: true to also backfill Client, Project, and Task relations on existing Time Log entries from their linked GitHub Items — this replaces Database Agent automations that do the same linking.",
    schema: j.object({
        lookback_days: j.number().nullable(),
        repo_filter: j.array(j.string()).nullable(),
        item_types: j.array(j.enum("Issue", "PR")).nullable(),
        dry_run: j.boolean().nullable(),
        inherit_relations: j.boolean().nullable(),
        full_scan: j.boolean().nullable(),
    }),
    execute: (input, context) => executeSyncTimeLog(input, getNotionClient()),
});
// ── sync-hours-by-client ────────────────────────────────────────────
worker.tool("sync-hours-by-client", {
    title: "Sync Hours by Client",
    description: "Aggregates all Time Log entries by Client and Project, then writes a formatted hours snapshot to a target Notion page. Replaces the data-query loop in the Time Log Auditor agent — the agent should call this first, then interpret the structured output for its audit digest. Pass the Notion page ID for the Agent Shared Data — Hours by Client page as target_page_id.",
    schema: j.object({
        target_page_id: j.string(),
        lookback_days: j.number().nullable(),
        default_rate_per_hour: j.number().nullable(),
        dry_run: j.boolean().nullable(),
    }),
    execute: (input, _context) => executeSyncHoursByClient(input, getNotionClient()),
});
// ── sync-crm-accounts ──────────────────────────────────────────────
worker.tool("sync-crm-accounts", {
    title: "Sync CRM Accounts → Notion Clients",
    description: "Polls Zoho CRM for Accounts where 'Notion_Client_ID' is empty, creates or updates matching pages in the Notion Clients database, then writes the Notion page ID back to CRM. Acts as a scheduled replacement for the Zoho Flow B webhook (CRM → Notion direction). Requires ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, and ZOHO_REFRESH_TOKEN env vars. The Notion Clients DB must have a rich-text property named 'CRM Account ID'.",
    schema: j.object({
        max_accounts: j.number().nullable(),
        dry_run: j.boolean().nullable(),
        only_missing_notion_id: j.boolean().nullable(),
    }),
    execute: (input, _context) => executeSyncCrmAccounts(input, getNotionClient()),
});
// ── label-github-prs ───────────────────────────────────────────────
worker.tool("label-github-prs", {
    title: "Label GitHub PRs",
    description: "Scans PRs across configured GitHub sources (orgs/users) and applies labels inferred from conventional commit prefixes in the PR title (fix→bug, feat→feature, docs→documentation, chore, refactor, test, ci, style, perf→performance). Idempotent: skips PRs that already have the inferred label. Safe: never removes existing labels. Auto-creates missing labels on repos if create_missing_labels is true (default). Use dry_run: true to preview changes without applying them.",
    schema: j.object({
        sources: j
            .array(j.object({
            name: j.string(),
            type: j.enum("org", "user"),
        }))
            .nullable(),
        state: j.enum("open", "closed", "all").nullable(),
        max_prs_per_repo: j.number().nullable(),
        create_missing_labels: j.boolean().nullable(),
        dry_run: j.boolean().nullable(),
    }),
    execute: (input) => executeLabelGitHubPrs(input),
});
// ── sync-zoho-projects ────────────────────────────────────────────
worker.tool("sync-zoho-projects", {
    title: "Sync Notion Projects → Zoho Projects",
    description: "Push Notion Projects to Zoho Projects (abstractdatallc portal). Matches by project name — updates existing Zoho projects and creates new ones for Notion projects not yet in Zoho. Syncs name, description, dates, budget, and billing method. Defaults to Active, Planning, and On Hold statuses.",
    schema: j.object({
        status_filter: j.array(j.string()).nullable(),
        max_projects: j.number().nullable(),
        dry_run: j.boolean().nullable(),
    }),
    execute: (input) => executeSyncZohoProjects(input),
});
// ══════════════════════════════════════════════════════════════════
// PLANS — Agent ↔ user collaboration on implementation plans.
// The five agent-initiated tools (create-plan, read-plan-feedback,
// reply-to-plan-comment, update-plan-block, confirm-implementation) were
// migrated to abstract-data serve MCP tools (ADR-0009). What remains here
// is the server-side event handler: the plan-events webhook, which routes
// Notion comment/Status/content events on Plan pages and page.created
// events on the Submissions data source (via applyPlanUpdate, now folded
// into plan-webhook.ts).
// ══════════════════════════════════════════════════════════════════
// ── plan-events webhook ───────────────────────────────────────────
// Subscribe via `ntn` to the Plans DB only, scoped to:
//   comment.created, comment.updated, page.properties_updated
// Sets Has Open Comments / Last Comment At / Approved At on plan pages
// so agents can poll one property to know whether to act.
worker.webhook("plan-events", {
    title: "Plan Collaboration Events",
    description: "Routes Notion comment + Status events on Plan pages back into per-plan properties (Has Open Comments, Last Comment At, Approved At) for the agent to poll.",
    execute: async (events) => {
        await handlePlanWebhookEvents(events, getNotionClient());
    },
});
// Submission events flow through the plan-events webhook above —
// Notion caps subscriptions at one per Connection, so the dispatcher in
// plan-webhook.ts routes page.created events on the Submissions data
// source directly to applyPlanUpdate (folded into plan-webhook.ts, ADR-0009).
// ══════════════════════════════════════════════════════════════════
// SYNCS — Native Notion Workers sync API (new in March 2026)
// Syncs manage their own databases. They run on a schedule and
// Notion handles row matching, pagination state, and stale cleanup.
// ══════════════════════════════════════════════════════════════════
// ── sync-github-repos ─────────────────────────────────────────────
// Parallel deployment alongside sync-github-items (tool). Creates a
// separate "GitHub Items (Sync)" database to validate the sync pattern
// before migrating the primary GitHub Items DB.
const githubItemsDb = worker.database("github-items-db", {
    type: "managed",
    initialTitle: githubItemsSchema.defaultName,
    primaryKeyProperty: "GitHub URL",
    schema: { properties: githubItemsSchema.properties },
});
worker.sync("github-items-sync", {
    database: githubItemsDb,
    mode: "incremental",
    schedule: "30m",
    execute: executeSyncGitHubRepos,
});
// ── scheduler ──────────────────────────────────────────────────────
// Wraps the 9 net-new tool capabilities (autofills + audits + briefing)
// in a single Worker.sync() with built-in 5-minute scheduling. Each tick
// dispatches every capability whose cadence has elapsed since last fire.
// Logs every attempt to the managed "Worker Runs" database for visibility.
const workerRunsDb = worker.database("worker-runs-db", {
    type: "managed",
    initialTitle: workerRunsSchema.defaultName,
    primaryKeyProperty: "Run ID",
    schema: { properties: workerRunsSchema.properties },
});
worker.sync("scheduler", {
    database: workerRunsDb,
    mode: "incremental",
    schedule: "5m",
    execute: executeScheduler,
});
// ══════════════════════════════════════════════════════════════════
// AUTOFILL WORKERS — Deterministic replacements for AI-property columns.
// Each is a Worker.tool() with { page_id?, max_pages?, dry_run? } so it can
// be invoked one row at a time or as a bulk sweep on a schedule.
// Rule logic lives in src/shared/autofill-rules.ts and is unit-tested.
// ══════════════════════════════════════════════════════════════════
const autofillSchema = j.object({
    page_id: j.string().nullable(),
    max_pages: j.number().nullable(),
    dry_run: j.boolean().nullable(),
});
worker.tool("autofill-task-clients", {
    title: "Autofill Task → Client",
    description: "Fills the Client relation on Task rows by following Task → Project → Client. Scans rows where Client is empty AND Project is set, or processes a single page_id when provided. Replaces the AI-property column previously fronting this lookup.",
    schema: autofillSchema,
    execute: (input) => executeAutofillTaskClients(input, getNotionClient()),
});
worker.tool("autofill-docs-projects", {
    title: "Autofill Doc → Project",
    description: "Matches Docs with no Project relation against active Projects via title-keyword + tag overlap. Leaves the relation empty and logs the reason when the result is ambiguous (two projects tied). Replaces an AI-property column.",
    schema: autofillSchema,
    execute: (input) => executeAutofillDocsProjects(input, getNotionClient()),
});
worker.tool("autofill-meeting-dates", {
    title: "Autofill Meeting → When",
    description: "Extracts a meeting's date from its linked Calendar Event relation and writes it to the When property. Skips rows already filled or with no linked event. Replaces an AI-property column.",
    schema: autofillSchema,
    execute: (input) => executeAutofillMeetingDates(input, getNotionClient()),
});
worker.tool("autofill-task-priority", {
    title: "Autofill Task Priority",
    description: "Deterministically sets Task Priority from due-date proximity, the linked client's Tier, and the 'blocked' tag. Replaces an AI-property column. See src/shared/autofill-rules.ts for the rules.",
    schema: autofillSchema,
    execute: (input) => executeAutofillTaskPriority(input, getNotionClient()),
});
// ══════════════════════════════════════════════════════════════════
// AUDIT + ORCHESTRATION WORKERS — Wave 2
// ══════════════════════════════════════════════════════════════════
worker.tool("audit-time-log", {
    title: "Audit Time Log",
    description: "Daily Time Log Auditor replacement. Joins time entries against tasks/clients and surfaces: missed logging (active tasks updated recently with no entries), retainer overruns (client actual hours this billing period vs. cap), unbilled closed tasks. Also backfills empty Client/Project/Task/GitHub Item (PR/Repo) relations on Time Log entries — GitHub Item first, then Task fallback, idempotent — when backfill_relations is true (default). Writes a 'Time Log Audit' digest to agent_ops when write_digest is true (default).",
    schema: j.object({
        today: j.string().nullable(),
        active_task_lookback_days: j.number().nullable(),
        write_digest: j.boolean().nullable(),
        backfill_relations: j.boolean().nullable(),
        dry_run: j.boolean().nullable(),
    }),
    execute: (input) => executeAuditTimeLog(input, getNotionClient()),
});
worker.tool("audit-dev-environment", {
    title: "Audit Dev Environment Health",
    description: "Weekly walk of the AI Agent Dev Environment Setup databases (Reference Documentation, Agent Skills, Setup Templates). Counts stale records, orphaned skills, and rows missing required metadata. Writes a 'Dev Environment Health' digest to agent_ops.",
    schema: j.object({
        reference_docs_db: j.string().nullable(),
        agent_skills_db: j.string().nullable(),
        setup_templates_db: j.string().nullable(),
        write_digest: j.boolean().nullable(),
        dry_run: j.boolean().nullable(),
    }),
    execute: (input) => executeAuditDevEnvironment(input, getNotionClient()),
});
worker.tool("run-fleet-ops-daily", {
    title: "Run Fleet Ops Daily",
    description: "Daily orchestration: monitor-fleet-status → resolve-stale-dead-letters for every current agent → calculate-credit-forecast → write one consolidated 'Fleet Ops' digest. Use today=YYYY-MM-DD to override the run date.",
    schema: j.object({
        today: j.string().nullable(),
        write_digest: j.boolean().nullable(),
        dry_run: j.boolean().nullable(),
    }),
    execute: (input) => executeRunFleetOpsDaily(input, getNotionClient()),
});
// ══════════════════════════════════════════════════════════════════
// WAVE 3 — Morning Briefing + Inbox Router
// ══════════════════════════════════════════════════════════════════
worker.tool("compose-morning-briefing", {
    title: "Compose Morning Briefing",
    description: "Concatenates today's agent_ops digests (titles matching AGENT_DIGEST_PATTERNS) under per-agent section headers in a single 'Morning Briefing — YYYY-MM-DD' page. No AI synthesis. Scheduled daily after run-fleet-ops-daily so the Fleet Ops digest is included.",
    schema: j.object({
        today: j.string().nullable(),
        dry_run: j.boolean().nullable(),
    }),
    execute: (input) => executeComposeMorningBriefing(input, getNotionClient()),
});
worker.tool("route-inbox", {
    title: "Route Inbox Message",
    description: "Rule-based inbox classifier. Loads Clients + active Projects from Notion and returns { client, project, needs_reply, suggested_tags, reason } for a single message. Matches sender domain (and contact-derived domains) → Client; subject/body keywords → Project; direct-address + question marks + action verbs → needs_reply. Pure classification logic lives in src/shared/inbox-rules.ts.",
    schema: j.object({
        sender: j.string(),
        subject: j.string(),
        body: j.string(),
        thread_context: j.string().nullable(),
    }),
    execute: (input) => executeRouteInbox(input, getNotionClient()),
});
