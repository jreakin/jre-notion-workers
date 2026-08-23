#!/bin/bash
# dev-env-integrity-gate.sh
# Stop hook — hard-blocks session completion until this session's work is
# either (a) verified against Notion, or (b) explicitly explained why Notion
# didn't need to change. Three branches, checked in order:
#
#   1. Notion pages were touched this session (.claude/dev-env-touched-pages.json
#      non-empty) -> require FRESH, matching, non-BLOCK receipts from BOTH
#      dev-env-schema-auditor and dev-env-link-integrity-auditor.
#   2. No Notion pages touched, but local files were touched
#      (.claude/dev-env-touched-files.json non-empty) -> require a fresh,
#      matching .claude/dev-env-sync-disposition.json explaining whether/why
#      Notion was or wasn't updated (SYNCED / NOT_NEEDED / DEFERRED + reason).
#   3. Nothing touched at all -> nothing to gate, exit 0.
#
# This is the general-purpose sibling of python-design-gate.sh /
# tanstack-review-gate.sh: same stop_hook_active guard, same sha+TTL+verdict
# receipt pattern, just keyed on Notion/local touch logs instead of git diff.
#
# Vendored from Notion into project_tools/hooks/ (abstract-data#281): FR-1 forbids a Notion page
# body from becoming an executable on disk. Branch 3 makes it inert in any project whose
# touch-tracker logs are absent, which is every project that has not opted into the dev-env pair.

INPUT=$(cat)

if [ "$(echo "$INPUT" | jq -r '.stop_hook_active')" = "true" ]; then
  exit 0
fi

NOTION_LOG=".claude/dev-env-touched-pages.json"
FILES_LOG=".claude/dev-env-touched-files.json"
NOW=$(date +%s)
TTL=7200

has_entries() {
  # $1 = path to a JSON array log file
  [ -f "$1" ] && [ "$(jq 'length' "$1" 2>/dev/null || echo 0)" -gt 0 ]
}

# ── Branch 1: Notion pages touched -> require both auditor receipts ───────────
if has_entries "$NOTION_LOG"; then
  TOUCHED_SHA=$(jq -c '[.[].id] | unique | sort' "$NOTION_LOG" | shasum -a 256 | cut -d' ' -f1)

  check_receipt() {
    # $1 = receipt path, $2 = human label
    local RECEIPT="$1" LABEL="$2"
    if [ ! -f "$RECEIPT" ]; then
      echo "❌ Missing $LABEL receipt ($RECEIPT)." >&2
      return 1
    fi
    local R_SHA R_TIME R_VERDICT AGE
    R_SHA=$(jq -r '.touched_pages_sha // empty' "$RECEIPT" 2>/dev/null)
    R_TIME=$(jq -r '.completed_at_unix // 0' "$RECEIPT" 2>/dev/null)
    R_VERDICT=$(jq -r '.verdict // empty' "$RECEIPT" 2>/dev/null)
    AGE=$((NOW - R_TIME))
    if [ "$R_SHA" != "$TOUCHED_SHA" ]; then
      echo "❌ $LABEL receipt is stale (covers a different set of touched pages)." >&2
      return 1
    fi
    if [ "$AGE" -ge "$TTL" ]; then
      echo "❌ $LABEL receipt expired (older than ${TTL}s)." >&2
      return 1
    fi
    if [ "$R_VERDICT" = "BLOCK" ]; then
      echo "❌ $LABEL reported BLOCK — unresolved findings in $RECEIPT. Fix, then re-review." >&2
      return 1
    fi
    return 0
  }

  FAIL=0
  check_receipt ".claude/dev-env-schema-audit-receipt.json" "dev-env-schema-auditor" || FAIL=1
  check_receipt ".claude/dev-env-link-integrity-receipt.json" "dev-env-link-integrity-auditor" || FAIL=1

  if [ "$FAIL" -eq 1 ]; then
    echo "   Notion pages were touched this session with no fresh, passing audit receipts." >&2
    echo "   Invoke dev-env-schema-auditor AND dev-env-link-integrity-auditor; both must write" >&2
    echo "   their receipts (touched_pages_sha=$TOUCHED_SHA) before this task can be marked done." >&2
    exit 2
  fi

  exit 0
fi

# ── Branch 2: no Notion touch, but local files were touched -> require a ───
# ── disposition receipt explaining whether/why Notion needed an update ─────
if has_entries "$FILES_LOG"; then
  FILES_SHA=$(jq -c '[.[].path] | unique | sort' "$FILES_LOG" | shasum -a 256 | cut -d' ' -f1)
  RECEIPT=".claude/dev-env-sync-disposition.json"

  if [ -f "$RECEIPT" ]; then
    R_SHA=$(jq -r '.touched_files_sha // empty' "$RECEIPT" 2>/dev/null)
    R_TIME=$(jq -r '.completed_at_unix // 0' "$RECEIPT" 2>/dev/null)
    R_DISPOSITION=$(jq -r '.disposition // empty' "$RECEIPT" 2>/dev/null)
    R_REASON=$(jq -r '.reason // empty' "$RECEIPT" 2>/dev/null)
    AGE=$((NOW - R_TIME))
    if [ "$R_SHA" = "$FILES_SHA" ] && [ "$AGE" -lt "$TTL" ] && [ -n "$R_DISPOSITION" ] && [ -n "$R_REASON" ]; then
      exit 0   # explained, whichever way — proceed
    fi
  fi

  echo "❌ Local files were changed this session but no matching Notion update was tracked," >&2
  echo "   and no fresh .claude/dev-env-sync-disposition.json explains why." >&2
  echo "   Files touched:" >&2
  jq -r '.[].path' "$FILES_LOG" | sed 's/^/     - /' >&2
  echo "   Before marking this task done, write $RECEIPT with:" >&2
  echo '     { "completed_at_unix": <unix ts>, "touched_files_sha": "'"$FILES_SHA"'",' >&2
  echo '       "disposition": "SYNCED | NOT_NEEDED | DEFERRED", "reason": "<why>" }' >&2
  echo "   - SYNCED: Notion was updated through a path this hook didn't track — say how." >&2
  echo "   - NOT_NEEDED: this work was scratch/exploratory and doesn't belong in Notion — say why." >&2
  echo "   - DEFERRED: Notion should be updated but isn't yet — say what's outstanding and why it's OK to defer." >&2
  exit 2
fi

# ── Branch 3: nothing touched at all ─────────────────────────────────────────
exit 0
