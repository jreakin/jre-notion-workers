#!/usr/bin/env bash
# record-notion-read.sh — PostToolUse hook, bundled with project-alignment.
#
# Fires automatically after any Notion MCP fetch/search/query-data-sources tool call.
# Reads the real tool response Notion returned (Claude Code passes the full PostToolUse
# payload — tool_name + tool_response — on stdin) and records a read-receipt for whichever
# category the response actually belongs to. The agent does not self-report what it read;
# this hook decides from the tool's own output.
#
# Deployed by project-alignment into every audited project as
# .claude/hooks/record-notion-read.sh, wired to PostToolUse (see settings-snippet.json).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RECEIPTS_SCRIPT="${SCRIPT_DIR}/../scripts/dev_env_receipts.py"

if [ ! -f "$RECEIPTS_SCRIPT" ]; then
  # Recorder, not a gate — missing script should never block the underlying tool call.
  exit 0
fi

# Pass the hook's stdin straight through. record-from-hook does its own JSON parsing and
# exits 0 even on a no-op (e.g. a Notion search that isn't one of the tracked categories).
cat | python3 "$RECEIPTS_SCRIPT" record-from-hook || true
exit 0
