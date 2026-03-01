# GUARDRAILS.md — Boundary rules and safety

What workers in this repo must never do, and how to handle errors and edge cases. These rules apply to all code in `src/` and any new workers added to the project.

## Secrets and configuration

- **Never** hardcode `NOTION_TOKEN`, database IDs, or any other secret in source.
- **Always** read credentials and config from `process.env` (via `src/shared/notion-client.ts` or equivalent).
- **Never** log `NOTION_TOKEN` or any secret value.
- **Never** commit `.env` or `.env.local`; they are gitignored. Only commit `.env.example` and scripts that reference env var names.

## Input and validation

- **Always** validate required input fields and allowed values (e.g. `agent_name` in `VALID_AGENT_NAMES`) at the start of each worker’s `execute` (or equivalent) before any Notion API calls.
- **Never** trust input shape or content without validation.
- **Never** throw on validation failure. Return a structured error: `{ success: false, error: "clear message" }` (or the agreed output shape for that worker).

## Notion API usage

- **Never** assume a single page of results; use pagination where the API supports it.
- **Always** wrap Notion API calls in try/catch. On failure, return a structured error to the caller; do not let exceptions bubble out of the worker.
- **Never** write to or delete production databases or pages outside the scope documented in AGENTS.md (Docs, Home Docs, Tasks — and only using the database IDs from env).
- **Never** modify pages or databases that are not explicitly in scope for that worker.

## Output and behavior

- **Never** return raw Notion API response objects as the primary output. Map to your own typed result (e.g. `page_id`, `page_url`, `success`, `error`).
- **Never** return free-form strings as the only result; always return a typed, structured object so callers can handle success and failure programmatically.
- **Never** start long-running timers, background tasks, or servers; workers run once and exit.
- **Never** use Bun-specific APIs (`Bun.file()`, `Bun.serve()`, etc.) in worker or shared code so that deployment remains Node-compatible.

## Governance rules enforced in code

- **Status lines** — Format and emoji (✅ / ⚠️ / ❌) are derived from input via shared logic; workers don’t invent formats.
- **Page titles** — Normal runs: `{emoji} {Digest Type} — {date}`. Degraded: `{Digest Type} ERROR — {date}` (no emoji). Use shared helpers.
- **Flagged items** — Every flagged item must have `task_link` or `no_task_reason`; validation must reject invalid input.
- **Handoff circuit breaker** — No duplicate handoff task for the same source→target within 7 days; enforced in create-handoff-marker.
- **Escalation cap** — At most 2 escalations in the same direction within 7 days; then set `needs_manual_review` as defined for that worker.

## Testing and deployment

- **Never** use production database IDs or the production token in tests. Use `TEST_DOCS_DATABASE_ID` and `TEST_NOTION_TOKEN` (or equivalent) and guard integration tests with `describe.skipIf(!TEST_DB)`.
- **Never** merge or deploy if `npm run check` (tsc) or `bun test` fails.
- **Never** introduce `any` or disable strict checks to “fix” a type error without a documented reason and review.

## Summary

Validate input; use env for secrets; catch Notion errors and return structured errors; stay in scope; enforce governance rules in code; keep tests and deployment strict and non-destructive to production.
