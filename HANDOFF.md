# HANDOFF — 2026-08-23

Session: Abstract Data full retrofit of jre-notion-workers, AD issue filing, PR #20, then Grok `.grok/` dual layout on that PR.

Git: `gitbutler/workspace`. Applied stack `re` [retrofit/abstract-data] above `8111fc9` (release v1.3.0). Also applied: `br` [j-branch-1] (unrelated; do not mix).

PR: https://github.com/jreakin/jre-notion-workers/pull/20  
Head: `b4be3ee` (`omr`) on `origin/retrofit/abstract-data`.

## Completed this session

- Full project-alignment retrofit (user chose apply-all): root `AGENTS.md` + Notion 6-field refs, `CLAUDE.md`/`GEMINI.md`/`copilot-instructions.md` symlinks, companion docs, ADRs, `REVIEWERS.md`, CI suite (Bun `tsc` + `bun test tests/unit`), enforcement (`gate.py` v1.3.1), universal subagents, `.abstract-data/`.
- Evidence: `python3 tests/verify/check_agents_md.py` PASS; `bun run check` clean; `bun test tests/unit` 253 pass / 0 fail.
- Commits on `retrofit/abstract-data`:
  - `lro` / `47c06b0` — `chore: Abstract Data project retrofit`
  - `omr` / `b4be3ee` — `chore: add Grok project dual-layout (.grok agents, hooks, skills)` (pushed)
- Skill run log: https://app.notion.com/p/3c57d7f5629881969504eb4127bf2d8d
- Filed 6 Abstract Data / GitHub issues from retrofit struggles:

| Journal | GitHub | Topic |
|---|---|---|
| #80 | https://github.com/jreakin/jre-agent-dev-cli/issues/404 | Grok `.grok/` vs AD `.claude/` dual layout |
| #83 | https://github.com/jreakin/jre-agent-dev-cli/issues/407 | MCP pull / nested `op run` auth |
| #82 | https://github.com/jreakin/jre-agent-dev-cli/issues/406 | apply `--only`, wrapper cache agents, extra hooks, blocked skills |
| #85 | https://github.com/jreakin/jre-agent-dev-cli/issues/409 | TS worker overlay still Python-shaped |
| #81 | https://github.com/jreakin/jre-agent-dev-cli/issues/405 | INDEX gate v1.4.0 vs deployed 1.3.1 |
| #84 | https://github.com/jreakin/jre-agent-dev-cli/issues/408 | task-critic subagent hang |

- **Grok dual layout committed** (workaround for #404): `.grok/agents|skills|commands` are relative symlinks into `.claude/`; `.grok/hooks/enforcement.json` + `with-claude-payload.py`; `gate.py` accepts Grok camelCase stdin; agents use `model: inherit`; `python-design-principles-gate` not linked (TS worker). See `.grok/README.md`.
- TASK.md: 10/10 boxes checked. Latest task-critic PASS `requirements_hash=1042030edbcb33b7c45487245301875d3770d74c055a80d37811dd73c700a5b7` (subagent `01a02c7a`, 10/10 confirmed). Gate ledger open items: 0.

## In-Flight (do not restart)

- **PR #20 is open and pushed.** Do not re-run alignment or rebuild `.grok/`. Review/merge is the remaining product work.
- **`abstract-data pull` skipped** (no Notion token in MCP non-TTY). After `op signin`: `warm-secrets && abstract-data pull && abstract-data apply --skip-pull`. A later apply may restore Claude `model:` pins on agents — reset to `inherit` or wait on #404.
- **Leftovers still uncommitted** (leave them in `zz`; do not add to the PR):
  - `_to_delete/`
  - `.abstract-data/dev-env-read-receipts.json`, `lockfile.toml.lock`
  - receipts: `.claude/checklist-completion-receipt.json`, `.claude/notion-hook-install-receipt.json`
  - stack-irrelevant extras: `.claude/agents/python-design-principles-gate.md`, `.claude/hooks/session-py-baseline.sh`, `terraform-guard.sh`, `terraform-review-gate.sh` (+ Cursor copies)
- **No code-reviewer receipt.** PR already exists; run `code-reviewer` before merge if `pre-pr-review-gate.sh` or REVIEWERS.md requires it.
- **Project Grok hooks** need `/hooks-trust` once per clone.

## Open gaps / known issues

- Nested `jre-notion-workers/AGENTS.md` still claims 2 unit failures (`AGENT_TARGET_DB` / Home & Life Watcher). Tests passed (253/0); that nested doc is stale.
- `.claude/settings.local.json` historically held a Notion PAT in allow-rules — still gitignored. Do not commit it.
- Category receipts were recorded manually after §4.7.26 copy (first-run chicken-egg). #408.
- `claude-config-security-audit` not installed this environment.
- `abstract-data apply` dumped extra Python/Terraform hooks that are unwired; optional prune. #406 / #409.

## Half-done patterns

None in application `src/` (no new workers, routes, or tests). Docs/hooks/CI/`.grok/` on the PR are complete files. Unwired extra apply hooks above are leftover, not stubs of in-progress app work.

## Decisions made

- Dual-write `.grok/` as relative symlinks + hook JSON; do not fork `.claude/` bodies.
- `gate.py` stays v1.3.1 (AD pin) but accepts Grok camelCase; bash hooks go through `with-claude-payload.py` so they are not double-run as identical command strings.
- Agent `model: inherit` so Grok can spawn them.
- Custom CI (`release-please.yml`, `sync-notion-secrets.yml`) left intact.
- 1Password stay: Environment mount + `op run --env-file=.env.1p`.

## Next session

1. **Run `/notion-read-confirm` to reload Notion context** (`.abstract-data/lockfile.toml` exists; cache may be stale until `abstract-data pull`).
2. **Review/merge PR #20** — do not restart retrofit. Optionally run `code-reviewer` first.
3. After `op signin`: `warm-secrets && abstract-data pull` if you want Notion-current apply; then re-check agent `model:` pins.
4. Optionally prune unwired Python/Terraform hook copies from `zz`.

## Watch out for

- Apply `--only` matches **Notion titles**, not filenames. Cache `agents/*.md` are **wrappers**, not deployable bodies.
- `ls` in this agent shell may not be GNU ls (`--icons` error); use `/bin/ls`.
- `bun` may be at `~/.bun/bin/bun`, not on default PATH.
- GitButler: use `but`, not raw `git commit` / `git push`. Branch for this work is `retrofit/abstract-data` (`re`), not `j-branch-1`.
- Do not commit `_to_delete/` or `.claude/settings.local.json`.
- Grok hook stdin is camelCase; unwrapped AD bash scripts no-op without `with-claude-payload.py`.
