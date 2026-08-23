#!/usr/bin/env bash
# require-notion-read.sh — PreToolUse hook, bundled with project-alignment.
#
# Blocks Edit/Write/MultiEdit until every Notion read-receipt category is fresh. Deployed
# by project-alignment into every audited project as .claude/hooks/require-notion-read.sh,
# wired to PreToolUse for the Edit|Write|MultiEdit matcher (see settings-snippet.json).
#
# This replaces the project-alignment skill's prior "abstract-data receipt-check --json"
# call, which depended on an external CLI the skill itself flagged as unconfirmed to exist.
# This script has no external dependency beyond python3, which ships with the skill's
# bundled dev_env_receipts.py.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RECEIPTS_SCRIPT="${SCRIPT_DIR}/../scripts/dev_env_receipts.py"

if [ ! -f "$RECEIPTS_SCRIPT" ]; then
  # Fail open with a loud warning rather than silently blocking every write in a project
  # that hasn't had project-alignment fully installed yet.
  echo "⚠️  require-notion-read.sh: dev_env_receipts.py not found at $RECEIPTS_SCRIPT — skipping gate" >&2
  exit 0
fi

RESULT_JSON="$(python3 "$RECEIPTS_SCRIPT" check --json)"
PASS="$(echo "$RESULT_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["pass"])')"

if [ "$PASS" = "True" ]; then
  exit 0
fi

FAILING="$(echo "$RESULT_JSON" | python3 -c '
import json, sys
d = json.load(sys.stdin)
failing = [c for c, v in d["categories"].items() if v["status"] != "FRESH"]
print(", ".join(failing))
')"

echo "🛑 BLOCKED — Notion read-receipt gate failed for: ${FAILING}" >&2
echo "Run the corresponding Notion fetch(es) for these categories before editing/writing files." >&2
echo "See project-alignment SKILL.md Step 0.1b for the fetch-to-category mapping." >&2
exit 1
