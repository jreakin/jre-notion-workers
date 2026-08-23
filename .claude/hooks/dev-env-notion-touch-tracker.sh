#!/bin/bash
# dev-env-notion-touch-tracker.sh
# PostToolUse hook — logs every Notion page/data-source touched this session
# by a write-capable Notion MCP tool call. Never blocks (PostToolUse always
# exits 0); the Stop hook (dev-env-integrity-gate.sh) does the enforcement.
#
# Matcher (settings.json) should be a regex against the tool name, e.g.:
#   mcp__.*__notion-(create-pages|update-page|update-data-source|duplicate-page|move-pages)
# Adjust the connector-prefix portion to your environment's actual MCP server name.
#
# Vendored from Notion into project_tools/hooks/ (abstract-data#281): FR-1 forbids a Notion page
# body from becoming an executable on disk. Advisory by construction — it only appends to a log.

INPUT=$(cat)
LOG=".claude/dev-env-touched-pages.json"
mkdir -p .claude
[ -f "$LOG" ] || echo "[]" > "$LOG"

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')

# Pull every plausible page/data-source id out of tool_input and tool_response.
# Notion tool shapes vary by call (page_id, data_source_id, parent.page_id,
# parent.data_source_id, or an array of created pages in tool_response) — collect
# all candidates rather than assuming one shape.
NEW_IDS_JSON=$(echo "$INPUT" | jq -c '
  [
    .tool_input.page_id?,
    .tool_input.data_source_id?,
    .tool_input.parent.page_id?,
    .tool_input.parent.data_source_id?,
    (.tool_input.pages[]?.page_id?),
    (.tool_response.pages[]?.id?),
    (.tool_response.id?)
  ]
  | flatten
  | map(select(. != null and . != ""))
  | unique
' 2>/dev/null)

[ -z "$NEW_IDS_JSON" ] && exit 0
[ "$NEW_IDS_JSON" = "[]" ] && exit 0

NOW=$(date +%s)
TMP=$(mktemp)
jq --argjson newids "$NEW_IDS_JSON" --arg tool "$TOOL_NAME" --argjson at "$NOW" \
  '. + ($newids | map({id: ., tool: $tool, at_unix: $at})) | unique_by(.id)' \
  "$LOG" > "$TMP" 2>/dev/null && mv "$TMP" "$LOG" || rm -f "$TMP"

exit 0
