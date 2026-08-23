#!/bin/bash
# PreToolUse(Bash) hook — 1Password CLI guard (ADR-0018).
#
# Denies the incorrect `op` invocations agents reach for, per the configured auth
# method (read from .claude/op-guard.conf, written by `abstract-data apply`):
#   - bare `op run` without --environment  -> nests/masks the token and HANGS the session
#   - inline OP_SERVICE_ACCOUNT_TOKEN=...   -> leaks via the process list
#   - `op signin`                          -> interactive, hangs an agent session
#
# Self-disables (exit 0) when no method is configured, so non-1P projects are
# unaffected. Fail-OPEN on its own errors — a guard bug must never brick the session.
set -uo pipefail

INPUT=$(cat 2>/dev/null || true)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // .command // empty' 2>/dev/null || true)
[ -z "$CMD" ] && exit 0

# Only care about commands that actually invoke `op`.
echo "$CMD" | grep -qE '(^|[^[:alnum:]_-])op[[:space:]]' || exit 0

# --- FR-4.1: host-tolerant project-root resolution ---------------------------------
# Mirrors gate.py:project_dir() exactly:
#   CLAUDE_PROJECT_DIR -> CURSOR_PROJECT_DIR -> payload .workspace_roots[0] -> .cwd -> cwd
# The old `${CLAUDE_PROJECT_DIR:-$PWD}` read the wrong tree on every non-Claude host, and
# this guard SELF-DISABLES (exit 0) when op-guard.conf is not found there — a wrong root
# is indistinguishable from "not configured", so the failure mode is silent non-enforcement.
resolve_project_root() {
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then printf '%s' "$CLAUDE_PROJECT_DIR"; return 0; fi
  if [ -n "${CURSOR_PROJECT_DIR:-}" ]; then printf '%s' "$CURSOR_PROJECT_DIR"; return 0; fi
  local root=""
  root=$(printf '%s' "$INPUT" | jq -r '(.workspace_roots[0]? // .cwd? // empty)' 2>/dev/null) ||
    root=""
  if [ -n "$root" ] && [ "$root" != "null" ]; then printf '%s' "$root"; return 0; fi
  pwd
}

PROJECT_DIR=$(resolve_project_root) || PROJECT_DIR="$PWD"
[ -n "$PROJECT_DIR" ] || PROJECT_DIR="$PWD"
CONF="$PROJECT_DIR/.claude/op-guard.conf"
OP_METHOD=""
OP_ENV_ID=""
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF" 2>/dev/null
[ -z "${OP_METHOD:-}" ] && exit 0  # not configured — nothing to enforce

deny() {
  echo "BLOCKED (1Password guard): $1" >&2
  exit 2
}

# Inline service-account token on the command line — leaks via the process list. (all methods)
echo "$CMD" | grep -qE 'OP_SERVICE_ACCOUNT_TOKEN=' &&
  deny "never inline OP_SERVICE_ACCOUNT_TOKEN; export it in your shell/env instead."

# Interactive signin hangs a non-interactive agent session. (all methods)
echo "$CMD" | grep -qE '(^|[^[:alnum:]_-])op[[:space:]]+signin([[:space:]]|$)' &&
  deny "don't run 'op signin' in an agent session; use the configured non-interactive method."

# Environment mode: secrets must be run via `op run --environment <id> -- …`.
if [ "$OP_METHOD" = "environment" ]; then
  if echo "$CMD" | grep -qE '(^|[^[:alnum:]_-])op[[:space:]]+run([[:space:]]|$)'; then
    echo "$CMD" | grep -qE 'op[[:space:]]+run[[:space:]].*--environment([[:space:]]|=)' ||
      deny "use: op run --environment ${OP_ENV_ID:-<id>} -- <command>  (a bare 'op run' hangs)."
  fi
fi

exit 0
