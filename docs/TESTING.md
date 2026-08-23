# TESTING.md — jre-notion-workers

**Version:** 1.0.0 | **Last Updated:** 2026-08-22

Test strategy for the Notion Workers package. Canonical commands run in `jre-notion-workers/`.

## Testing stack

- **Runner:** Bun test (native TS)
- **Assertions:** `expect()` from `bun:test`
- **Typecheck:** `bun run check` (`tsc --noEmit`)
- **Coverage:** `bun test --coverage`

```bash
cd jre-notion-workers
bun test
bun test tests/unit
bun test tests/integration/    # requires TEST_* env; otherwise skipped
bun test --coverage
bun run check
```

## Pyramid

Target: ~80% unit / 15% integration / 5% evals. Integration tests must use `TEST_NOTION_TOKEN` + `TEST_DOCS_DATABASE_ID` (never production). Guard with `describe.skipIf`.

## Layout

```
jre-notion-workers/tests/
├── unit/           # no network
├── integration/    # real Notion, env-gated
├── evals/          # golden pairs (*.eval.ts)
└── fixtures/
```

## Metric targets (initial)

| Check | Target |
|---|---|
| Unit suite | < 10s |
| `tsc --noEmit` | clean |
| Coverage (lines, unit) | measure in CI; do not fail the build on a percentage until a baseline is committed |
| Integration | skip in default CI |

## CI checklist

- [ ] `bun test tests/unit` passes
- [ ] `bun run check` passes
- [ ] No new `any` without a SAFETY comment
- [ ] Integration tests do not use production database IDs

## Known drift

`jre-notion-workers/AGENTS.md` documents two unit tests that fail when `AGENT_TARGET_DB` lacks a Home & Life Watcher entry. Treat that as application drift, not a retrofit blocker; do not weaken tests to hide it.
