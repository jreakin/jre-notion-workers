#!/bin/bash
# dev-env-local-touch-tracker.sh
# PostToolUse hook — logs every local file this session wrote/edited in this
# project folder, EXCLUDING .claude/ itself (avoids self-referential noise
# from the hooks/receipts this system writes). Never blocks — the Stop hook
# (dev-env-integrity-gate.sh) does the enforcement.
#
# Matcher (settings.json): "^(Write|Edit)$"
#
# Vendored from Notion into project_tools/hooks/ (abstract-data#281): FR-1 forbids a Notion page
# body from becoming an executable on disk. Advisory by construction — it only appends to a log.

INPUT=$(cat)
LOG=".claude/dev-env-touched-files.json"
mkdir -p .claude
[ -f "$LOG" ] || echo "[]" > "$LOG"

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

[ -z "$FILE_PATH" ] && exit 0

# Normalize to a path relative to this project folder when possible, and skip
# anything under .claude/ — that's this system's own bookkeeping, not user work.
REL_PATH=$(echo "$FILE_PATH" | sed "s|^$(pwd)/||")
case "$REL_PATH" in
  .claude/*) exit 0 ;;
esac

NOW=$(date +%s)
TMP=$(mktemp)
jq --arg path "$REL_PATH" --arg tool "$TOOL_NAME" --argjson at "$NOW" \
  '. + [{path: $path, tool: $tool, at_unix: $at}] | unique_by(.path)' \
  "$LOG" > "$TMP" 2>/dev/null && mv "$TMP" "$LOG" || rm -f "$TMP"

exit 0
