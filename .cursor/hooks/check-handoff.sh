#!/usr/bin/env bash
# check-handoff.sh — Stop hook
# Warns if the session wrote files but HANDOFF.md was not updated.
# Never blocks (Stop hooks must always exit 0).

set -uo pipefail

# Walk up to find project root
PROJECT_ROOT=""
SEARCH_DIR="$(pwd)"
while [[ "$SEARCH_DIR" != "/" ]]; do
  if [[ -d "$SEARCH_DIR/.git" ]]; then
    PROJECT_ROOT="$SEARCH_DIR"
    break
  fi
  SEARCH_DIR="$(dirname "$SEARCH_DIR")"
done

# No git repo — skip
if [[ -z "$PROJECT_ROOT" ]]; then
  exit 0
fi

HANDOFF="$PROJECT_ROOT/HANDOFF.md"

# Check if any tracked files were modified this session
# (git diff --name-only includes staged + unstaged changes)
CHANGED_FILES=$(git -C "$PROJECT_ROOT" diff --name-only HEAD 2>/dev/null | \
  grep -v "^HANDOFF.md$" | wc -l | tr -d ' ')

# If no changes, no handoff needed
if [[ "$CHANGED_FILES" -eq 0 ]]; then
  exit 0
fi

# Check if HANDOFF.md exists and was modified recently (within last 30 min)
HANDOFF_FRESH=false
if [[ -f "$HANDOFF" ]]; then
  if command -v python3 &>/dev/null; then
    AGE=$(python3 -c "
import os, time
try:
    age = time.time() - os.path.getmtime('$HANDOFF')
    print(int(age))
except: print(99999)
")
    if (( AGE < 1800 )); then
      HANDOFF_FRESH=true
    fi
  fi
fi

if [[ "$HANDOFF_FRESH" == "true" ]]; then
  exit 0
fi

# Warn — do not block
cat >&2 <<MSG
⚠  Session ended with $CHANGED_FILES modified file(s) but HANDOFF.md
   was not updated in the last 30 minutes.

   Run /handoff before ending your next session to maintain continuity.
   (The next agent or session will have no record of what was in-flight.)
MSG

exit 0
