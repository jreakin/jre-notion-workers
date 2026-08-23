#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/_common.sh"
read_hook_input

ROOT="$(repo_root)"
command="$(shell_command)"
if [[ -n "$command" ]]; then
  mkdir -p "$ROOT/.cursor/hooks/state"
  printf '%s %s\n' "$(date -Is)" "$command" >> "$ROOT/.cursor/hooks/state/command-log.txt"
fi

allow_shell
