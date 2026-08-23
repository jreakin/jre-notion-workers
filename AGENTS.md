# AGENTS.md — jre-notion-workers

**Version:** 1.0.0 | **Last Updated:** 2026-08-22 | **Project Type:** worker (TypeScript / Notion Workers)

Canonical agent config for this git repository. The runnable package lives in `jre-notion-workers/`. Package-level Cursor Cloud notes remain in `jre-notion-workers/AGENTS.md`.

This document is a companion to `docs/ARCHITECTURE.md`, `docs/TESTING.md`, `docs/GUARDRAILS.md`, `docs/GITBUTLER.md`, and `AGENT-DOCS-VERSIONING.md`.

## Runtime & toolchain

- **Node.js** ≥ 22 (production / `ntn workers deploy` target)
- **Bun** ≥ 1.1 (local dev — native TS, no tsc step). Pin upgrades in PRs; do not auto-bump.
- **TypeScript** ≥ 5.4, `strict` + `noUncheckedIndexedAccess`
- Package manager: Bun locally (`bun.lock` present). Root `package.json` is a wrapper that prefixes into `jre-notion-workers/`.

**Key rule:** Use Bun for local development (`bun run`, `bun test`). Deploy through the `ntn` CLI targeting Node 22. Never use Bun-specific APIs (`Bun.file()`, `Bun.serve()`, `bun:sqlite`) in source — they will not exist at runtime.

Commands (from repo root or `jre-notion-workers/`):

```bash
cd jre-notion-workers
bun install
bun run check          # tsc --noEmit
bun test               # unit + evals; integration skipped without TEST_*
bun test tests/unit
bun test --coverage
bun run dev            # registers tools and exits 0 (not an HTTP server)
```

## Project structure

```
jre-notion-workers/                 # git root (this file lives here)
├── jre-notion-workers/             # app package
│   ├── src/index.ts                # Worker + .tool() registration
│   ├── src/shared/                 # types, notion client, parsers, utils
│   ├── src/workers/                # one file per tool
│   ├── tests/{unit,integration,evals,fixtures}/
│   ├── package.json                # "type": "module"
│   └── workers.json
├── packages/workers/               # recovered generation — do not delete (ADR-0005)
├── .claude/{hooks,agents,scripts}/
├── docs/{ARCHITECTURE,TESTING,GUARDRAILS,adr}/
└── .github/workflows/
```

Pure logic lives in `src/shared/` (I/O-free except `notion-client.ts`). Workers in `src/workers/` orchestrate: validate, call shared logic, call Notion, return a structured result.

## Module system

ESM only. `"type": "module"`. Use `.js` extensions in TypeScript import paths (NodeNext):

```typescript
import { getNotionClient } from "../shared/notion-client.js";
```

## Documentation Priority

1. **Context7** — call `resolve-library-id` then `query-docs` / `get-library-docs` before citing a library API. Never guess `@notionhq/workers`, `ntn`, or Bun APIs from memory.
2. This `AGENTS.md` and `docs/GUARDRAILS.md`
3. Live Notion playbooks listed in DEV-ENV-INDEX
4. Package README and `WORKERS.md` in the app directory

## Tool Resolution Priority

Use purpose-built MCP tools before shell workarounds: Notion MCP for workspace pages, GitButler `but` for writes, `ntn` for worker deploy, Context7 for library docs. Do not scrape docs sites when Context7 has the library.

## Goal Proposal Protocol

Agents propose a `/goal`; the human activates it. `/goal` is not a tool call. Do not start multi-step implementation until `TASK.md` states files in scope, behavior to preserve, checks to run, and done evidence.

## HANDOFF.md session protocol

Write `HANDOFF.md` before ending a session that leaves in-flight work. Snapshot `.claude/handoffs/` is gitignored. Include: In-Flight, Next Session, Decisions Made, Open Questions.

## Agent Scope Declaration

- **Reads from:** Docs, Home Docs, Tasks, Dead Letters, GitHub Items, Agent Ops, Clients, and other IDs declared in `.env.example` — only via `process.env`
- **Writes to:** the databases each worker declares; never a database not in that worker's contract
- **External calls:** Notion API; GitHub API only from `sync-github-items` / hours estimators
- **Does NOT:** delete production data, share tokens across agents, or use production IDs in tests

## Model Configuration

Default to the orchestrator model for implementation. Review/research subagents stay read-only. Do not change model pins in CI or deploy workflows without human approval.

## Notion SDK patterns

Use the shared client (`NTN_API_TOKEN` in code — not `NOTION_TOKEN`). Wrap Notion calls in try/catch and return `{ success: false, error }` rather than throwing. Paginate; never assume one page of results. Register tools with `worker.tool(key, { title, description, schema, outputSchema, execute })` per current `@notionhq/workers` docs.

## Code standards

- Files: `kebab-case.ts` · functions: `camelCase` · types: `PascalCase`
- No `any` — use `unknown` then narrow. No non-null assertions on API responses.
- Async functions should have explicit return types.
- Minimize `as` assertions; if unavoidable, add `// SAFETY: reason`.

## Environment & secrets

Required names are in `jre-notion-workers/.env.example`. Local maintainers use 1Password Environment mount (`.env.local` / `.env`) and `op run --env-file=.env.1p`. Never log tokens. Never commit `.env` / `.env.local`. Declare intent with `python3 .claude/hooks/gate.py 1p-declare` before editing live env files.

## GitButler

This is a GitButler workspace (`gitbutler/workspace`). Use `but` for all writes: `but commit -b <branch> -m "..."`, `but push <branch>`, `but pr new`, `but pull`. Conventional Commits. See `docs/GITBUTLER.md`. Raw `git commit` / `git push` / `git checkout` are blocked by `block-raw-git.sh`.

## 1Password

Stay on the current mix: local Environment mount (`.env.local` / `.env`, Cursor hook validates mount paths) plus `op run --env-file=.env.1p` for scripts and deploy. This is not the Environments SDK (`op.read()`), so `block-op-read.sh` is not installed.

### Writing to 1Password-managed environment files

Before editing `.env`, `.env.local`, or `.env.1p`:

```bash
python3 .claude/hooks/gate.py 1p-declare --file .env.local --action 'edit KEY' --reason 'why'
# then write
python3 .claude/hooks/gate.py 1p-clear
```

`GOAL_MODE=1` is a session variable for goal-driven retrofits — set it in the shell, never in `.env.example`.

SDD review order when using `implementer` / `spec-reviewer`: spec-reviewer → code-reviewer. Never skip spec-reviewer.

## Tool Permissions by Mode

If no mode is declared in `TASK.md`, default to `dev`.

### dev mode
Reads: `jre-notion-workers/src/`, `tests/`, `docs/`, `.env.example`, this file  
Writes: `jre-notion-workers/src/`, `tests/`, `docs/`  
Executes: bun, tsc, ntn (non-prod), gh (read + PR), `but` on feature branches

### review mode
Reads: same. Writes: NONE. Executes: git/but diff, `bun run check`, `bun test` (analysis only).

### research mode
Reads: all project files + Context7/WebFetch. Writes: `docs/research/`, `HANDOFF.md` only. Executes: grep/glob/git log only.

## Conflict Resolution Hierarchy

1. Security → 2. Correctness → 3. Data integrity → 4. Performance (measured) → 5. Maintainability → 6. Style

## Anti-Pattern Warnings

- Hallucinating `@notionhq/workers` or `ntn` APIs instead of Context7
- Using production `*_DATABASE_ID` in tests
- Adding Bun-only APIs to `src/`
- Writing Notion property values to logs (PII)
- Editing existing Alembic-style "fixup" of already-deployed worker behavior without a new tool version
- Treating `packages/workers/` or tracked `dist/` as disposable (ADR-0005)
- Installing ESLint/Prettier CI jobs this package does not run
- `git commit` instead of `but commit` in this workspace

## NEVER DO

- Hallucinate library APIs. Resolve Context7 library id first.
- Commit secrets, `.env`, or `.claude/settings.local.json`
- `rm -rf`, `git reset --hard`, `git push --force` to main
- Write outside a worker's declared database scope
- Retry Notion `unauthorized` / `restricted_resource` errors

## Definition of Done

- `bun run check` passes in `jre-notion-workers/`
- `bun test tests/unit` passes (or failures are named in TASK.md as known)
- AGENTS.md / GUARDRAILS.md still match the code (code wins — update docs)
- No new `any` without a SAFETY comment
- Conventional commit on a GitButler branch, not `main`

## Periodic Rule Reinforcement

Re-read this file after compaction, before deploy (`ntn workers deploy`), and before any worker that writes to production databases. Re-read `docs/GUARDRAILS.md` before adding a worker.

## Notion References

- Tasks DB: collection://2e97d7f5-6298-80a5-acef-000bb9796a9d
- Tasks data_source_id: 2e97d7f5-6298-80a5-acef-000bb9796a9d
- Projects data_source_id: da96d1a7-0ba0-4701-83e5-84ee1b053552
- Clients data_source_id: 2e97d7f5-6298-8064-8633-000bc6c51b86
- Project Page: https://www.notion.so/3157d7f562988057b079ef0d3c48eb46
- Client Page: https://www.notion.so/2f37d7f5629881bb814de76479af10db
