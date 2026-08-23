#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/_common.sh"
read_hook_input

file="$(tool_file_path)"
if [[ -z "$file" || ( "$file" != *.ts && "$file" != *.tsx ) ]]; then
  exit 0
fi

ROOT="$(repo_root)"
rel="${file#"$ROOT"/}"
if [[ "$rel" == src/* || "$rel" == tests/* ]]; then
  (cd "$ROOT" && bun run eslint --fix "$rel" 2>/dev/null) || true
fi

exit 0
