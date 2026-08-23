# GUARDRAILS.md — jre-notion-workers

**Version:** 1.0.0 | **Last Updated:** 2026-08-22

Boundary rules for every worker in `jre-notion-workers/src/`. Signs use Trigger / Instruction / Reason / Provenance.

## Privilege boundaries

Each worker uses one Notion token from env (`NTN_API_TOKEN`). Never hardcode tokens or database IDs. Never log secrets. Never commit `.env` / `.env.local`.

## Always do

- Validate input before any Notion call
- Return `{ success: false, error }` on validation or API failure
- Paginate Notion list endpoints
- Use test tokens/DBs in integration tests
- Read Context7 before citing `@notionhq/workers` APIs

## Ask first

- Writing to a database not already in that worker's contract
- Bulk archive/delete
- `ntn workers deploy` to production
- Changing 1Password-managed env files (use `gate.py 1p-declare`)

## Never do

- Bun-only APIs in `src/`
- Production IDs in tests
- Retry `unauthorized` / `restricted_resource`
- Log Notion property values (PII)
- Raw `git commit` / `git push` in this GitButler workspace

## Initial Signs

1. **Trigger:** `NTN_API_TOKEN` missing. **Instruction:** fail fast with a clear error. **Reason:** unauthenticated calls look like outages. **Provenance:** `notion-client.ts` + `.env.example`.
2. **Trigger:** worker would write a DB ID not in env. **Instruction:** refuse. **Reason:** scope creep into the wrong database. **Provenance:** AGENTS.md scope.
3. **Trigger:** duplicate handoff within 7 days. **Instruction:** circuit-break. **Reason:** re-escalation storms. **Provenance:** `create-handoff-marker`.
4. **Trigger:** `any` introduced in `src/`. **Instruction:** reject unless `// SAFETY:` is present. **Reason:** Notion payloads are unions; `any` hides discriminant bugs. **Provenance:** JS/TS base template.
5. **Trigger:** log line includes token or page title/property. **Instruction:** strip to IDs and counts. **Reason:** PII. **Provenance:** JS/TS GUARDRAILS template.

## Agent-Learned Signs

<!-- append-only; agents add new signs here after incidents -->

## Risk classification

| Level | Example | Response |
|---|---|---|
| Low | empty result set | log, continue |
| Medium | stale digest | flag, continue |
| High | auth/scope error | stop, escalate |
| Critical | write to wrong database | stop, human review |
