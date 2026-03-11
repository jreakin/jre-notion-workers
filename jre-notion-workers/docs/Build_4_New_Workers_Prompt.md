# Build 4 New Notion Workers — Agent Prompt

> **Context:** You are building 4 new workers for the `jre-notion-workers` project — a TypeScript codebase deployed to Notion's Workers SDK infrastructure. These workers extend an existing 15-agent Custom Agents fleet that automates workspace operations via the Notion API.
>
> **Your job:** Implement each worker as a new `.ts` file in `src/workers/`, add the corresponding types to `src/shared/types.ts`, register each worker in `src/index.ts`, and update `src/shared/agent-config.ts` if needed. Follow every convention documented below exactly.

---

## Project Overview

**Repo:** `jre-notion-workers`
**Runtime:** Node 22, deployed via `ntn workers deploy`
**Package manager (dev):** Bun
**Dependencies:** `@notionhq/client ^2.2.15`, `@notionhq/workers ^0.1.0`, `date-fns ^3.6.0`
**No new dependencies allowed** — use only what's already in `package.json`.

### File Structure

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
- `getDocsDatabaseId()` → `DOCS_DATABASE_ID` (main Docs database)
- `getHomeDocsDatabaseId()` → `HOME_DOCS_DATABASE_ID` (Personal Hub docs)
- `getTasksDatabaseId()` → `TASKS_DATABASE_ID`
- `getSystemControlPlanePageId()` → `SYSTEM_CONTROL_PLANE_PAGE_ID`
- `getDeadLettersDatabaseId()` → `DEAD_LETTERS_DATABASE_ID`

If a new worker needs a DB ID not yet available, add a new getter following the same pattern.

### 5. Agent Config (`src/shared/agent-config.ts`)

Contains:
- `AGENT_DIGEST_PATTERNS` — maps agent name → array of title substrings to match digests
- `AGENT_TARGET_DB` — maps agent name → `"docs"` or `"home_docs"`
- `VALID_AGENT_NAMES` — derived from AGENT_DIGEST_PATTERNS keys
- `SUSPENDED_AGENTS` — agents excluded from fleet scans
- `MONITORED_AGENTS` — all valid agents minus suspended minus Fleet Monitor

### 6. Staleness Thresholds (from System Control Plane)

These are the governance-defined staleness thresholds:
- **Daily agents:** 36 hours
- **Weekly agents:** 9 days (216 hours)
- **Monthly agents:** 40 days (960 hours)

### 7. Agent Cadences

| Agent | Cadence |
|-------|---------|
| Inbox Manager | 3x daily (07:00, 12:00, 17:00 CT) |
| Personal Ops Manager | 2x daily (07:30, 17:30 CT) |
| GitHub Insyncerator | Daily (08:00 CT) |
| Morning Briefing | Daily (09:00 CT) |
| Fleet Monitor | Daily (09:30 CT) |
| Dead Letter Logger | Daily (09:45 CT) |
| Credit Forecast Tracker | Daily |
| Drift Watcher | Daily |
| Time Log Auditor | Daily |
| Client Health Scorecard | Daily |
| Client Repo Auditor | Weekly (Mondays) |
| Docs Librarian | Weekly |
| VEP Weekly Reporter | Weekly |
| Home & Life Task Watcher | Weekly |
| Template Freshness Watcher | Monthly (suspended) |

### 8. Dead Letters Database Schema

| Property | Type | Values |
|----------|------|--------|
| Title | title | `{Agent Name} — {Date} — {Failure Type}` |
| Agent Name | select | Any valid agent name |
| Expected Run Date | date | YYYY-MM-DD |
| Failure Type | select | Missing Digest, Partial Run, Failed Run, Stale Snapshot |
| Detected By | select | Dead Letter Logger, Morning Briefing, Manual |
| Resolution Status | select | Open, In Progress, Resolved, Duplicate |
| Notes | rich_text | Signal line or description |
| Linked Task | relation | Optional link to Tasks DB |

### 9. Digest Page Structure

Agent digests follow a standard format:
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

---

## The 4 Workers to Build

### Worker 1: `reconcile-github-items`

**Purpose:** Compares the Abstract-Data GitHub org's actual repository list (fetched via the GitHub API) against the Notion GitHub Items database and produces a structured reconciliation report. This directly addresses the persistent GitHub Insyncerator failure (repo enumeration mismatch: GitHub shows 36 non-fork repos, Notion has 47 Type=Repo rows).

**Input:**
```typescript
interface ReconcileGitHubItemsInput {
  org_name: string;           // GitHub org, e.g. "Abstract-Data"
  include_forks?: boolean;    // Whether to include forked repos (default: false)
  include_archived?: boolean; // Whether to include archived repos (default: true)
  dry_run?: boolean;          // If true, report only — don't modify Notion (default: true)
}
```

**Output:**
```typescript
type ReconcileGitHubItemsOutput =
  | {
      success: true;
      github_repo_count: number;
      notion_repo_count: number;
      matched: number;
      in_github_not_notion: string[];     // repos that need to be added to Notion
      in_notion_not_github: string[];     // stale/orphan rows in Notion
      archived_in_github: string[];       // archived repos (for awareness)
      forked_in_github: string[];         // forked repos (excluded unless include_forks)
      malformed_notion_rows: string[];    // rows missing required fields (Name, URL, etc.)
      actions_taken: string[];            // what was done (if dry_run=false)
      summary: string;                    // one-line summary for digest embedding
    }
  | { success: false; error: string };
```

**Implementation notes:**
- Use the GitHub REST API via `fetch()` (Node 22 has native fetch). Endpoint: `GET https://api.github.com/orgs/{org}/repos?per_page=100&type=all`. Paginate if needed.
- Authenticate with `process.env.GITHUB_TOKEN` (add a helper `getGitHubToken()` to `notion-client.ts`).
- Query the Notion GitHub Items database. You'll need a new env var: `GITHUB_ITEMS_DATABASE_ID`. Add `getGitHubItemsDatabaseId()` to `notion-client.ts`.
- Filter Notion rows to `Type = "Repo"` (there are also Issue and PR rows).
- Match on repo full name (e.g., `Abstract-Data/repo-name`) or URL.
- For `dry_run=false`: mark orphan Notion rows with a `Reconciliation Status` property (if it exists) or add a note. Do NOT delete rows — only flag them.
- Log each discrepancy: `console.log("[reconcile-github-items] orphan:", rowName)`.

---

### Worker 2: `check-agent-staleness`

**Purpose:** Enforces the System Control Plane staleness thresholds by checking each agent's last digest timestamp against its cadence. Auto-creates Dead Letter records for any overdue agent. This replaces manual monitoring and catches missed weekly/monthly runs.

**Input:**
```typescript
interface CheckAgentStalenessInput {
  /** Restrict to specific agents. If empty/omitted, check all monitored agents. */
  agent_names?: string[];
  /** Override default thresholds (hours). */
  thresholds?: {
    daily?: number;   // default: 36
    weekly?: number;  // default: 216 (9 days)
    monthly?: number; // default: 960 (40 days)
  };
  /** If true, report staleness but don't create Dead Letters. Default: false. */
  dry_run?: boolean;
}
```

**Output:**
```typescript
interface StalenessEntry {
  agent_name: string;
  cadence: "daily" | "weekly" | "monthly";
  last_run_time: string | null;
  age_hours: number | null;
  threshold_hours: number;
  is_stale: boolean;
  dead_letter_created: boolean;
  dead_letter_url: string | null;
  notice: string;
}

type CheckAgentStalenessOutput =
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

**Implementation notes:**
- Add a new constant `AGENT_CADENCE` to `agent-config.ts` mapping each agent name to `"daily" | "weekly" | "monthly"`. Use the cadence table in Section 7 above.
- For each agent, call the same logic as `monitor-fleet-status` to find the latest digest and its age. You can import and reuse the internal `checkSingleAgent` pattern, or query directly.
- Compare age against the cadence-appropriate threshold.
- For stale agents (when `dry_run=false`): call `executeLogDeadLetter()` directly (import the function) to create a Dead Letter record with `failure_type: "Stale Snapshot"` and `detected_by: "Dead Letter Logger"`.
- Before creating a Dead Letter, check if one already exists for this agent + today's date to avoid duplicates. Query the Dead Letters DB with `filter: { and: [{ property: "Agent Name", select: { equals: agentName }}, { property: "Expected Run Date", date: { equals: todayStr }}]}`.
- Return a summary line suitable for embedding in a digest.

---

### Worker 3: `validate-digest-quality`

**Purpose:** Inspects a digest page for governance compliance: are all required sections present, is the status line machine-parseable, is the run time present and valid, are flagged items linked to tasks? Runs as a post-write validation step.

**Input:**
```typescript
interface ValidateDigestQualityInput {
  /** Notion page ID of the digest to validate. */
  page_id: string;
  /** Agent name (for context-specific validation rules). */
  agent_name?: string;
  /** If true, add a comment to the page listing issues found. Default: false. */
  post_comment?: boolean;
}
```

**Output:**
```typescript
interface QualityFinding {
  rule: string;
  status: "PASS" | "FAIL" | "WARN";
  message: string;
}

type ValidateDigestQualityOutput =
  | {
      success: true;
      page_id: string;
      page_url: string | null;
      title: string;
      passed: boolean;
      score: string;          // e.g. "6/8 checks passed"
      findings: QualityFinding[];
      comment_posted: boolean;
    }
  | { success: false; error: string };
```

**Validation rules to implement:**

| # | Rule | Check |
|---|------|-------|
| 1 | `status_line_present` | First 10 lines contain "Sync Status:", "Snapshot Status:", or "Report Status:" |
| 2 | `status_line_parseable` | `parseStatusLine()` returns non-null |
| 3 | `run_time_present` | First 10 lines contain "Run Time:" with a valid datetime |
| 4 | `run_time_recent` | Run time is within 48 hours of page creation |
| 5 | `scope_present` | First 15 lines contain "Scope:" |
| 6 | `flagged_items_section` | Page contains a "Flagged Items" heading |
| 7 | `flagged_items_linked` | Every bulleted item under Flagged Items has either a URL (task_link) or parenthetical reason (no_task_reason). Use WARN if flagged items exist but lack links. |
| 8 | `summary_section` | Page contains a "Summary" heading |

**Implementation notes:**
- Fetch the page via `notion.pages.retrieve({ page_id })` for metadata (title, URL, created_time).
- Fetch blocks via `notion.blocks.children.list({ block_id: page_id, page_size: 100 })`.
- Extract text lines from paragraph and heading blocks (same pattern as `check-upstream-status`).
- Use `parseStatusLine()` and `parseRunTime()` from `status-parser.ts`.
- For rule 7, scan bulleted list items under the "Flagged Items" heading. Check if each contains `[` (link) or `(` (reason).
- If `post_comment=true` and there are FAIL findings, post a comment via `notion.comments.create({ parent: { page_id }, rich_text: [{ text: { content: commentText }}] })`.
- Score = `{passed_count}/{total_count} checks passed`.

---

### Worker 4: `archive-old-digests`

**Purpose:** Enforces the 90-day digest retention policy from the governance doc. Identifies digest pages older than the retention window and marks them for archival by setting their Status property to "Archived". Does NOT delete pages.

**Input:**
```typescript
interface ArchiveOldDigestsInput {
  /** Retention period in days. Default: 90. */
  retention_days?: number;
  /** Target database. Default: "docs". */
  target_database?: "docs" | "home_docs" | "both";
  /** If true, report what would be archived without modifying. Default: true. */
  dry_run?: boolean;
  /** Maximum pages to archive in one run. Default: 50. Safety limit. */
  max_pages?: number;
}
```

**Output:**
```typescript
interface ArchivedDigest {
  page_id: string;
  title: string;
  created_time: string;
  age_days: number;
  status_before: string | null;
  archived: boolean;
}

type ArchiveOldDigestsOutput =
  | {
      success: true;
      database_scanned: string;
      total_candidates: number;
      total_archived: number;
      total_skipped: number;        // already archived or non-digest
      total_errors: number;
      digests: ArchivedDigest[];
      summary: string;
    }
  | { success: false; error: string };
```

**Implementation notes:**
- Query Docs (and/or Home Docs) with a filter: `created_time before {cutoff_date}` AND `Doc Type equals "Agent Digest"` AND `Status does_not_equal "Archived"`.
- Sort by `created_time ascending` (oldest first).
- Paginate with `page_size: 100`, respect `max_pages` limit.
- For `dry_run=false`: update each page via `notion.pages.update({ page_id, properties: { Status: { select: { name: "Archived" }}}})`.
- Do NOT use `notion.pages.update({ archived: true })` — that moves pages to trash. We only want to set the Status property.
- Log each archive action: `console.log("[archive-old-digests] archived:", title, ageInDays, "days old")`.
- Calculate `age_days` using `differenceInDays` from `date-fns`.
- Return a summary line like: `"Archived 12 digests older than 90 days from Docs database (3 skipped, 0 errors)"`.

---

## Shared Module Updates

### `src/shared/notion-client.ts` — Add:

```typescript
export function getGitHubItemsDatabaseId(): string {
  const id = process.env.GITHUB_ITEMS_DATABASE_ID;
  if (!id) throw new Error("GITHUB_ITEMS_DATABASE_ID is not set");
  return id;
}
```

### `src/shared/agent-config.ts` — Add:

```typescript
export type AgentCadence = "daily" | "weekly" | "monthly";

export const AGENT_CADENCE: Record<string, AgentCadence> = {
  "Inbox Manager": "daily",
  "Personal Ops Manager": "daily",
  "GitHub Insyncerator": "daily",
  "Morning Briefing": "daily",
  "Fleet Monitor": "daily",
  "Dead Letter Logger": "daily",
  "Credit Forecast Tracker": "daily",
  "Drift Watcher": "daily",
  "Time Log Auditor": "daily",
  "Client Health Scorecard": "daily",
  "Client Repo Auditor": "weekly",
  "Docs Librarian": "weekly",
  "VEP Weekly Reporter": "weekly",
  "Home & Life Watcher": "weekly",
  "Template Freshness Watcher": "monthly",
};

export const STALENESS_THRESHOLDS: Record<AgentCadence, number> = {
  daily: 36,
  weekly: 216,
  monthly: 960,
};
```

### `src/shared/types.ts` — Add:

All 4 input/output types defined above. Export them all.

---

## Registration in `src/index.ts`

Add 4 new `worker.tool()` blocks following the existing pattern. Example for `reconcile-github-items`:

```typescript
worker.tool("reconcile-github-items", {
  title: "Reconcile GitHub Items",
  description:
    "Compares the GitHub org's actual repos against the Notion GitHub Items database and produces a reconciliation report. Identifies orphan rows, missing repos, and malformed entries.",
  schema: j.object({
    org_name: j.string(),
    include_forks: j.boolean().nullable(),
    include_archived: j.boolean().nullable(),
    dry_run: j.boolean().nullable(),
  }),
  execute: (input, context) =>
    executeReconcileGitHubItems(input as unknown as ReconcileGitHubItemsInput, getNotionClient()) as never,
});
```

Do the same for `check-agent-staleness`, `validate-digest-quality`, and `archive-old-digests`.

---

## Testing

After implementation, ensure:

1. `npm run check` (tsc --noEmit) passes with no type errors.
2. Each worker handles missing/invalid input gracefully (returns `{ success: false, error }`, never throws).
3. `dry_run=true` (where applicable) returns data without side effects.
4. All Notion API calls are wrapped in try/catch.
5. Console logging uses the `[worker-name]` prefix convention.

---

## Environment Variables Summary

Existing:
- `NTN_API_TOKEN` — Notion integration token
- `DOCS_DATABASE_ID` — Main Docs database
- `HOME_DOCS_DATABASE_ID` — Personal Hub Docs
- `TASKS_DATABASE_ID` — Tasks database
- `SYSTEM_CONTROL_PLANE_PAGE_ID` — Control Plane page
- `DEAD_LETTERS_DATABASE_ID` — Dead Letters database

New (add to `.env.local` and `.env.1p`):
- `GITHUB_ITEMS_DATABASE_ID` — GitHub Items database
- `GITHUB_TOKEN` — GitHub personal access token (read-only scope: `repo` or `public_repo`)
