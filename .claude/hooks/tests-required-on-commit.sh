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

CODE_COUNT=$(git diff --staged --name-only -- 'src/*.ts' 'src/*.tsx' 2>/dev/null | grep -vE 'test|spec|\.d\.ts' | wc -l | tr -d ' ')
TEST_COUNT=$(git diff --staged --name-only 2>/dev/null | grep -cE '(tests/|\.test\.|\.spec\.|\.eval\.)' || true)

if [[ "${CODE_COUNT:-0}" -gt 3 && "${TEST_COUNT:-0}" -eq 0 ]]; then
  deny_shell \
    "$CODE_COUNT source files staged with no test changes." \
    "Add or update tests under tests/ or confirm this change is test-exempt (docs/config only)."
fi

allow_shell
