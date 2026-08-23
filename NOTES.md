# NOTES.md

Cross-platform context for agents. Keep under 80 lines.

- **Repo:** `jreakin/jre-notion-workers` — wrapper at git root, app in `jre-notion-workers/`
- **Type:** TypeScript Notion Worker (`ntn`, `@notionhq/workers`)
- **Commands:** `cd jre-notion-workers && bun run check && bun test`
- **Secrets:** 1Password mount + `op run --env-file=.env.1p`; code reads `NTN_API_TOKEN`
- **Git:** GitButler (`but`). HEAD is `gitbutler/workspace`
- **Canonical agent docs:** root `AGENTS.md` (CLAUDE.md / GEMINI.md are symlinks)
- **Do not delete:** `packages/workers/`, tracked `dist/` (ADR-0005)
- **CI:** Bun typecheck + unit tests; existing `release-please.yml` and `sync-notion-secrets.yml` stay
- **Notion:** Project [Notion Workers](https://www.notion.so/3157d7f562988057b079ef0d3c48eb46) (AD-PROJ-16), client Abstract Data Internal
