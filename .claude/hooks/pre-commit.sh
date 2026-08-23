#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/_common.sh"
read_hook_input

command="$(shell_command)"
if [[ -z "$command" ]] || ! echo "$command" | grep -qE 'git commit'; then
  allow_shell
fi

ROOT="$(repo_root)"
cd "$ROOT"

SECRETS=$(git diff --staged 2>/dev/null | grep -iE '(api_key|secret|token|password|credential|private_key|access_key)\s*[:=]\s*["'\'']\w{8,}' || true)
if [[ -n "$SECRETS" ]]; then
  deny_shell \
    "Potential secrets detected in staged changes." \
    "Remove secrets from staged files before committing. Use Wrangler secrets / 1Password per AGENTS.md."
fi

allow_shell
