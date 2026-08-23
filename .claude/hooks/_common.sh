#!/usr/bin/env bash
# Shared helpers for Abstract Data Cursor governance hooks.
# Source from other hooks: source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

read_hook_input() {
  HOOK_INPUT=$(cat)
}

json_field() {
  local expr="$1"
  echo "$HOOK_INPUT" | jq -r "$expr // empty" 2>/dev/null
}

tool_file_path() {
  local path
  path="$(json_field '.file_path')"
  if [[ -z "$path" ]]; then
    path="$(json_field '.tool_input.file_path // .tool_input.path')"
  fi
  echo "$path"
}

shell_command() {
  json_field '.command // .tool_input.command'
}

deny_tool() {
  local user_msg="$1"
  local agent_msg="${2:-$1}"
  jq -n \
    --arg um "$user_msg" \
    --arg am "$agent_msg" \
    '{permission: "deny", user_message: $um, agent_message: $am}'
  exit 0
}

allow_tool() {
  echo '{"permission":"allow"}'
  exit 0
}

deny_shell() {
  local user_msg="$1"
  local agent_msg="${2:-$1}"
  jq -n \
    --arg um "$user_msg" \
    --arg am "$agent_msg" \
    '{permission: "deny", user_message: $um, agent_message: $am}'
  exit 0
}

allow_shell() {
  echo '{"permission":"allow"}'
  exit 0
}

repo_root() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  cd "$script_dir/../.." && pwd
}
