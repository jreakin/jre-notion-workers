# WORKERS.md — Notion Workers Platform

> **Status:** Notion Workers is currently in alpha. APIs and deployment behavior may change. Always check the [makenotion/workers-template](https://github.com/makenotion/workers-template) README for the latest.

## What is a Notion Worker?

A Notion Worker is a small TypeScript program hosted and executed by Notion's infrastructure. Workers:

- Run on Node.js ≥22 (Notion-controlled runtime — you do not manage the server)
- Are deployed via the `ntn` CLI
- Receive a typed JSON input and return a typed JSON output
- Have access to a pre-authenticated Notion client via `@notionhq/workers`
- Are NOT long-running servers — they execute and exit

## Project setup (jre-notion-workers)

```bash
# Install deps
bun install
# or
npm install
```

## Required package.json shape

This repo uses:

- `"type": "module"`
- `engines`: `node": ">=22"`
- Dependencies: `@notionhq/client`, `@notionhq/workers`, `date-fns`
- Scripts: `dev`, `build`, `test`, `deploy` (and `dev:local`, `dev:1p`, `test:connection`, etc.)

## Entry point contract

This project uses the **tool-based** API: `Worker` + `.tool()` in `src/index.ts`. Each tool is registered with a schema and an `execute` function. The runtime calls the execute function with the input and passes a context (including `context.notion`).

- Workers are registered in `src/index.ts`
- Each tool has a JSON schema and an `execute` implementation in `src/workers/<name>.ts`
- Input and output must be JSON-serializable (no `Date` objects, `Map`, `Set`, etc.)
- Must return within the platform timeout (check current docs — typically 30–60s)

## Workers in this repo

| Tool name               | Purpose |
|-------------------------|--------|
| `write-agent-digest`    | Creates a governance-compliant agent digest page in Docs or Home Docs |
| `check-upstream-status` | Finds latest digest for an agent and returns structured status |
| `create-handoff-marker` | Creates handoff record and optionally a Task when escalating between agents |
| `monitor-fleet-status`  | Batch-queries all agents' latest digests, returns fleet-wide status |
| `scan-briefing-failures`| Reads today's Morning Briefing, extracts failure signals for Dead Letter Logger |
| `log-dead-letter`       | Creates a Dead Letter record for a single agent failure |
| `calculate-credit-forecast` | Pure calculation: computes monthly credit burn projection with buffer and delta |
| `lint-agents-file`          | Fetches AGENTS.md from a GitHub repo and validates against CI Linter Spec |
| `read-repo-file`            | Fetches raw text content of any file from a GitHub repository |
| `check-url-status`          | Checks upstream URL reachability and optionally validates expected content |
| `sync-github-items`           | Syncs GitHub repos, issues, and PRs from configured sources into Notion GitHub Items database |
| `check-agent-staleness`     | Checks each agent's last digest against cadence-based staleness thresholds |
| `validate-digest-quality`   | Inspects a digest page for governance compliance (status lines, structure, task linking) |
| `archive-old-digests`       | Enforces retention policy by setting Status to Archived on old digest pages |
| `auto-link-meeting-client`  | Fuzzy-matches AI Meeting Notes against Clients/Contacts to set relations |
| `tag-untagged-docs`         | Infers Document Type from title patterns on untagged docs |
| `validate-project-completeness` | Scans active Projects for data completeness issues (read-only) |
| `resolve-stale-dead-letters`| Auto-resolves Open dead letters when a successful run supersedes prior failures |
| `validate-database-references` | Checks Notion database IDs are accessible; catches broken refs before cascade |
| `estimate-github-hours`        | Estimates hours for a GitHub PR or issue from diff stats, labels, and complexity signals |

## Input/output type design

Types live in `src/shared/types.ts`. Each worker has an `*Input` and `*Output` type. Output design rules:

- Include a `success` (or similar) discriminant
- Return `{ success: false, error: string }` on validation or API failure — never throw
- Never return raw Notion API objects — map to your own types

## Authentication pattern

Secrets come from `process.env`: `NTN_API_TOKEN` (not `NOTION_TOKEN` — that's a reserved prefix in the Workers SDK), `DOCS_DATABASE_ID`, `HOME_DOCS_DATABASE_ID`, `TASKS_DATABASE_ID`, `DEAD_LETTERS_DATABASE_ID`, `GITHUB_ITEMS_DATABASE_ID`, `GITHUB_TOKEN`, `AI_MEETINGS_DATABASE_ID`, `CLIENTS_DATABASE_ID`, `CONTACTS_DATABASE_ID`, `PROJECTS_DATABASE_ID`, `FOLLOW_UP_TRACKER_DATABASE_ID`, `DECISION_LOG_DATABASE_ID`, `LABEL_REGISTRY_DATABASE_ID`, `SYSTEM_CONTROL_PLANE_PAGE_ID`. Use `src/shared/notion-client.ts` (`getNotionClient()`, `getDocsDatabaseId()`, etc.) — never hardcode.

Deployment secrets:

```bash
ntn workers secrets set NTN_API_TOKEN
ntn workers secrets set DOCS_DATABASE_ID
# etc.
```

## Local development loop

```bash
bun run src/index.ts
# or
bun run dev
bun run dev:local   # with .env.local
bun run dev:1p      # with 1Password op run

bun test
npm run check       # TypeScript
```

**Never use `ts-node`** — use Bun for local execution. Do not use Bun-specific APIs in worker source (`Bun.file()`, `Bun.serve()`, etc.) so code stays Node-compatible at deploy time.

## Deployment

```bash
npm run build && ntn workers deploy
ntn workers list
ntn workers invoke <tool-name> --input '{"agent_name": "..."}'
ntn workers logs
```

**Deployment checklist:**

- [ ] `npm run build` exits with zero errors
- [ ] `bun test` passes
- [ ] All required secrets set via `ntn workers secrets set`
- [ ] README documents input schema and expected output

## Worker-specific design rules

### 1. Atomic operations only

One tool = one concern. This repo keeps `write-agent-digest`, `check-upstream-status`, and `create-handoff-marker` separate.

### 2. Idempotent by default

Same input twice should produce the same result or safely skip (e.g. create-handoff-marker circuit breaker).

### 3. No side effects on dry run

If a future worker supports `dryRun`, it must not write to Notion when `dryRun` is true.

### 4. Structured return values

Always return typed objects (e.g. `{ success, page_id?, error? }`) so callers can handle output programmatically.

### 5. Timeout-aware processing

Workers have an execution time limit. For large datasets, process in batches and return progress if needed.

## README

The repo README must document each worker: what it does, input/output schema, when agents should call it, and any gotchas or rate limits.
