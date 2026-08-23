# AGENTS.md — JavaScript / TypeScript base (jre-notion-workers)

**Version:** 1.1.0 | **Last Updated:** 2026-08-22

Canonical repo-level agent config (enforcement, Notion References, tool permissions) is `/AGENTS.md` at the git root. This file is the package-level overlay for Cursor Cloud and in-package commands.

Base standards and conventions for this Notion Workers project and the 11-agent system it supports.

## Runtime & toolchain

- **Node.js** ≥ 22 (production / `ntn workers deploy` target)
- **Bun** ≥ 1.1 (local dev — native TS, no tsc step)
- **TypeScript** ≥ 5.4 (strict mode required)
- Package manager: npm (lockfile committed) or `bun install`

**Key rule:** Use Bun for local development (`bun run`, `bun test`). Deploy through the `ntn` CLI which targets Node 22. Never use Bun-specific APIs (`Bun.file()`, `Bun.serve()`, etc.) in source files — they won't exist at runtime.

## Project structure

```
jre-notion-workers/
├── src/
│   ├── index.ts              # Worker registration (Worker + .tool())
│   ├── shared/               # Types, notion client, parsers, utils
│   │   ├── types.ts
│   │   ├── notion-client.ts
│   │   ├── agent-config.ts
│   │   ├── status-parser.ts
│   │   ├── date-utils.ts
│   │   └── block-builder.ts
│   └── workers/
│       ├── write-agent-digest.ts
│       ├── check-upstream-status.ts
│       └── create-handoff-marker.ts
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── evals/
│   └── fixtures/
├── .examples/                # Example payloads (documentation)
├── package.json
├── tsconfig.json
└── README.md
```

## Module system

This project uses ESM:

- `"type": "module"` in package.json
- Use `.js` extensions in import paths when importing from `.ts` files (NodeNext):

```typescript
// ✅ correct
import { getNotionClient } from "../shared/notion-client.js";

// ❌ wrong
import { getNotionClient } from "../shared/notion-client";
```

## Notion SDK patterns

### Client initialization

Always use the shared client (reads from env):

```typescript
import { getNotionClient, getDocsDatabaseId } from "../shared/notion-client.js";
const notion = getNotionClient();
const dbId = getDocsDatabaseId();
```

### Error handling

Wrap Notion API calls in try/catch. Return `{ success: false, error: err.message }` (or equivalent) — do not throw to the caller.

## Code standards

### Naming

- Files: `kebab-case.ts`
- Functions/variables: `camelCase`
- Types/interfaces: `PascalCase`
- Constants: `SCREAMING_SNAKE_CASE`
- Notion IDs: 32-char hex, no dashes in env (e.g. `DOCS_DATABASE_ID`)

### Type safety

- `strict: true` — no exceptions
- No `any` — use `unknown` then narrow
- No non-null assertions (`!`) on API responses
- All async functions should have explicit return types where practical

### Pure logic separation

Business logic (parsing status lines, building titles, validating flagged items) lives in `src/shared/` and is unit-tested. Workers in `src/workers/` orchestrate: validate input, call shared logic, call Notion, return structured result.

## Environment & secrets

- `NOTION_TOKEN` — integration token (never log)
- `DOCS_DATABASE_ID`, `HOME_DOCS_DATABASE_ID`, `TASKS_DATABASE_ID` — document all in README and `.env.example`

Never log or expose `NOTION_TOKEN`. For deployment, secrets are set via `ntn workers secrets set` and available as `process.env`.

## Scope (this repo)

- **Reads from:** Docs database, Home Docs database (for digest lookup and write targets)
- **Writes to:** Docs database, Home Docs database (digest pages), Tasks database (handoff tasks)
- **External calls:** Notion API only (no other HTTP)
- **Does NOT modify:** Pages or databases outside the declared IDs in env

No worker may read or write outside its declared scope without an explicit governance review.

## Cursor Cloud specific instructions

This project lives in the `jre-notion-workers/` subdirectory (it is not the repo root). Run all dev commands from there.

- **Runtime:** Bun is the primary local dev runtime and is provided on `PATH` (symlinked at `/usr/local/bin/bun`). Node ≥ 22 is also available. The startup update script runs `bun install` in `jre-notion-workers/`. Do **not** use `bun install --frozen-lockfile`: the committed `bun.lock` can be out of sync with `package.json` (e.g. `tsx`, `@notionhq/workers` pin), which makes frozen installs fail; plain `bun install` reconciles it.
- **Standard commands** (see `package.json` / `README.md` / `TESTING.md`): typecheck/lint `bun run check` (`tsc --noEmit`); tests `bun test`; dev `bun run dev`.
- **Running "the app":** this is a Notion Workers SDK package, not a local HTTP server. `bun run dev` (`bun run src/index.ts`) just imports the module, registers all tool capabilities, and exits 0 — that is the expected healthy behavior. Do not wait for a listening port. Deployment to Notion is via the `ntn` CLI (`ntn workers deploy`), which is a production step, not needed for local dev.
- **Smoke-testing a tool without secrets:** import the default `worker` export and call `await worker.run("<tool-key>", input, { concreteOutput: true })`. Pure-logic tools (`calculate-credit-forecast`, `redact-client-document`) need no Notion credentials and are the quickest end-to-end check.
- **Secrets:** Notion-backed tools read `NTN_API_TOKEN` (note: the code uses `NTN_API_TOKEN`, not `NOTION_TOKEN`) plus the various `*_DATABASE_ID` vars; without them those tools throw `"... is not set"`. Provide them via `.env.local` (`bun run dev:local` / `--env-file=.env.local`) or as environment secrets. Integration tests under `tests/integration/` are auto-skipped unless `TEST_DOCS_DATABASE_ID` (and `TEST_NOTION_TOKEN`) are set — point them at a dedicated test DB, never production.
- **Known pre-existing test failures:** on this branch, 2 unit tests fail independent of the environment — `agent-config > AGENT_TARGET_DB maps home_docs ...` and `write-agent-digest output schema > ... home_docs target` — because `AGENT_TARGET_DB` in `src/shared/agent-config.ts` has no `"Home & Life Watcher"` entry that the tests expect. This is application-logic drift, not a setup problem.
- **1Password hook:** `.cursor/hooks.json` / `.cursor/hooks/1password/` is a Cursor Desktop feature that validates locally mounted `.env` files before shell commands. It does not run in / block the Cloud Agent shell.
