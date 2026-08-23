# RUNBOOK.md — jre-notion-workers

**Version:** 1.0.0 | **Last Updated:** 2026-08-22

## Preflight

```bash
cd jre-notion-workers
bun install
bun run check
bun test tests/unit
```

Secrets: `.env.local` (1Password mount) or `op run --env-file=.env.1p -- bun test`.

## Common issues

| Symptom | Check |
|---|---|
| `"NTN_API_TOKEN is not set"` | env file not loaded; use `dev:local` / `test:1p` |
| Integration tests skipped | `TEST_DOCS_DATABASE_ID` unset (expected in CI) |
| `bun install --frozen-lockfile` fails | lockfile can lag `package.json`; use `bun install` |
| `git commit` blocked | GitButler workspace — use `but commit` |

## Deploy

```bash
cd jre-notion-workers
bun run check && bun run build
op run --env-file=.env.1p -- bash scripts/deploy.sh
```

## Escalation

Scope/auth errors: stop, do not retry. Open a Dead Letter / Task linked to [Notion Workers](https://www.notion.so/3157d7f562988057b079ef0d3c48eb46).
