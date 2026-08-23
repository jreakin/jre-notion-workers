# TASK.md — Abstract Data retrofit (jre-notion-workers)

**Mode:** full retrofit (Critical + Standard + Drift + Optional)  
**Date:** 2026-08-22  
**Project type:** TypeScript Notion Worker (`ntn` / `@notionhq/workers`)  
**App package:** `./jre-notion-workers/`  
**Branch authority:** GitButler (`but`)

## Implementation checklist

- [x] Root AGENTS.md with 6-field Notion References and required sections
  - Verify: `python3 tests/verify/check_agents_md.py`
  - Risk: HIGH
- [x] CLAUDE.md / GEMINI.md / copilot-instructions.md point at AGENTS.md
  - Verify: `test -L CLAUDE.md && test "$(readlink CLAUDE.md)" = AGENTS.md`
  - Risk: LOW
- [x] Enforcement hooks + gate.py v1.3.1 + settings.json wiring
  - Verify: `python3 .claude/hooks/gate.py version`
  - Risk: HIGH
- [x] Universal subagents in `.claude/agents/` with version/model/tools
  - Verify: `test -f .claude/agents/task-critic.md && test -f .claude/agents/code-reviewer.md`
  - Risk: MEDIUM
- [x] Companion docs, ADRs, prompts README, plans README, REVIEWERS.md
  - Verify: `test -f docs/ARCHITECTURE.md && test -f docs/adr/0001-initial-tool-selection.md`
  - Risk: MEDIUM
- [x] CI workflows (ci.yml, ci-quality.yml, ci-tests.yml, ci-report.yml) without replacing release-please
  - Verify: `test -f .github/workflows/ci.yml && test -f .github/workflows/release-please.yml`
  - Risk: MEDIUM
- [x] .gitignore allows committed hooks; keeps settings.local.json and state out
  - Verify: `grep -q 'settings.local.json' .gitignore && grep -q '.claude/handoffs/' .gitignore`
  - Risk: HIGH
- [x] abstract-data apply from cache (`skip_pull`); `.abstract-data/` present
  - Verify: `test -d .abstract-data && test -f .abstract-data/lockfile.toml`
  - Risk: MEDIUM
- [x] bun typecheck + unit tests in app package
  - Verify: `cd jre-notion-workers && bun run check && bun test tests/unit`
  - Risk: HIGH
- [x] Project `.grok/` dual layout (agents/skills/commands/hooks/rules)
  - Verify: `test -L .grok/agents/task-critic.md && test -f .grok/hooks/enforcement.json && test -f .grok/hooks/with-claude-payload.py`
  - Risk: HIGH

## Files in scope

- Repo-root agent docs: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `NOTES.md`, `REVIEWERS.md`, `AGENT-DOCS-VERSIONING.md`
- Companion docs: `docs/ARCHITECTURE.md`, `docs/TESTING.md`, `docs/GUARDRAILS.md`, `docs/DEPLOYMENTS.md`, `docs/RUNBOOK.md`, `docs/adr/`, `prompts/`, `plans/`
- Enforcement: `.claude/hooks/`, `.claude/agents/`, `.claude/settings.json`, `.claude/scripts/`, `.cursor/rules/`
- Grok dual layout: `.grok/{agents,skills,commands,hooks,rules,config.toml,README.md}`
- CI: `.github/workflows/ci.yml`, `ci-quality.yml`, `ci-tests.yml`, `ci-report.yml` (do not replace existing `release-please.yml`, `sync-notion-secrets.yml`, `label.yml`)
- Gitignore: allow committed `.claude/` hooks/agents/settings while keeping `settings.local.json` and state out of git
- Nested package docs: `jre-notion-workers/AGENTS.md` and companions (update, do not delete)

## Behavior to preserve

- Nested app layout and all existing workers under `jre-notion-workers/src/`
- 1Password local `.env` mount + `op run --env-file=.env.1p` + Cursor 1Password hook
- Release Please config and existing GitHub workflows
- `packages/workers` recovery tree and tracked `dist/` (ADR-0005)
- `eakin-nexdns-setup/`
- Custom scripts (`scripts/install-ntn.sh`, nested deploy/secret-sync)

## Checks to run

- `bun run check` (from `jre-notion-workers/`)
- `bun test` unit tests (skip integration unless `TEST_*` env is set)
- Confirm required hooks exist and are executable
- Confirm `CLAUDE.md` is a symlink to `AGENTS.md`
- Confirm AGENTS.md has Tool Permissions, Anti-Pattern Warnings, and 6-field Notion References

## Done evidence

- `.abstract-data/` initialized and content applied from cache (`skip_pull` because MCP Notion token is not in this shell)
- Enforcement bundle + universal subagents on disk and wired in `.claude/settings.json`
- `.grok/` dual layout: spawnable agents, skills, commands, Grok hook JSON + camelCase adapter, `config.toml` deny rules
- Root `AGENTS.md` with resolved Notion References
- `task-critic` PASS receipt hash-bound to this file
- Post-alignment code-conformance review disposed
