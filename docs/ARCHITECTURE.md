# ARCHITECTURE.md — jre-notion-workers

**Version:** 1.0.0 | **Last Updated:** 2026-08-22

System design, module boundaries, and data flow for the Notion Workers package in `jre-notion-workers/`. Adapted from the JS/TS architecture template; code in `jre-notion-workers/src/` is the source of truth.

## Core design principles

1. **Single responsibility** — one worker (tool) does one thing
2. **Pure logic at the core** — parsing, formatting, and validation are I/O-free and unit-testable (`src/shared/`, except `notion-client.ts`)
3. **Thin I/O shell** — Notion API calls live in worker `execute` functions or shared helpers that take a client
4. **Typed contracts** — every worker has explicit input/output types in `src/shared/types.ts`
5. **Fail fast** — validate all inputs at the start of `execute`; return `{ success: false, error }` instead of throwing

## Layered structure

```
src/index.ts          Worker + tool registration (I/O edge)
src/workers/*.ts      Orchestration per tool (~34 workers)
src/shared/*.ts       Pure helpers + notion-client (env + Client)
src/shared/types.ts   Input/output interfaces, no logic
```

This maps to the JS/TS base "pure core / I/O edge" pattern. The package uses `src/shared/` rather than `src/logic/` — do not rename in this retrofit; update templates to match.

## Application Design Patterns

| Pattern | Where |
|---|---|
| Pure core / I/O edge | `src/shared` vs `src/workers` |
| Adapter | `src/shared/notion-client.ts` |
| Circuit breaker | `create-handoff-marker` (7-day window, max 2) |
| Structured errors | `{ success: false, error }` on every failure path |

Deviations require an ADR in `docs/adr/`.

## Data flow

1. Caller sends JSON matching the tool schema
2. Worker validates required fields
3. Optional Notion read
4. Pure transform in shared modules
5. Optional Notion write
6. Typed output object

## Worker catalog

Tools are registered in `src/index.ts`. The file list under `src/workers/` is authoritative (30+ tools spanning digests, fleet monitor, dead letters, GitHub sync, client publishing, Agent Ops). Do not treat older three-worker diagrams as current.

## Idempotency

- Digest writes: one page per call; caller owns "one digest per run"
- Reads: idempotent
- Handoffs: circuit breaker + re-escalation cap

## Dependencies

- `@notionhq/client` — Notion API
- `@notionhq/workers` — `Worker`, `.tool()`
- `date-fns` — Chicago time / age checks

Config comes from `process.env` via `src/shared/notion-client.ts` (`NTN_API_TOKEN`).

## Repo-level notes

- Root `package.json` (`jre-notion-workers-repo`) only forwards scripts into the app package
- `packages/workers/` is a recovered generation (ADR-0005) — not the live deploy path
- Tracked `dist/` at repo root is the unrecovered second generation — do not `git rm` until ADR-0005 closes
