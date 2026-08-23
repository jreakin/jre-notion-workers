#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/_common.sh"
read_hook_input

command="$(shell_command)"
if [[ -z "$command" ]]; then
  allow_shell
fi

dangerous_patterns=(
  'rm -rf'
  'git reset --hard'
  'git push.*--force'
  'DROP TABLE'
  'DROP DATABASE'
  'truncate.*--cascade'
  'curl.*\|.*sh'
  'wget.*\|.*bash'
  'wrangler d1 execute.*DELETE'
  'terraform destroy'
)

for pattern in "${dangerous_patterns[@]}"; do
  if echo "$command" | grep -qiE "$pattern"; then
    deny_shell \
      "Blocked dangerous shell command (pattern: $pattern)." \
      "Hook blocked: $command. Propose a safer alternative and get human approval if needed."
  fi
done

allow_shell
