# Build Prompt: `resolve-stale-dead-letters` + `validate-database-references`

> Use this prompt when building these two new Notion Workers in the `jre-notion-workers` codebase.
> It contains the full system context, conventions, schemas, and implementation specs.

---

## System Context

You are adding two new worker tools to the `jre-notion-workers` codebase — a Notion Workers project that deploys server-side TypeScript functions to Notion's infrastructure via the `ntn` CLI. The repo already has 17 deployed tools.

### Codebase Conventions (non-negotiable)

1. **Architecture:** `src/index.ts` registers tools via `Worker.tool()`. Each tool has a JSON schema (using `j` from `@notionhq/workers/schema-builder`) and an `execute` function imported from `src/workers/<name>.ts`.
2. **Types:** All `*Input` and `*Output` types live in `src/shared/types.ts`. Output types are discriminated unions: `{ success: true; ... } | { success: false; error: string }`.
3. **Validation:** Validate all inputs at the top of `execute`. Return `{ success: false, error }` on failure — **never throw**.
4. **Notion client:** Import `getNotionClient()` and DB-ID helpers from `src/shared/notion-client.ts`. Worker `execute` functions receive `(input, notion: Client)`.
5. **Agent config:** `src/shared/agent-config.ts` exports `VALID_AGENT_NAMES`, `AGENT_CADENCE`, `AGENT_DIGEST_PATTERNS`, `AGENT_TARGET_DB`, `SUSPENDED_AGENTS`, `MONITORED_AGENTS`, `isValidAgentName()`, etc.
6. **Status parsing:** `src/shared/status-parser.ts` has `parseStatusLine()`, `parseRunTime()`, `hasHeartbeatLine()`, `buildStatusLine()`.
7. **Date utils:** `src/shared/date-utils.ts` has Chicago-timezone helpers.
8. **Idempotent by default.** Same input twice should produce the same result or safely skip.
9. **Single responsibility.** One tool = one concern.
10. **Structured returns.** Always typed objects with `success` discriminant.
11. **No Bun-specific APIs** in worker source (keep Node-compatible).
12. **Console logging:** Use `console.log("[tool-name] ...")` for operational logs and `console.error("[tool-name] ...")` for errors, matching existing patterns.

### Existing Environment Variables (via `process.env`)

Already configured and available:
- `NTN_API_TOKEN` — Notion API token
- `DOCS_DATABASE_ID` — Main Docs database
- `HOME_DOCS_DATABASE_ID` — Home Docs database
- `TASKS_DATABASE_ID` — Tasks database
- `DEAD_LETTERS_DATABASE_ID` — Dead Letters database
- `SYSTEM_CONTROL_PLANE_PAGE_ID` — Control Plane page
- `GITHUB_ITEMS_DATABASE_ID`, `GITHUB_TOKEN` — GitHub integration
- `CLIENTS_DATABASE_ID`, `PROJECTS_DATABASE_ID`, `CONTACTS_DATABASE_ID`
- `FOLLOW_UP_TRACKER_DATABASE_ID`, `DECISION_LOG_DATABASE_ID`
- `LABEL_REGISTRY_DATABASE_ID`, `AI_MEETINGS_DATABASE_ID`

### Dead Letters Database Schema

Database ID: env `DEAD_LETTERS_DATABASE_ID`
Collection ID: `b59800da-56b5-4316-97c3-98f7a9e37e3b`

| Property | Type | Values / Notes |
|---|---|---|
| Title | title | Format: `{Agent Name} — {Expected Run Date} — {Failure Type}` |
| Agent Name | select | Inbox Manager, Personal Ops Manager, GitHub Insyncerator, Client Repo Auditor, Docs Librarian, VEP Weekly Reporter, Home & Life Watcher, Template Freshness Watcher, Time Log Auditor, Client Health Scorecard, Morning Briefing, Fleet Monitor, Dead Letter Logger, Credit Forecast Tracker, Drift Watcher |
| Detected By | select | Dead Letter Logger, Morning Briefing, Manual |
| Expected Run Date | date | ISO date string |
| Failure Type | select | Missing Digest, Partial Run, Failed Run, Stale Snapshot |
| Linked Task | relation | → Tasks database |
| Notes | rich_text | Signal line or error context |
| Resolution Status | select | Open, Resolved, Suppressed |
| Resolution Notes | rich_text | What fixed it |
| Resolved Date | date | Auto-set when Resolution Status → Resolved (automation) |

### Existing `log-dead-letter` Worker (reference pattern)

This is the existing worker that **creates** Dead Letter records. Your new worker will **resolve** them. Follow the same patterns:

```typescript
// src/workers/log-dead-letter.ts
import type { Client } from "@notionhq/client";
import { getDeadLettersDatabaseId } from "../shared/notion-client.js";
import type { LogDeadLetterInput, LogDeadLetterOutput } from "../shared/types.js";

export async function executeLogDeadLetter(
  input: LogDeadLetterInput,
  notion: Client
): Promise<LogDeadLetterOutput> {
  // 1. Validate all inputs upfront
  // 2. Get DB ID from env
  // 3. Build properties object
  // 4. notion.pages.create(...)
  // 5. Return { success: true, record_id, record_url }
  // catch → { success: false, error: message }
}
```

---

## Worker 1: `resolve-stale-dead-letters`

### Purpose

When an agent runs successfully, this tool checks the Dead Letters database for any prior Open records for that same agent where the failure was transient (Stale Snapshot or Missing Digest) and the Expected Run Date is older than the current successful run. It auto-resolves matching records.

This reduces dead letter noise and prevents stale failures from accumulating indefinitely.

### When agents should call it

After a successful run, an agent (or the Fleet Ops Agent during its daily sweep) calls this tool with the agent name and the date of the successful run. The tool handles the rest.

### Input Schema

```typescript
export interface ResolveStaleDeadLettersInput {
  /** The agent whose dead letters to resolve. Must be a valid agent name. */
  agent_name: string;
  /** ISO date (YYYY-MM-DD) of the successful run that supersedes old failures. */
  successful_run_date: string;
  /** Failure types eligible for auto-resolution. Defaults to ["Stale Snapshot", "Missing Digest"]. */
  resolvable_failure_types?: string[];
  /** If true, find and report but don't actually resolve. */
  dry_run?: boolean;
}
```

### Output Schema

```typescript
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
```

### Implementation Logic

1. **Validate inputs:**
   - `agent_name` must be non-empty (optionally validate against `VALID_AGENT_NAMES` from agent-config — but allow names not in the list since Dead Letters can have names like "Fleet Monitor" or "Dead Letter Logger" that aren't in `AGENT_DIGEST_PATTERNS`).
   - `successful_run_date` must be a valid ISO date string.
   - `resolvable_failure_types` defaults to `["Stale Snapshot", "Missing Digest"]` if not provided. Each value must be one of the four valid failure types.

2. **Query Dead Letters database:**
   - Use `notion.databases.query()` on `DEAD_LETTERS_DATABASE_ID`.
   - Filter: `Agent Name` equals `agent_name` AND `Resolution Status` equals `Open` AND `Failure Type` is in `resolvable_failure_types` AND `Expected Run Date` is on or before `successful_run_date`.
   - Use a compound filter with `and`.

3. **For each matching record:**
   - If `dry_run`, add to results with `resolved: false` and skip the update.
   - Otherwise, update the page via `notion.pages.update()`:
     - Set `Resolution Status` to `Resolved`.
     - Set `Resolution Notes` to `Auto-resolved: successful run on {successful_run_date} superseded this failure.`
     - Set `Resolved Date` to today's date (ISO, America/Chicago).
   - Track successes and errors separately.

4. **Return structured output** with summary line like: `"Resolved 3 of 5 open dead letters for GitHub Insyncerator (2 skipped: non-resolvable failure types)."`

### Entry point registration (in `src/index.ts`)

```typescript
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
```

### Notion API filter structure (reference)

```typescript
const filter = {
  and: [
    { property: "Agent Name", select: { equals: input.agent_name } },
    { property: "Resolution Status", select: { equals: "Open" } },
    {
      or: resolvableTypes.map((ft) => ({
        property: "Failure Type",
        select: { equals: ft },
      })),
    },
    {
      property: "Expected Run Date",
      date: { on_or_before: input.successful_run_date },
    },
  ],
};
```

### Notion API update structure (reference)

```typescript
await notion.pages.update({
  page_id: record.id,
  properties: {
    "Resolution Status": { select: { name: "Resolved" } },
    "Resolution Notes": {
      rich_text: [{ text: { content: `Auto-resolved: successful run on ${input.successful_run_date} superseded this failure.` } }],
    },
    "Resolved Date": { date: { start: todayChicago } },
  },
});
```

### Test cases to write

1. **Happy path:** 3 open Stale Snapshots for agent, all with Expected Run Date before successful_run_date → all resolved.
2. **Mixed types:** 2 Stale Snapshot + 1 Failed Run open → only 2 resolved (Failed Run skipped by default filter).
3. **Dry run:** Records found but not modified, `resolved: false` in output.
4. **No matching records:** Returns `total_open_found: 0`, empty records array, success.
5. **Invalid agent name:** Returns `{ success: false, error }`.
6. **Invalid date:** Returns `{ success: false, error }`.
7. **Custom resolvable types:** Pass `["Stale Snapshot", "Missing Digest", "Partial Run"]` → includes Partial Run in resolution scope.

---

## Worker 2: `validate-database-references`

### Purpose

Verifies that a list of Notion database IDs are accessible via the Notion API. Catches broken references (deleted databases, revoked permissions, moved databases) **before** they cascade into agent failures.

This directly addresses the `d125ed60-c250-48e2-a3ff-724cd952f5be` failure that is currently blocking two agents (Personal Ops Manager and Home & Life Task Watcher).

### When agents should call it

- **Fleet Ops Agent** calls this weekly as a pre-flight health check.
- **Any agent** can call it at the start of a run to validate its own database dependencies before proceeding.
- Can also be invoked manually via `ntn workers invoke validate-database-references --input '{...}'`.

### Input Schema

```typescript
export interface DatabaseReference {
  /** Notion database ID (UUID, with or without dashes). */
  database_id: string;
  /** Human-readable label for this reference (e.g., "Home Tasks DB", "Personal Projects DB"). */
  label: string;
  /** Which agent(s) depend on this database. Informational, used in output. */
  used_by?: string[];
}

export interface ValidateDatabaseReferencesInput {
  /** List of database references to check. */
  references: DatabaseReference[];
  /** If true, also verify that each database has at least one accessible property. */
  check_schema?: boolean;
  /** If true, log a Dead Letter for each broken reference. */
  log_dead_letters?: boolean;
}
```

### Output Schema

```typescript
export interface DatabaseCheckResult {
  database_id: string;
  label: string;
  used_by: string[];
  accessible: boolean;
  /** HTTP-like status: 200 = ok, 404 = not found, 403 = forbidden, 500 = API error */
  status_code: number;
  /** If check_schema is true and DB is accessible, the number of properties found. */
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
```

### Implementation Logic

1. **Validate inputs:**
   - `references` must be a non-empty array.
   - Each entry must have a non-empty `database_id` and `label`.
   - Normalize `database_id` (strip dashes if present, then re-format to UUID with dashes for API calls).

2. **For each reference, attempt `notion.databases.retrieve()`:**
   - **Success (200):** Mark `accessible: true`, `status_code: 200`.
     - If `check_schema` is true, count the number of properties in the response and set `property_count`.
   - **APIResponseError with code `object_not_found`:** Mark `accessible: false`, `status_code: 404`, `error: "Database not found"`.
   - **APIResponseError with code `unauthorized`:** Mark `accessible: false`, `status_code: 403`, `error: "Access denied — integration lacks permission"`.
   - **Any other error:** Mark `accessible: false`, `status_code: 500`, `error: err.message`.

3. **If `log_dead_letters` is true and there are broken references:**
   - For each broken reference, call the existing `executeLogDeadLetter()` function (import it from `src/workers/log-dead-letter.ts`) with:
     - `agent_name`: First entry in `used_by` array, or `"System"` if empty.
     - `expected_run_date`: Today's date (Chicago).
     - `failure_type`: `"Failed Run"`
     - `detected_by`: `"Dead Letter Logger"`
     - `notes`: `"Broken database reference: {label} ({database_id}) — {error}"`
   - Track how many dead letters were successfully logged.

4. **Return structured output** with:
   - Full results array.
   - Filtered `broken_references` array for quick access.
   - Summary like: `"Checked 8 database references: 7 accessible, 1 broken (Home Tasks DB — 404 Not Found)."`

### Entry point registration (in `src/index.ts`)

```typescript
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
```

### Notion API call pattern (reference)

```typescript
try {
  const db = await notion.databases.retrieve({ database_id: normalizedId });
  // db.properties is a Record<string, PropertyConfigObject>
  const propertyCount = Object.keys(db.properties).length;
  return { accessible: true, status_code: 200, property_count: checkSchema ? propertyCount : null, error: null };
} catch (e) {
  if (e instanceof APIResponseError) {
    if (e.code === "object_not_found") {
      return { accessible: false, status_code: 404, property_count: null, error: "Database not found" };
    }
    if (e.code === "unauthorized") {
      return { accessible: false, status_code: 403, property_count: null, error: "Access denied" };
    }
  }
  return { accessible: false, status_code: 500, property_count: null, error: e.message };
}
```

**Important:** Import `APIResponseError` from `@notionhq/client`:
```typescript
import { Client, APIResponseError } from "@notionhq/client";
```

### Test cases to write

1. **All accessible:** 3 valid database IDs → all `accessible: true`, `total_broken: 0`.
2. **One broken:** 2 valid + 1 invalid ID → `total_broken: 1`, `broken_references` has 1 entry.
3. **Permission denied:** Mock a 403 response → `status_code: 403`, `error` mentions access denied.
4. **With schema check:** `check_schema: true` → `property_count` populated for accessible DBs.
5. **With dead letter logging:** `log_dead_letters: true` + broken ref → dead letter created, `dead_letters_logged: 1`.
6. **Empty references array:** Returns `{ success: false, error: "references array is required and must not be empty" }`.
7. **Missing database_id:** Returns `{ success: false, error }` for validation.

---

## Files to Create / Modify

### New files

| File | Purpose |
|---|---|
| `src/workers/resolve-stale-dead-letters.ts` | Worker implementation |
| `src/workers/validate-database-references.ts` | Worker implementation |
| `tests/resolve-stale-dead-letters.test.ts` | Unit tests |
| `tests/validate-database-references.test.ts` | Unit tests |

### Files to modify

| File | Change |
|---|---|
| `src/shared/types.ts` | Add `ResolveStaleDeadLettersInput`, `ResolveStaleDeadLettersOutput`, `ResolvedDeadLetter`, `ValidateDatabaseReferencesInput`, `ValidateDatabaseReferencesOutput`, `DatabaseReference`, `DatabaseCheckResult` |
| `src/index.ts` | Import new execute functions, register two new `worker.tool()` entries |
| `src/shared/notion-client.ts` | No changes needed — `getDeadLettersDatabaseId()` already exists |

### No new environment variables needed

Both workers use existing env vars (`DEAD_LETTERS_DATABASE_ID`, `NTN_API_TOKEN`). No new secrets required.

---

## Deployment Checklist

After implementing:

1. `npm run build` — exits zero
2. `bun test` — all tests pass (existing + new)
3. `ntn workers deploy` — deploys successfully
4. `ntn workers list` — confirms both new tools appear
5. Smoke test: `ntn workers invoke resolve-stale-dead-letters --input '{"agent_name":"GitHub Insyncerator","successful_run_date":"2026-03-09","dry_run":true}'`
6. Smoke test: `ntn workers invoke validate-database-references --input '{"references":[{"database_id":"d125ed60-c250-48e2-a3ff-724cd952f5be","label":"Home Tasks DB","used_by":["Personal Ops Manager","Home & Life Watcher"]}]}'`
7. Update WORKERS.md table with new tool entries
8. Update Custom Agents Hub → Worker tools reference table in Notion
