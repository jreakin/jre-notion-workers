#!/usr/bin/env bash
# pre-pr-review-gate.sh — PreToolUse hook
# matcher: gh pr create|gt submit|gt stack submit|but pr new
# Blocks PR creation until code-reviewer has run and written a fresh receipt.
# Abstract Data enforcement pattern (§4.7.16), same receipt/TTL style as
# python-design-gate.sh and agent-config-versioning-gate.sh.

set -euo pipefail

RECEIPT=".claude/code-reviewer-receipt.json"
TTL_SECONDS=14400

COMMAND="${1:-}"
if [ -z "$COMMAND" ]; then
  COMMAND=$(cat | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('command',''))" 2>/dev/null || echo "")
fi

case "$COMMAND" in
  *"gh pr create"*|*"gt submit"*|*"gt stack submit"*|*"but pr new"*) ;;
  *) exit 0 ;;
esac

if [ ! -f "$RECEIPT" ]; then
  echo "BLOCK: pre-pr-review-gate -- no code-reviewer receipt found." >&2
  echo "Dispatch the code-reviewer subagent before creating a PR, then retry." >&2
  exit 2
fi

VERDICT=$(python3 -c "import json; print(json.load(open('$RECEIPT')).get('verdict','MISSING'))" 2>/dev/null || echo "MISSING")
COMPLETED_AT=$(python3 -c "import json; print(json.load(open('$RECEIPT')).get('completed_at_unix',0))" 2>/dev/null || echo 0)
now_ts=$(date +%s)
age=$(( now_ts - COMPLETED_AT ))

if [ "$age" -gt "$TTL_SECONDS" ]; then
  echo "BLOCK: pre-pr-review-gate -- code-reviewer receipt is stale (>${TTL_SECONDS}s old)." >&2
  echo "Re-run code-reviewer, then retry." >&2
  exit 2
fi

if [ "$VERDICT" = "CHANGES_REQUESTED" ]; then
  echo "BLOCK: pre-pr-review-gate -- code-reviewer verdict is CHANGES_REQUESTED. Resolve findings first." >&2
  exit 2
fi

exit 0
