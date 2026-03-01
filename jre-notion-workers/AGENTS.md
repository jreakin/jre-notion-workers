# AGENTS.md — JavaScript / TypeScript base (jre-notion-workers)

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
