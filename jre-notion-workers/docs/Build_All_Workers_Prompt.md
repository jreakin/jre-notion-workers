# Build All Notion Workers — Implementation Prompt

> **Context:** You are building workers for the `jre-notion-workers` project — a TypeScript codebase deployed to Notion's Workers SDK infrastructure. These workers extend a Custom Agents fleet that automates workspace operations via the Notion API.
>
> **Your job:** Implement each worker as a new `.ts` file in `src/workers/`, add the corresponding types to `src/shared/types.ts`, register each worker in `src/index.ts`, and update shared modules as specified. Follow every convention documented below exactly.

---

## Project Overview

**Repo:** `jre-notion-workers`
**Runtime:** Node 22, deployed via `ntn workers deploy`
**Package manager (dev):** Bun
**Dependencies:** `@notionhq/client ^2.2.15`, `@notionhq/workers ^0.1.0`, `date-fns ^3.6.0`
**No new dependencies allowed** — use only what's already in `package.json`.

### File Structure (Current)

```
src/
├── index.ts                    # Worker registration (all tools)
├── shared/
│   ├── agent-config.ts         # Agent names, digest patterns, target DBs
│   ├── block-builder.ts        # Notion block construction helpers
│   ├── date-utils.ts           # formatRunTime, hoursAgo, parseRunTimeString, nextBusinessDay
│   ├── notion-client.ts        # Cached Notion client + DB ID getters
│   ├── status-parser.ts        # parseStatusLine, buildStatusLine, hasHeartbeatLine
│   └── types.ts                # All input/output types for every worker
└── workers/
    ├── calculate-credit-forecast.ts
    ├── check-upstream-status.ts
    ├── check-url-status.ts
    ├── create-handoff-marker.ts
    ├── lint-agents-file.ts
    ├── log-dead-letter.ts
    ├── monitor-fleet-status.ts
    ├── read-repo-file.ts
    ├── scan-briefing-failures.ts
    └── write-agent-digest.ts
```

---

## Conventions You Must Follow

### 1. Worker File Pattern

Every worker file exports a single `async function execute<WorkerName>(input: <Input>, notion: Client): Promise<<Output>>`. The function receives a typed input object and a Notion client instance. It never instantiates its own client.

```typescript
// Example: src/workers/my-worker.ts
import type { Client } from "@notionhq/client";
import type { MyWorkerInput, MyWorkerOutput } from "../shared/types.js";

export async function executeMyWorker(
  input: MyWorkerInput,
  notion: Client
): Promise<MyWorkerOutput> {
  // validate inputs
  // call Notion API
  // return typed output
}
```

**Key conventions:**
- Import `Client` as a type only (`import type`)
- Import DB ID getters from `../shared/notion-client.js`
- Import agent constants from `../shared/agent-config.js`
- Import date/status helpers from their respective shared modules
- All `.js` extensions in import paths (ESM)
- Console logging uses `[worker-name]` prefix: `console.log("[my-worker] did something")`
- Error handling: wrap Notion API calls in try/catch, return `{ success: false, error: message }` on failure
- Never throw — always return a typed error response

### 2. Type Definitions (`src/shared/types.ts`)

Every worker has a paired `<Worker>Input` interface and `<Worker>Output` type. Output is always a discriminated union on `success`:

```typescript
export interface MyWorkerInput {
  required_field: string;
  optional_field?: number;
}

export type MyWorkerOutput =
  | { success: true; /* result fields */ }
  | { success: false; error: string };
```

### 3. Registration in `src/index.ts`

Each worker is registered with `worker.tool()` using the `j` schema builder from `@notionhq/workers/schema-builder`:

```typescript
import { executeMyWorker } from "./workers/my-worker.js";
import type { MyWorkerInput } from "./shared/types.js";

worker.tool("my-worker", {
  title: "My Worker",
  description: "One-line description of what this tool does and when agents should use it.",
  schema: j.object({
    required_field: j.string(),
    optional_field: j.number().nullable(),
  }),
  execute: (input, context) =>
    executeMyWorker(input as unknown as MyWorkerInput, getNotionClient()) as never,
});
```

**Schema conventions:**
- Optional fields use `.nullable()` in the schema
- Arrays use `j.array(j.object({...}))`
- Enums use `j.enum("value1", "value2")`
- The `as unknown as` cast bridges the schema builder types to your TypeScript types
- Return type cast as `never` to satisfy the SDK's generic constraint

### 4. Environment Variables (via `notion-client.ts`)

Available DB ID getters — use these, never hardcode IDs:
- `getDocsDatabaseId()` → `DOCS_DATABASE_ID`
- `getHomeDocsDatabaseId()` → `HOME_DOCS_DATABASE_ID`
- `getTasksDatabaseId()` → `TASKS_DATABASE_ID`
- `getSystemControlPlanePageId()` → `SYSTEM_CONTROL_PLANE_PAGE_ID`
- `getDeadLettersDatabaseId()` → `DEAD_LETTERS_DATABASE_ID`

New getters to add for this batch (see Shared Module Updates section):
- `getGitHubItemsDatabaseId()` → `GITHUB_ITEMS_DATABASE_ID`
- `getFollowUpTrackerDatabaseId()` → `FOLLOW_UP_TRACKER_DATABASE_ID`
- `getAiMeetingsDatabaseId()` → `AI_MEETINGS_DATABASE_ID`
- `getClientsDatabaseId()` → `CLIENTS_DATABASE_ID`
- `getContactsDatabaseId()` → `CONTACTS_DATABASE_ID`
- `getProjectsDatabaseId()` → `PROJECTS_DATABASE_ID`
- `getDecisionLogDatabaseId()` → `DECISION_LOG_DATABASE_ID`
- `getLabelRegistryDatabaseId()` → `LABEL_REGISTRY_DATABASE_ID`

### 5. Agent Config (`src/shared/agent-config.ts`)

Contains:
- `AGENT_DIGEST_PATTERNS` — maps agent name → array of title substrings to match digests
- `AGENT_TARGET_DB` — maps agent name → `"docs"` or `"home_docs"`
- `VALID_AGENT_NAMES` — derived from AGENT_DIGEST_PATTERNS keys
- `SUSPENDED_AGENTS` — agents excluded from fleet scans
- `MONITORED_AGENTS` — all valid agents minus suspended minus Fleet Monitor

### 6. Staleness Thresholds (from System Control Plane)

- **Daily agents:** 36 hours
- **Weekly agents:** 9 days (216 hours)
- **Bi-weekly agents:** 18 days (432 hours)
- **Monthly agents:** 40 days (960 hours)

### 7. Dead Letters Database Schema

| Property | Type | Values |
|----------|------|--------|
| Title | title | `{Agent Name} — {Date} — {Failure Type}` |
| Agent Name | select | Any valid agent name |
| Expected Run Date | date | YYYY-MM-DD |
| Failure Type | select | Missing Digest, Partial Run, Failed Run, Stale Snapshot |
| Detected By | select | Dead Letter Logger, Morning Briefing, Manual |
| Resolution Status | select | Open, In Progress, Resolved, Duplicate |
| Resolved Date | date | Auto-set when Resolution Status → Resolved |
| Resolution Notes | rich_text | What fixed it |
| Notes | rich_text | Signal line or description |
| Linked Task | relation | Optional link to Tasks DB |

### 8. Digest Page Structure

```
{Status Type} Status: {emoji} {Value}
Heartbeat: no actionable items          ← (only if heartbeat)
Run Time: YYYY-MM-DD HH:mm (America/Chicago)
Scope: {description}
Input versions: {upstream agents and timestamps}

## Flagged Items
- Item description [task link] or (no_task_reason)

## Actions Taken
Created Tasks: [task1](url), [task2](url)
Updated Tasks: [task3](url)

## Summary
Free-text summary of findings.

## Needs Review
- Item requiring human review

## Escalations
- Escalated to: {agent} — Reason: {reason} — Owner: {owner}
```

### 9. Updated Agent Cadences (Post-Refactor)

| Agent | Cadence | Notes |
|-------|---------|-------|
| Inbox Manager | 3x daily (07:00, 12:00, 17:00 CT) | Enhanced with follow-up detection |
| Personal Ops Manager | 2x daily (07:30, 17:30 CT) | |
| GitHub Insyncerator | Daily (08:00 CT) | |
| Morning Briefing | Daily (09:00 CT) | Enhanced with action items section |
| Fleet Ops Agent | Daily (09:30 CT) + monthly forecast | Merged Fleet Monitor + Dead Letter Logger + Credit Forecast |
| Client Briefing Agent | Daily (07:00 CT) | New — heartbeat unless meetings detected |
| Response Drafter | Daily (07:45 CT) | New — drafts email replies |
| Client Repo Auditor | Weekly (Mon 09:00 CT) | |
| Docs Librarian | Bi-weekly + Monthly | Archive extracted to worker |
| VEP Weekly Reporter | Weekly (Fri 18:00 CT) | |
| Home & Life Task Watcher | Weekly (Mon 08:30 CT) | |
| Time Log Auditor | Weekly (Fri 17:00 CT) | |
| Client Health Scorecard | Monthly (1st 10:00 CT) | Enhanced with meeting recency |
| Drift Watcher | Bi-weekly (Mon) | Changed from weekly |
| Template Freshness Watcher | Monthly (suspended until May 2026) | |

---

## Workers to Build

There are **7 workers** total. Workers 1-4 are from the original batch. Workers 5-7 are new workers required by the agent fleet refactor.

---

### Worker 1: `reconcile-github-items`

**Purpose:** Compares the Abstract-Data GitHub org's actual repository list (fetched via the GitHub API) against the Notion GitHub Items database and produces a structured reconciliation report.

**Called by:** GitHub Insyncerator (weekly reconciliation pass), Client Repo Auditor (on-demand)

**Input:**
```typescript
export interface ReconcileGitHubItemsInput {
  org_name: string;           // GitHub org, e.g. "Abstract-Data"
  include_forks?: boolean;    // Whether to include forked repos (default: false)
  include_archived?: boolean; // Whether to include archived repos (default: true)
  dry_run?: boolean;          // If true, report only — don't modify Notion (default: true)
}
```

**Output:**
```typescript
export type ReconcileGitHubItemsOutput =
  | {
      success: true;
      github_repo_count: number;
      notion_repo_count: number;
      matched: number;
      in_github_not_notion: string[];
      in_notion_not_github: string[];
      archived_in_github: string[];
      forked_in_github: string[];
      malformed_notion_rows: string[];
      actions_taken: string[];
      summary: string;
    }
  | { success: false; error: string };
```

**Implementation:**
1. Fetch repos from GitHub REST API: `GET https://api.github.com/orgs/{org}/repos?per_page=100&type=all`. Paginate if `Link` header contains `rel="next"`. Authenticate with `process.env.GITHUB_TOKEN` via `getGitHubToken()` helper (add to `notion-client.ts`).
2. Filter out forks unless `include_forks=true`. Separate archived repos into their own list.
3. Query Notion GitHub Items database filtered to `Type = "Repo"` rows only.
4. Match on repo full name (e.g., `Abstract-Data/repo-name`) or URL.
5. Compute three sets: matched (in both), in_github_not_notion (missing from Notion), in_notion_not_github (orphan rows in Notion).
6. Check each Notion row for required fields (Name, URL) — flag malformed rows.
7. For `dry_run=false`: DO NOT delete orphan rows. Only add a note to their `Notes` property: `"[reconcile-github-items] Not found in GitHub org as of {date}"`.
8. Log each discrepancy: `console.log("[reconcile-github-items] orphan:", rowName)`.
9. Return summary like: `"Reconciled 36 GitHub repos against 47 Notion rows: 34 matched, 2 missing from Notion, 13 orphan Notion rows, 0 malformed"`.

---

### Worker 2: `check-agent-staleness`

**Purpose:** Checks each agent's last digest timestamp against its cadence-based staleness threshold. Creates Dead Letter records for overdue agents.

**Called by:** Fleet Ops Agent (daily), Weekly Data Quality Report agent (weekly)

**Input:**
```typescript
export interface CheckAgentStalenessInput {
  agent_names?: string[];     // Restrict to specific agents. If empty, check all monitored agents.
  thresholds?: {              // Override default thresholds (hours)
    daily?: number;           // default: 36
    weekly?: number;          // default: 216
    biweekly?: number;        // default: 432
    monthly?: number;         // default: 960
  };
  dry_run?: boolean;          // If true, report only — don't create Dead Letters. Default: false.
}
```

**Output:**
```typescript
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
```

**Implementation:**
1. Use `AGENT_CADENCE` map (add to `agent-config.ts` — see Shared Module Updates) to determine each agent's cadence.
2. For each agent: find latest digest using the same query pattern as `monitor-fleet-status`. Extract run time from digest content using `parseRunTimeString()`.
3. Calculate age in hours using `hoursAgo()` from `date-utils.ts`.
4. Compare age against the cadence-appropriate threshold from `STALENESS_THRESHOLDS` (or override).
5. For stale agents when `dry_run=false`:
   a. First check for existing Dead Letter: query Dead Letters DB with `{ and: [{ property: "Agent Name", select: { equals: agentName }}, { property: "Expected Run Date", date: { equals: todayStr }}, { property: "Resolution Status", select: { does_not_equal: "Resolved" }}]}`.
   b. If no existing record: call `executeLogDeadLetter()` (import from `./log-dead-letter.js`) with `failure_type: "Stale Snapshot"`, `detected_by: "Fleet Ops Agent"`.
   c. Capture the Dead Letter page URL for the output.
6. Return summary: `"Checked 14 agents: 2 stale (Docs Librarian 11d, VEP Weekly Reporter 10d), 2 Dead Letters created"`.

---

### Worker 3: `validate-digest-quality`

**Purpose:** Inspects a digest page for governance compliance. Validates status lines, run times, section structure, and task linking.

**Called by:** Any agent as post-write validation, Weekly Data Quality Report agent (batch scan)

**Input:**
```typescript
export interface ValidateDigestQualityInput {
  page_id: string;            // Notion page ID of the digest to validate
  agent_name?: string;        // Agent name for context-specific rules
  post_comment?: boolean;     // Add a comment listing issues found. Default: false.
}
```

**Output:**
```typescript
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
```

**Validation rules:**

| # | Rule ID | Check | Fail/Warn |
|---|---------|-------|-----------|
| 1 | `status_line_present` | First 10 lines contain "Sync Status:", "Snapshot Status:", or "Report Status:" | FAIL |
| 2 | `status_line_parseable` | `parseStatusLine()` from `status-parser.ts` returns non-null on the status line | FAIL |
| 3 | `run_time_present` | First 10 lines contain "Run Time:" with a datetime string | FAIL |
| 4 | `run_time_recent` | Parsed run time is within 48 hours of the page's `created_time` | WARN |
| 5 | `scope_present` | First 15 lines contain "Scope:" | WARN |
| 6 | `flagged_items_section` | Page contains an H2 or H3 heading "Flagged Items" | WARN |
| 7 | `flagged_items_linked` | Every bulleted item under "Flagged Items" heading contains either `[` (markdown link) or `(` immediately preceded by a space (parenthetical reason). Skip if no flagged items exist. | WARN |
| 8 | `summary_section` | Page contains an H2 or H3 heading "Summary" | WARN |

**Implementation:**
1. Fetch page metadata: `notion.pages.retrieve({ page_id })`. Extract title from `properties`, URL from `url`, created_time.
2. Fetch blocks: `notion.blocks.children.list({ block_id: page_id, page_size: 100 })`. If `has_more`, paginate.
3. Extract text content from `paragraph`, `heading_2`, `heading_3`, and `bulleted_list_item` blocks. For each block, concatenate rich_text items' `plain_text` values.
4. Collect the first 15 text lines for header checks (rules 1-5).
5. For rules 6-8: scan all heading blocks for matching text.
6. For rule 7: identify the "Flagged Items" heading, then collect all `bulleted_list_item` blocks that follow it until the next heading. Check each for link or reason pattern.
7. If `post_comment=true` and any FAIL findings exist: `notion.comments.create({ parent: { page_id }, rich_text: [{ text: { content: formatFindings(failFindings) }}] })`.
8. `passed = findings.every(f => f.status !== "FAIL")`.
9. `score = "{passCount}/{totalCount} checks passed"`.

---

### Worker 4: `archive-old-digests`

**Purpose:** Enforces 90-day digest retention policy. Sets Status to "Archived" on old digest pages. Does NOT delete or trash pages.

**Called by:** Docs Librarian (bi-weekly/monthly runs), any agent needing cleanup

**Input:**
```typescript
export interface ArchiveOldDigestsInput {
  retention_days?: number;         // Default: 90
  target_database?: "docs" | "home_docs" | "both";  // Default: "docs"
  dry_run?: boolean;               // Default: true
  max_pages?: number;              // Safety limit. Default: 50.
  exclude_doc_types?: string[];    // Default: ["Client Report"]
}
```

**Output:**
```typescript
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
```

**Implementation:**
1. Calculate cutoff date: `subDays(new Date(), retention_days)` using `date-fns`.
2. Build Notion filter: `{ and: [{ property: "Created Time", created_time: { before: cutoffISO }}, { property: "Doc Type", select: { equals: "Agent Digest" }}, { property: "Status", select: { does_not_equal: "Archived" }}]}`.
3. For each `exclude_doc_types` entry, add a `{ property: "Doc Type", select: { does_not_equal: type }}` clause. (Note: Notion API doesn't support `not_in` — you'll need individual clauses in the `and` array.)
4. Query with `sorts: [{ property: "Created Time", direction: "ascending" }]`, `page_size: 100`.
5. Process up to `max_pages` results.
6. For `dry_run=false`: `notion.pages.update({ page_id, properties: { Status: { status: { name: "Archived" }}}})`.
   - **CRITICAL:** Use `properties.Status.status` not `properties.Status.select` — check the actual property type in your database. If Status is a `status` type, use `{ status: { name: "Archived" }}`. If it's a `select` type, use `{ select: { name: "Archived" }}`. Query the database schema first if unsure.
   - **CRITICAL:** Do NOT use `notion.pages.update({ archived: true })` — that trashes the page. We only set the Status property.
7. Log each: `console.log("[archive-old-digests] archived:", title, age, "days old")`.
8. If any update fails, increment `total_errors`, log the error, continue processing remaining pages.
9. If `target_database="both"`: run the same logic for both Docs and Home Docs databases sequentially.
10. Return summary: `"Archived 12 digests older than 90 days from Docs database (3 skipped, 0 errors)"`.

---

### Worker 5: `auto-link-meeting-client` (NEW)

**Purpose:** Takes an AI Meeting Notes page (or scans all unlinked ones) and fuzzy-matches content against the Clients and Points of Contact databases to set the Client and Project relations.

**Called by:** Docs Librarian (bi-weekly scan), Client Briefing Agent (pre-briefing check), any agent processing meeting notes

**Prerequisite databases:**
- AI Meeting Notes (data source: `collection://f1c3bddf-5f76-454d-b739-7451483099b4`) — must have `Client` (relation → Clients) and `Project` (relation → Projects) properties added before this worker runs.
- Clients database
- Points of Contact database (if it exists — degrade gracefully if not)

**Input:**
```typescript
export interface AutoLinkMeetingClientInput {
  meeting_page_id?: string;    // Specific page to process
  scan_unlinked?: boolean;     // true = scan all AI Meeting Notes where Client relation is empty. Default: false.
  max_pages?: number;          // Max pages to process when scanning. Default: 20.
  dry_run?: boolean;           // Report matches without writing. Default: false.
}
```

**Output:**
```typescript
export interface MeetingLinkResult {
  page_id: string;
  title: string;
  client_matched: string | null;
  project_matched: string | null;
  match_type: "exact_name" | "contact_name" | "email_domain" | "tag_keyword" | "title_match" | "none";
  confidence: "high" | "medium" | "low";
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
```

**Implementation:**

1. **Load reference data first** (do this once per run, not per page):
   a. Query Clients database: fetch all client pages, extract `Name` (title property) and `id`. Store as `Map<string, string>` (lowercase name → page ID).
   b. Query Points of Contact database (if env var exists): fetch all contacts, extract `Name`, `Email`, and their Client relation. Store as lookup maps:
      - `contactNameToClientId: Map<string, string>` (lowercase contact name → client page ID)
      - `emailDomainToClientId: Map<string, string>` (email domain → client page ID)
   c. Query Projects database: fetch active projects, extract `Name` and `Client` relation. Store as `projectNameToId: Map<string, string>`.

2. **Get meeting pages to process:**
   - If `meeting_page_id` is provided: fetch that single page.
   - If `scan_unlinked=true`: query AI Meeting Notes where `Client` relation is empty, limit `max_pages`, sort by `When` descending (newest first).
   - If neither provided: return `{ success: false, error: "Provide meeting_page_id or set scan_unlinked=true" }`.

3. **For each meeting page, attempt matching in priority order:**

   a. **Read matchable content:** Extract the `Context` property (rich_text), `Tags` property (multi_select), and page title.

   b. **Exact client name match (high confidence):**
      - For each client name in the clients map, check if it appears (case-insensitive) in the Context text, the page title, or the Tags values.
      - If found → match with `match_type: "exact_name"`, `confidence: "high"`.

   c. **Contact name match (high confidence):**
      - For each contact name in the contacts map, check if it appears in the Context text or page title.
      - If found → resolve to their client via `contactNameToClientId`, match with `match_type: "contact_name"`, `confidence: "high"`.

   d. **Email domain match (medium confidence):**
      - Extract any email addresses from the Context text using regex `[\w.-]+@[\w.-]+\.\w+`.
      - Extract domain from each email. Check against `emailDomainToClientId`.
      - If found → match with `match_type: "email_domain"`, `confidence: "medium"`.

   e. **Tag keyword match (medium confidence):**
      - Check if any Tag value matches a client name (case-insensitive).
      - If found → match with `match_type: "tag_keyword"`, `confidence: "medium"`.

   f. **Title match (low confidence):**
      - Check if the meeting title contains any client name as a substring.
      - If found → match with `match_type: "title_match"`, `confidence: "low"`.

   g. **No match:**
      - `match_type: "none"`, `confidence: "low"`, `linked: false`.

   **Conflict resolution:** If multiple clients match, prefer: exact_name > contact_name > email_domain > tag_keyword > title_match. If still tied, prefer the match with the most occurrences in the Context text.

4. **Set relations (when `dry_run=false` and a match is found):**
   - Update the meeting page: `notion.pages.update({ page_id, properties: { Client: { relation: [{ id: clientPageId }] }}})`.
   - If the matched client has active projects and one project name appears in the Context or title: also set `Project` relation.

5. **Log each result:** `console.log("[auto-link-meeting-client]", title, "→", clientName || "no match", matchType)`.

6. **Return summary:** `"Processed 15 meeting notes: 11 linked (8 high, 2 medium, 1 low confidence), 4 unmatched"`.

---

### Worker 6: `tag-untagged-docs` (NEW)

**Purpose:** Finds documents in Docs (and optionally Home Docs) where `Document Type` is empty and infers the correct type from the page title and content patterns.

**Called by:** Docs Librarian (bi-weekly enhancement), Weekly Data Quality Report agent (dry_run=true for counts)

**Input:**
```typescript
export interface TagUntaggedDocsInput {
  target_database?: "docs" | "home_docs" | "both";  // Default: "docs"
  max_pages?: number;          // Default: 20
  dry_run?: boolean;           // Default: true
}
```

**Output:**
```typescript
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
```

**Implementation:**

1. Query target database(s) with filter: `{ property: "Doc Type", select: { is_empty: true }}`. Sort by `Created Time` descending. Limit to `max_pages`.

2. For each page, apply inference rules **in order** (first match wins):

   | Priority | Condition | Inferred Type | Rule Name |
   |----------|-----------|---------------|-----------|
   | 1 | Title matches any value in `AGENT_DIGEST_PATTERNS` from `agent-config.ts` | "Agent Digest" | `agent_digest_pattern` |
   | 2 | Title contains "Email Triage ERROR" or "Personal Triage ERROR" | "Agent Digest" | `error_digest_pattern` |
   | 3 | Title starts with "Client Briefing —" | "Client Briefing" | `client_briefing_pattern` |
   | 4 | Title contains "Proposal" | "Proposal" | `title_keyword_proposal` |
   | 5 | Title contains "Report" or "Audit" | "Report" | `title_keyword_report` |
   | 6 | Title contains "Spec" or "Technical" | "Technical Spec" | `title_keyword_spec` |
   | 7 | Title contains "Meeting" or "Notes" | "Meeting Notes" | `title_keyword_meeting` |
   | 8 | Title contains "Invoice" or "Receipt" | "Financial" | `title_keyword_financial` |
   | 9 | Title contains "Contract" or "Agreement" or "SOW" | "Contract" | `title_keyword_contract` |
   | 10 | No match | null (flag as "Needs Review") | `no_match` |

3. For `dry_run=false` and non-null inferred type: `notion.pages.update({ page_id, properties: { "Doc Type": { select: { name: inferredType }}}})`.

4. For null inference (no match): do NOT set anything. Increment `total_needs_review`. The calling agent can surface these in a "Needs Review" section.

5. Log each: `console.log("[tag-untagged-docs]", title, "→", inferredType || "needs review", rule)`.

6. Return summary: `"Scanned 20 untagged docs: 15 auto-tagged, 5 need manual review"`.

---

### Worker 7: `validate-project-completeness` (NEW)

**Purpose:** Scans the Projects database for data completeness issues. Returns a structured report of gaps.

**Called by:** Weekly Data Quality Report agent, Docs Librarian (on-demand)

**Input:**
```typescript
export interface ValidateProjectCompletenessInput {
  status_filter?: string[];    // Filter to specific statuses. Default: ["Active", "In Progress", "Planning"]
  client_filter?: string;      // Filter to a specific client page ID. Optional.
  dry_run?: boolean;           // Always true for this worker — it never writes. Included for API consistency.
}
```

**Output:**
```typescript
export interface ProjectCompleteness {
  page_id: string;
  project_name: string;
  client_name: string | null;
  status: string;
  issues: ProjectIssue[];
  issue_count: number;
}

export interface ProjectIssue {
  severity: "FAIL" | "WARN";
  rule: string;
  message: string;
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
```

**Validation rules:**

| # | Rule ID | Check | Severity |
|---|---------|-------|----------|
| 1 | `missing_description` | Description property is empty | FAIL |
| 2 | `missing_client` | Client relation is empty | WARN |
| 3 | `no_tasks` | No linked Tasks (Tasks relation count = 0) | WARN |
| 4 | `past_target_completion` | Target Completion date is before today AND Status is not "Completed" | FAIL |
| 5 | `no_linked_docs` | No linked Docs (Docs relation count = 0) | WARN |
| 6 | `missing_status` | Status property is empty or null | FAIL |

**Implementation:**

1. Build filter for Projects database: `Status` is in `status_filter` values. If `client_filter` provided, add Client relation contains filter.
2. Query Projects with all properties. For relation properties (Tasks, Docs, Client), you only need to check if the relation array is empty — you don't need to fetch the related pages.
3. For each project, run all 6 rules. Collect issues.
4. Only include projects with at least one issue in the output (skip clean projects to keep output compact).
5. Sort output: FAIL-only projects first, then by issue count descending.
6. This worker is read-only — it never modifies any database. The `dry_run` parameter exists for API consistency but has no effect.
7. Return summary: `"Checked 12 active projects: 8 clean, 3 with warnings, 1 with failures"`.

---

## Shared Module Updates

### `src/shared/notion-client.ts` — Add these getters:

```typescript
export function getGitHubItemsDatabaseId(): string {
  const id = process.env.GITHUB_ITEMS_DATABASE_ID;
  if (!id) throw new Error("GITHUB_ITEMS_DATABASE_ID is not set");
  return id;
}

export function getGitHubToken(): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  return token;
}

export function getFollowUpTrackerDatabaseId(): string {
  const id = process.env.FOLLOW_UP_TRACKER_DATABASE_ID;
  if (!id) throw new Error("FOLLOW_UP_TRACKER_DATABASE_ID is not set");
  return id;
}

export function getAiMeetingsDatabaseId(): string {
  const id = process.env.AI_MEETINGS_DATABASE_ID;
  if (!id) throw new Error("AI_MEETINGS_DATABASE_ID is not set");
  return id;
}

export function getClientsDatabaseId(): string {
  const id = process.env.CLIENTS_DATABASE_ID;
  if (!id) throw new Error("CLIENTS_DATABASE_ID is not set");
  return id;
}

export function getContactsDatabaseId(): string | null {
  // Optional — returns null if not configured (graceful degradation)
  return process.env.CONTACTS_DATABASE_ID || null;
}

export function getProjectsDatabaseId(): string {
  const id = process.env.PROJECTS_DATABASE_ID;
  if (!id) throw new Error("PROJECTS_DATABASE_ID is not set");
  return id;
}

export function getDecisionLogDatabaseId(): string {
  const id = process.env.DECISION_LOG_DATABASE_ID;
  if (!id) throw new Error("DECISION_LOG_DATABASE_ID is not set");
  return id;
}

export function getLabelRegistryDatabaseId(): string {
  const id = process.env.LABEL_REGISTRY_DATABASE_ID;
  if (!id) throw new Error("LABEL_REGISTRY_DATABASE_ID is not set");
  return id;
}
```

### `src/shared/agent-config.ts` — Add:

```typescript
export type AgentCadence = "daily" | "weekly" | "biweekly" | "monthly";

export const AGENT_CADENCE: Record<string, AgentCadence> = {
  "Inbox Manager": "daily",
  "Personal Ops Manager": "daily",
  "GitHub Insyncerator": "daily",
  "Morning Briefing": "daily",
  "Fleet Ops Agent": "daily",
  "Response Drafter": "daily",
  "Client Briefing Agent": "daily",
  "Client Repo Auditor": "weekly",
  "Docs Librarian": "biweekly",
  "VEP Weekly Reporter": "weekly",
  "Home & Life Watcher": "weekly",
  "Time Log Auditor": "weekly",
  "Drift Watcher": "biweekly",
  "Client Health Scorecard": "monthly",
  "Template Freshness Watcher": "monthly",
};

export const STALENESS_THRESHOLDS: Record<AgentCadence, number> = {
  daily: 36,
  weekly: 216,
  biweekly: 432,
  monthly: 960,
};
```

**Also update `AGENT_DIGEST_PATTERNS`** to reflect the refactored fleet:
- Remove entries for "Fleet Monitor", "Dead Letter Logger", "Credit Forecast Tracker"
- Add entries for:
  - `"Fleet Ops Agent": ["Fleet Ops"]`
  - `"Response Drafter": ["Response Drafter", "Draft Status"]`
  - `"Client Briefing Agent": ["Client Briefing"]`

**Also update `SUSPENDED_AGENTS`** and `MONITORED_AGENTS` to reflect the new fleet roster.

### `src/shared/types.ts` — Add:

All 7 worker input/output types defined above. Export them all. The full list of new exports:

```typescript
// Worker 1
export { ReconcileGitHubItemsInput, ReconcileGitHubItemsOutput }
// Worker 2
export { CheckAgentStalenessInput, StalenessEntry, CheckAgentStalenessOutput }
// Worker 3
export { ValidateDigestQualityInput, QualityFinding, ValidateDigestQualityOutput }
// Worker 4
export { ArchiveOldDigestsInput, ArchivedDigest, ArchiveOldDigestsOutput }
// Worker 5
export { AutoLinkMeetingClientInput, MeetingLinkResult, AutoLinkMeetingClientOutput }
// Worker 6
export { TagUntaggedDocsInput, TaggedDocResult, TagUntaggedDocsOutput }
// Worker 7
export { ValidateProjectCompletenessInput, ProjectCompleteness, ProjectIssue, ValidateProjectCompletenessOutput }
```

---

## Registration in `src/index.ts`

Add 7 new `worker.tool()` blocks. Here are all 7 registrations:

```typescript
// --- Worker 1: reconcile-github-items ---
import { executeReconcileGitHubItems } from "./workers/reconcile-github-items.js";
import type { ReconcileGitHubItemsInput } from "./shared/types.js";

worker.tool("reconcile-github-items", {
  title: "Reconcile GitHub Items",
  description:
    "Compares the GitHub org's actual repos against the Notion GitHub Items database. Identifies orphan rows, missing repos, and malformed entries.",
  schema: j.object({
    org_name: j.string(),
    include_forks: j.boolean().nullable(),
    include_archived: j.boolean().nullable(),
    dry_run: j.boolean().nullable(),
  }),
  execute: (input, context) =>
    executeReconcileGitHubItems(input as unknown as ReconcileGitHubItemsInput, getNotionClient()) as never,
});

// --- Worker 2: check-agent-staleness ---
import { executeCheckAgentStaleness } from "./workers/check-agent-staleness.js";
import type { CheckAgentStalenessInput } from "./shared/types.js";

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

// --- Worker 3: validate-digest-quality ---
import { executeValidateDigestQuality } from "./workers/validate-digest-quality.js";
import type { ValidateDigestQualityInput } from "./shared/types.js";

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

// --- Worker 4: archive-old-digests ---
import { executeArchiveOldDigests } from "./workers/archive-old-digests.js";
import type { ArchiveOldDigestsInput } from "./shared/types.js";

worker.tool("archive-old-digests", {
  title: "Archive Old Digests",
  description:
    "Enforces digest retention policy by setting Status to Archived on digest pages older than the retention period. Does NOT delete pages.",
  schema: j.object({
    retention_days: j.number().nullable(),
    target_database: j.enum("docs", "home_docs", "both").nullable(),
    dry_run: j.boolean().nullable(),
    max_pages: j.number().nullable(),
    exclude_doc_types: j.array(j.string()).nullable(),
  }),
  execute: (input, context) =>
    executeArchiveOldDigests(input as unknown as ArchiveOldDigestsInput, getNotionClient()) as never,
});

// --- Worker 5: auto-link-meeting-client ---
import { executeAutoLinkMeetingClient } from "./workers/auto-link-meeting-client.js";
import type { AutoLinkMeetingClientInput } from "./shared/types.js";

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

// --- Worker 6: tag-untagged-docs ---
import { executeTagUntaggedDocs } from "./workers/tag-untagged-docs.js";
import type { TagUntaggedDocsInput } from "./shared/types.js";

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

// --- Worker 7: validate-project-completeness ---
import { executeValidateProjectCompleteness } from "./workers/validate-project-completeness.js";
import type { ValidateProjectCompletenessInput } from "./shared/types.js";

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
```

---

## Environment Variables Summary

**Existing (already configured):**
- `NTN_API_TOKEN` — Notion integration token
- `DOCS_DATABASE_ID` — Main Docs database
- `HOME_DOCS_DATABASE_ID` — Personal Hub Docs
- `TASKS_DATABASE_ID` — Tasks database
- `SYSTEM_CONTROL_PLANE_PAGE_ID` — Control Plane page
- `DEAD_LETTERS_DATABASE_ID` — Dead Letters database

**New (add to `.env.local` and `.env.1p`):**
- `GITHUB_ITEMS_DATABASE_ID` — GitHub Items database
- `GITHUB_TOKEN` — GitHub personal access token (read-only scope: `public_repo`)
- `FOLLOW_UP_TRACKER_DATABASE_ID` — Follow-Up Tracker database (create database first, then set this)
- `AI_MEETINGS_DATABASE_ID` — AI Meeting Notes database (ID: `f1c3bddf-5f76-454d-b739-7451483099b4` based on known data source)
- `CLIENTS_DATABASE_ID` — Clients database
- `CONTACTS_DATABASE_ID` — Points of Contact database (optional — worker degrades gracefully if not set)
- `PROJECTS_DATABASE_ID` — Projects database
- `DECISION_LOG_DATABASE_ID` — Decision Log database (create database first, then set this)
- `LABEL_REGISTRY_DATABASE_ID` — Label Registry database (ID: based on known data source `821797a6-89be-4225-b42c-34e3d4905a79`)

---

## Testing Checklist

After implementing all 7 workers:

1. `npm run check` (tsc --noEmit) passes with zero type errors.
2. Each worker handles missing/invalid input gracefully (returns `{ success: false, error }`, never throws).
3. `dry_run=true` (where applicable) returns data without any side effects — no database writes, no comments posted.
4. All Notion API calls are wrapped in try/catch.
5. Console logging uses the `[worker-name]` prefix convention consistently.
6. All imports use `.js` extensions (ESM convention).
7. No new dependencies were added to `package.json`.
8. All 7 registrations in `index.ts` compile and the schema matches the TypeScript types.
9. `auto-link-meeting-client` degrades gracefully when `CONTACTS_DATABASE_ID` is not set (skips contact matching, still does client name matching).
10. `archive-old-digests` NEVER uses `notion.pages.update({ archived: true })` — only sets Status property.

---

## File Checklist (What Gets Created/Modified)

**New files (7):**
- `src/workers/reconcile-github-items.ts`
- `src/workers/check-agent-staleness.ts`
- `src/workers/validate-digest-quality.ts`
- `src/workers/archive-old-digests.ts`
- `src/workers/auto-link-meeting-client.ts`
- `src/workers/tag-untagged-docs.ts`
- `src/workers/validate-project-completeness.ts`

**Modified files (4):**
- `src/shared/types.ts` — add all 7 input/output type pairs + helper interfaces
- `src/shared/notion-client.ts` — add 9 new getter functions
- `src/shared/agent-config.ts` — add `AgentCadence` type, `AGENT_CADENCE` map, `STALENESS_THRESHOLDS` map, update `AGENT_DIGEST_PATTERNS`, update `SUSPENDED_AGENTS` and `MONITORED_AGENTS`
- `src/index.ts` — add 7 new `worker.tool()` registrations with imports
