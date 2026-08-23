#!/usr/bin/env bash
# surface-handoff.sh — SessionStart hook
# Surfaces a prior HANDOFF.md at the start of a session so the agent resumes where
# the last one left off. Never blocks; SessionStart hook stdout becomes session
# context. Completes the handoff machinery (issue #21):
#   - the `handoff` skill WRITES HANDOFF.md,
#   - check-handoff.sh (Stop) WARNS if it goes stale,
#   - this hook SURFACES it on the next session start.
# Before this, HANDOFF.md was written + warned-about but never re-surfaced, so a
# prior session's handoff was silently lost.

set -uo pipefail

# Resolve the MAIN working-tree root (shared across linked worktrees), matching
# check-handoff.sh / write-session-confirmed.sh resolvers.
PROJECT_ROOT=""
SEARCH_DIR="$(pwd)"
while [[ "$SEARCH_DIR" != "/" ]]; do
  if [[ -d "$SEARCH_DIR/.git" ]]; then
    PROJECT_ROOT="$SEARCH_DIR"
    break
  fi
  SEARCH_DIR="$(dirname "$SEARCH_DIR")"
done
[[ -z "$PROJECT_ROOT" ]] && exit 0

HANDOFF="$PROJECT_ROOT/HANDOFF.md"
[[ -f "$HANDOFF" ]] || exit 0

echo "── Prior session handoff (HANDOFF.md) ──────────────────────────────────"
cat "$HANDOFF"
echo "────────────────────────────────────────────────────────────────────────"
echo "Resume from the handoff above. Run the \`handoff\` skill to refresh HANDOFF.md before you stop."
exit 0
