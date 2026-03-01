# jre-notion-workers

Notion Workers for the 11-agent custom agent system. Three tools enforce governance, reduce agent overhead, and make machine-to-machine coordination reliable across the automation fleet.

## What these Workers do

- **write-agent-digest** — Accepts structured agent output and creates a schema-compliant digest page in the Docs or Home Docs database. Handles status lines, section ordering, ERROR-title naming, and heartbeat formatting so agents don’t have to remember the rules.

- **check-upstream-status** — Finds the most recent digest for a given agent, parses the machine-readable status line and run timestamp, and returns a structured result. Use at the start of any run that depends on upstream data.

- **create-handoff-marker** — Creates a handoff record when one agent escalates to another. Returns a pre-formatted Escalations block and optionally creates a Notion Task. Enforces a circuit breaker (no duplicate handoff within 7 days) and re-escalation cap (max 2 in same direction within 7 days).

## Setup

### Prerequisites

- **Node.js** ≥ 22 (deploy target)
- **Bun** ≥ 1.1 (local dev; optional but recommended)
- **ntn** CLI for deployment ([makenotion/workers-template](https://github.com/makenotion/workers-template))

### Install

```bash
bun install
# or
npm install
```

### Credentials

**Option A — 1Password (maintainers)**  
Run once to generate `.env` from the "Notion Workers" 1Password item:

```bash
bash scripts/load-secrets.sh
```

**Option A1 — 1Password + Cursor (Cursor Hooks)**  
This project is set up for [1Password Cursor Hooks](https://developer.1password.com/docs/cursor-hooks/): before the Cursor Agent runs any shell command, a hook checks that required `.env` files from [1Password Environments](https://developer.1password.com/docs/environments) are mounted and valid. No plaintext secrets on disk.

1. **Requirements:** [1Password](https://1password.com) (Mac or Linux), [Cursor](https://cursor.com), `sqlite3` in PATH.
2. **In 1Password:** Create an Environment (e.g. "Notion Workers") and add a **Mount .env file** destination pointing at this project’s `.env.local` (or `.env`). Put `NOTION_TOKEN`, `DOCS_DATABASE_ID`, `HOME_DOCS_DATABASE_ID`, `TASKS_DATABASE_ID` in that Environment. See [Locally mounted .env files](https://developer.1password.com/docs/environments/local-env-file).
3. **This repo already includes:** `.cursor/hooks.json` (runs the 1Password validation script before shell execution) and `.cursor/hooks/1password/validate-mounted-env-files.sh` from [1Password/cursor-hooks](https://github.com/1Password/cursor-hooks). The file `.1password/environments.toml` lists which paths to validate: `.env.local` and `.env`.
4. **Enable the mount** in the 1Password app (Destinations → your local .env file → Enabled). Restart Cursor. When the Agent runs a command, the hook will allow it only if the mounted `.env` is present and valid.

Logs: `/tmp/1password-cursor-hooks.log`. Debug: `DEBUG=1` when running.

**If the hook keeps blocking:** Open Cursor with **this project folder** as the workspace root (File → Open Folder → `jre-notion-workers`), not a parent folder. The hook resolves `.env.local` relative to the workspace root Cursor sends. To see why it denied, open the log file (File → Open File → `/tmp/1password-cursor-hooks.log`) and check the latest entries for "Required local .env file is missing or invalid" or "not found in 1Password database"; the path shown must match the mount path you set in 1Password exactly.

**Option A2 — 1Password CLI (`op run`)**  
For terminal use without Cursor: use `.env.1p` (secret references) and run `bun run dev:1p`, `bun run test:connection:1p`, etc. See [Load secrets into the environment](https://developer.1password.com/docs/cli/secrets-environment-variables).

**Option B — Manual**  
Copy the example file and fill in values:

```bash
cp .env.example .env
# Edit .env with NOTION_TOKEN, DOCS_DATABASE_ID, HOME_DOCS_DATABASE_ID, TASKS_DATABASE_ID
```

**Using `.env.local`**  
If you keep credentials in `.env.local` (e.g. exported from 1Password), that file is gitignored. Run with:

```bash
bun run dev:local
```

That loads `.env.local` instead of `.env`. For one-off scripts or tests: `bun run --env-file=.env.local ...`

Required variables:

| Variable | Purpose |
|----------|---------|
| `NOTION_TOKEN` | Notion integration token |
| `DOCS_DATABASE_ID` | Docs database ID |
| `HOME_DOCS_DATABASE_ID` | Home Docs database ID |
| `TASKS_DATABASE_ID` | Tasks database ID (for handoff tasks) |

For integration tests, also set `TEST_NOTION_TOKEN` and `TEST_DOCS_DATABASE_ID` (use a dedicated test DB, not production).

**Deployed workers**  
Set secrets via the ntn CLI:

```bash
ntn workers secrets set NOTION_TOKEN=...
ntn workers secrets set DOCS_DATABASE_ID=...
ntn workers secrets set HOME_DOCS_DATABASE_ID=...
ntn workers secrets set TASKS_DATABASE_ID=...
```

Never commit `.env` or `.env.local`; they are in `.gitignore`. Safe to commit: `.env.example`, `scripts/load-secrets.sh`, `.env.1p`, `.cursor/hooks.json`, `.cursor/hooks/1password/`, and `.1password/environments.toml`.

## How agents use them

1. At run start, call **check-upstream-status** for any upstream agents you depend on. Use `data_completeness_notice` and `degraded` in your digest when upstream is stale or failed.
2. During the run, call **create-handoff-marker** when escalating to another agent (with or without creating a Task).
3. At run end, call **write-agent-digest** with your structured output; it creates the page with the correct schema, status line, and sections.

## Agent name → digest title pattern

| Agent | Digest title pattern | Target DB |
|-------|----------------------|-----------|
| Inbox Manager | Email Triage | docs |
| Personal Ops Manager | Personal Triage | home_docs |
| GitHub Insyncerator | GitHub Sync | docs |
| Client Repo Auditor | Client Repo Audit | docs |
| Docs Librarian | Docs Quick Scan, Docs Cleanup Report | docs |
| VEP Weekly Reporter | VEP Weekly Activity Report | docs |
| Home & Life Watcher | Home & Life Weekly Digest | home_docs |
| Template Freshness Watcher | Setup Template Freshness Report | docs |
| Time Log Auditor | Time Log Audit | docs |
| Client Health Scorecard | Client Health Scorecard | docs |
| Morning Briefing | Morning Briefing | docs |

## Governance rules enforced by code

- **Status lines** — Sync / Snapshot / Report status and emoji (✅ / ⚠️ / ❌) are derived from input; agents don’t format them.
- **Page titles** — Normal runs: `{emoji} {Digest Type} — {date}`. Degraded: `{Digest Type} ERROR — {date}` (no emoji).
- **Heartbeat** — “Heartbeat: no actionable items” is added when appropriate so Morning Briefing can tell healthy silence from failure.
- **Flagged items** — Every flagged item must have `task_link` or `no_task_reason`; the worker rejects invalid input.
- **Actions Taken** — Always rendered (Created Tasks / Updated Tasks / No Tasks Created).
- **Handoff circuit breaker** — No duplicate handoff task for the same source→target within 7 days.
- **Escalation cap** — At most 2 escalations in the same direction within 7 days; then `needs_manual_review` is set.

## Local development

```bash
bun run src/index.ts
# or
bun run dev
# With 1Password (no .env on disk): bun run dev:1p
```

Run tests:

```bash
bun test
bun test --watch
bun test tests/integration/   # needs TEST_* env vars
bun test --coverage
# With 1Password: bun run test:1p
```

Quick connection check (Notion token + DB IDs):

```bash
bun run test:connection       # uses .env.local or .env
bun run test:connection:1p    # uses 1Password via .env.1p
```

Typecheck:

```bash
npm run check
```

## Deploy

```bash
npm run build && ntn workers deploy
```

## Governance docs

In-repo references (templates adapted from Notion):

| Doc | Purpose |
|-----|---------|
| [WORKERS.md](WORKERS.md) | Notion Workers platform, entry contract, auth, design rules |
| [AGENTS.md](AGENTS.md) | JS/TS base, project structure, Notion SDK patterns, scope |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Layers, data flow, worker responsibilities, idempotency |
| [GUARDRAILS.md](GUARDRAILS.md) | Boundary rules: no hardcoded secrets, validation, error handling |
| [TESTING.md](TESTING.md) | Test stack, unit/integration/schema/evals, CI checklist |

## Alpha status

`@notionhq/workers` is in **alpha**. APIs and deployment behavior may change. See [makenotion/workers-template](https://github.com/makenotion/workers-template) for the latest.

## Repository layout

```
src/
├── index.ts              # Worker registration (write-agent-digest, check-upstream-status, create-handoff-marker)
├── shared/
│   ├── types.ts
│   ├── agent-config.ts
│   ├── status-parser.ts
│   ├── date-utils.ts
│   ├── notion-client.ts
│   └── block-builder.ts
└── workers/
    ├── write-agent-digest.ts
    ├── check-upstream-status.ts
    └── create-handoff-marker.ts
.examples/                 # Example payloads (documentation only)
tests/
├── unit/
├── integration/          # Guarded by TEST_DOCS_DATABASE_ID
├── evals/
└── fixtures/
```
