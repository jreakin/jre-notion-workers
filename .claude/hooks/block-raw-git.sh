#!/usr/bin/env bash
# block-raw-git.sh — PreToolUse hook (GitButler workspaces).
# Blocks raw git write commands; read-only git inspection is allowed.
set -euo pipefail

INPUT="$(cat 2>/dev/null || true)"
CMD="$(printf '%s' "$INPUT" | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)
    print(d.get("tool_input",{}).get("command",""))
except Exception:
    print("")' 2>/dev/null || true)"

[ -z "$CMD" ] && exit 0

# Allowed: status/diff/log/show/blame, and `git add -- <path>` to mark conflict resolution.
if echo "$CMD" | grep -qE '\bgit\s+(status|diff|log|show|blame|rev-parse|ls-files)\b'; then
  exit 0
fi
if echo "$CMD" | grep -qE '\bgit\s+add\s+--\s'; then
  exit 0
fi

if echo "$CMD" | grep -qE '\bgit\s+(add|commit|push|checkout|switch|merge|rebase|stash|cherry-pick|reset|revert)\b'; then
  echo "BLOCKED: raw git write command in a GitButler workspace." >&2
  echo "Use: but commit / but push <branch> / but pr new / but pull. See docs/GITBUTLER.md" >&2
  echo "Hook blocked: $CMD" >&2
  exit 2
fi
exit 0
