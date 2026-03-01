# ARCHITECTURE.md — jre-notion-workers

System design, module boundaries, and data flow for this Notion Workers repo.

## Core design principles

1. **Single responsibility** — one worker (tool) does one thing
2. **Pure logic at the core** — parsing, formatting, and validation are I/O-free and unit-testable
3. **Thin I/O shell** — Notion API calls are in worker `execute` functions or shared helpers that take a client
4. **Typed contracts** — every worker has explicit `*Input` and `*Output` types in `src/shared/types.ts`
5. **Fail fast** — validate all inputs at the start of `execute`; return `{ success: false, error }` instead of throwing

## Layered structure

```
┌─────────────────────────────────────────┐
│  Entry (src/index.ts)                    │
│  Registers tools with Worker, schemas,   │
│  and execute → worker.execute(input, ctx)│
└─────────────────────────────────────────┘
                    │
┌─────────────────────────────────────────┐
│  Workers (src/workers/*.ts)             │
│  Validate input, call shared logic,     │
│  call Notion via passed client, return  │
└─────────────────────────────────────────┘
                    │
┌─────────────────────────────────────────┐
│  Shared (src/shared/*.ts)               │
│  Pure: status-parser, date-utils,        │
│  agent-config, block-builder.            │
│  I/O: notion-client (env + Client)      │
└─────────────────────────────────────────┘
                    │
┌─────────────────────────────────────────┐
│  Types (src/shared/types.ts)            │
│  Input/output interfaces, no logic      │
└─────────────────────────────────────────┘
```

## Data flow

1. **Input** — Caller sends JSON matching the tool schema (e.g. `agent_name`, `status_type`, …).
2. **Validation** — Worker checks required fields and allowed values (e.g. `VALID_AGENT_NAMES`) and returns an error object if invalid.
3. **Notion read** — Where needed (e.g. check-upstream-status, create-handoff-marker), worker queries databases or blocks via the Notion client.
4. **Pure logic** — Shared modules parse status lines, build titles, build blocks, compute dates (no I/O).
5. **Notion write** — Worker creates or updates pages/blocks (write-agent-digest, create-handoff-marker).
6. **Output** — Worker returns a typed object (e.g. `{ success, page_id?, page_url?, error? }`).

Data flows one way: input → validate → read (if needed) → transform (shared) → write (if needed) → output.

## Worker responsibilities

| Worker                  | Reads from Notion      | Writes to Notion        | Shared modules used                    |
|-------------------------|------------------------|-------------------------|----------------------------------------|
| write-agent-digest      | —                      | Docs or Home Docs       | agent-config, status-parser, date-utils, block-builder |
| check-upstream-status   | Docs, Home Docs        | —                       | agent-config, status-parser, date-utils |
| create-handoff-marker  | Docs (optional)        | Tasks (optional), none  | agent-config, date-utils               |

## Idempotency and guards

- **write-agent-digest:** Creates one page per call; idempotency is the caller’s responsibility (e.g. one digest per agent per run).
- **check-upstream-status:** Read-only; idempotent.
- **create-handoff-marker:** Circuit breaker and re-escalation cap (same source→target within 7 days, max 2 in same direction) enforce idempotent behavior and prevent duplicate handoffs.

## Error handling

- **Validation errors** — Return `{ success: false, error: "descriptive message" }`.
- **Notion API errors** — Catch in try/catch; return `{ success: false, error: err.message }` (or similar). Do not throw.
- No silent failures; every failure path returns a structured error to the caller.

## Dependencies

- **@notionhq/client** — Notion API
- **@notionhq/workers** — Worker runtime and registration (`Worker`, `.tool()`)
- **date-fns** — Date formatting and parsing (e.g. Chicago time, age checks)

All config (tokens, database IDs) comes from `process.env` via `src/shared/notion-client.ts`.
