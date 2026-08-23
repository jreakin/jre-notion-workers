# `.grok/` — Grok-native project config

Grok session logs live in `~/.grok/sessions/`, not here.

This directory is **committed** project config so Grok discovers the same Abstract Data enforcement that Claude Code loads from `.claude/`.

| Path | What Grok uses it for |
|---|---|
| `agents/*.md` | Spawnable agent types (`subagent_type`) — Claude's `.claude/agents/` is **not** scanned |
| `skills/` | Project skills (higher priority than `.claude/skills/`) |
| `commands/` | Slash commands |
| `hooks/*.json` | Native Grok hooks (also loads `.claude/settings.json` when Claude compat is on; identical handlers are deduped) |
| `hooks/with-claude-payload.py` | Maps Grok camelCase stdin onto Claude snake_case before AD scripts run |
| `rules/` | Extra markdown rules |
| `config.toml` | Project permission deny rules |

Agents, skills, and commands are **relative symlinks** into `.claude/` so there is one body to edit. Hook scripts stay in `.claude/hooks/`; the JSON here only registers them.

Do not copy hook `.sh` files into `.grok/hooks/` — Grok hook files are JSON, and the scripts are shared.

## Why this tree exists

Grok already loads `.claude/skills/` and `.claude/settings.json` when Claude compatibility is on. It does **not** load `.claude/agents/`. Spawn `task-critic`, `code-reviewer`, `session-closer`, and the rest from `.grok/agents/` (those files symlink at the `.claude/` bodies).

`python-design-principles-gate.md` is not linked here — this is a TypeScript worker.

## Hook payload adapter

Grok hook stdin is camelCase (`toolName`, `toolInput`, `sessionId`). AD scripts expect Claude snake_case (`tool_name`, `tool_input`, `session_id`). `gate.py` accepts both. Other scripts are invoked through `with-claude-payload.py` from `hooks/enforcement.json`.

Identical `gate.py` command strings in `.claude/settings.json` and this JSON are deduped. Wrapped bash commands are Grok-only so they do not double-fire under Claude Code.

Project hooks require folder trust (`/hooks-trust` or `--trust`).

## Agent models

Project agents use `model: inherit` so Grok can spawn them (Claude model pins such as `claude-sonnet-4-6` do not resolve here). A later `abstract-data apply` may restore Claude pins — set inherit again, or wait for AD #404.