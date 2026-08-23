#!/bin/bash
# PreToolUse hook: block Notion write operations (enforce Notion-as-canonical)
# Project: abstract-data
# Tool: Bash
# Severity: BLOCK (exit 2)
#
# Notion is the canonical source of truth for all skills, prompts, hooks, and agents.
# No code path should write back to Notion — only reads are permitted from src/.
# Writes must go through the Notion UI or the Notion API directly, never programmatically
# from within this project.
#
# Catches: curl POSTing to api.notion.com with write methods.

set -euo pipefail

# FR-4.1: read the WHOLE payload. The previous single-line `read` builtin consumed only
# the first line, so a pretty-printed or otherwise multi-line payload left jq a JSON
# fragment; jq exited non-zero and `set -e` aborted the guard — it failed OPEN on the very
# writes it exists to block. A one-line payload with no trailing newline made the `read`
# builtin itself return 1, which `set -e` turned into the same silent fail-open.
INPUT=$(cat 2>/dev/null || true)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // .command // empty' 2>/dev/null || true)

if [[ -z "$CMD" ]]; then
  exit 0
fi

# Catch curl/wget Notion write operations
if echo "$CMD" | grep -qiE 'api\.notion\.com'; then
  if echo "$CMD" | grep -qiE '(--request|-X)[[:space:]]*(POST|PATCH|DELETE|PUT)'; then
    echo "BLOCKED: Notion write detected (POST/PATCH/DELETE to api.notion.com)." >&2
    echo "  Notion is the canonical source. Writes must go through the Notion UI." >&2
    echo "  abstract-data is read-only toward Notion — it never writes back." >&2
    exit 2
  fi
fi

exit 0
