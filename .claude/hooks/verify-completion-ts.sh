#!/usr/bin/env bash
# Stop hook: gate completion on tsc/lint/test when src/ or tests/ changed.
set -euo pipefail
source "$(dirname "$0")/_common.sh"
read_hook_input

loop_count="$(json_field '.loop_count')"
if [[ -n "$loop_count" && "$loop_count" -ge 2 ]]; then
  exit 0
fi

ROOT="$(repo_root)"
cd "$ROOT"

failures=()

if [[ -f TASK.md ]]; then
  UNCHECKED=$(grep -c '^- \[ \]' TASK.md 2>/dev/null || echo 0)
  if [[ "$UNCHECKED" -gt 0 ]]; then
    failures+=("TASK.md has $UNCHECKED unchecked item(s).")
  fi
fi

CHANGED_SRC=$(git diff --name-only HEAD 2>/dev/null | grep -E '^(src|tests)/.*\.(ts|tsx)$' || true)

if [[ -n "$CHANGED_SRC" ]]; then
  if ! bun run tsc >/dev/null 2>&1; then
    failures+=("Typecheck failed. Run: bun run tsc")
  fi
  if ! bun run lint >/dev/null 2>&1; then
    failures+=("Lint failed. Run: bun run lint")
  fi
  if ! bun run test >/dev/null 2>&1; then
    failures+=("Tests failed. Run: bun run test")
  fi
fi

if [[ ${#failures[@]} -eq 0 ]]; then
  exit 0
fi

msg="Completion verification failed:\n"
for f in "${failures[@]}"; do
  msg+="- $f\n"
done
msg+="Fix these issues, then try again."

jq -n --arg m "$msg" '{followup_message: $m}'
exit 0
