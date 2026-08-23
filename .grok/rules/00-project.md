<!-- Version: 1.0.0 | Last Updated: 2026-08-23 -->

# Grok project rules — jre-notion-workers

- Canonical agent instructions: repo-root `AGENTS.md` (this tree also has `CLAUDE.md` as a symlink).
- App package lives in `jre-notion-workers/`. Run `bun run check` and `bun test tests/unit` there. Bun may be `~/.bun/bin/bun`.
- Git writes: GitButler `but`, not raw `git commit` / `git push`.
- Abstract Data enforcement scripts live in `.claude/hooks/`. Grok loads them via `.grok/hooks/enforcement.json` (bash scripts wrapped with `with-claude-payload.py`) and, with Claude compat on, `.claude/settings.json`. `gate.py` accepts Grok camelCase stdin directly.
- Spawn project subagents from `.grok/agents/` (`code-reviewer`, `task-critic`, `session-closer`, `researcher`, …). Those files symlink to `.claude/agents/` and use `model: inherit`.
- Secrets: never commit `.env` / `.env.local` / `.claude/settings.local.json`. Use 1Password mount or `op run --env-file=.env.1p`.
