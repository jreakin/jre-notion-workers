#!/usr/bin/env bash
# verify-completion.sh — repo completion gate (wired as a Stop hook).
#
# Two jobs, in order:
#   1. Keep the enforcement-gate ledger persistent. The gate writes to
#      .claude/state/, which is gitignored and gets cleaned by the GitButler
#      worktree between turns — wiping the task-critic verdict. We relocate the
#      ledger to a stable store OUTSIDE the worktree and restore the symlink here,
#      every turn-end, BEFORE gate.py stop-check reads it.
#   2. Run this repo's checks and record failures into the ledger so the
#      loop-closure gate can refuse to end the turn on an undisposed failure.
#
# ALWAYS exits 0 — the BLOCK is enforced by gate.py reading the ledger.
set -uo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
GATE="$PROJECT_DIR/.claude/hooks/gate.py"
# Fall back to the machine-global gate (~/.claude/hooks/gate.py) so a deployed
# project (which gets no local gate.py) still feeds the global enforcement gate.
[ -f "$GATE" ] || GATE="$HOME/.claude/hooks/gate.py"
[ -f "$GATE" ] || exit 0  # gate not installed anywhere; nothing to enforce

# ── 1. Persist the gate ledger outside the worktree ──────────────────────────
STORE_BASE="$HOME/.local/state/abstract-data-gate"
STORE_KEY="$(printf '%s' "$PROJECT_DIR" | shasum 2>/dev/null | cut -c1-12)"
STORE="$STORE_BASE/${STORE_KEY:-default}"
STATE="$PROJECT_DIR/.claude/state"
mkdir -p "$STORE" 2>/dev/null || true
if [ -d "$STATE" ] && [ ! -L "$STATE" ]; then
  # A real dir means GitButler removed our symlink and the gate wrote here this
  # turn — migrate those ledgers into the persistent store, then re-link.
  cp "$STATE"/*.json "$STORE"/ 2>/dev/null || true
  find "$STATE" -type f -delete 2>/dev/null || true
  rmdir "$STATE" 2>/dev/null || true
fi
[ -e "$STATE" ] || ln -s "$STORE" "$STATE" 2>/dev/null || true

# Read session_id from the Stop payload so our records land in the ledger
# gate.py stop-check reads (it keys the ledger by session_id).
PAYLOAD="$(cat 2>/dev/null || true)"
SESSION_ID="$(
  printf '%s' "$PAYLOAD" | python3 -c 'import sys, json
try:
    print(json.load(sys.stdin).get("session_id", ""))
except Exception:
    print("")' 2>/dev/null || true
)"

rec() {  # rec <check-name> <failed|skipped> <detail>
  python3 "$GATE" record-failure --check "$1" --status "$2" --detail "$3" \
    ${SESSION_ID:+--session "$SESSION_ID"} >/dev/null 2>&1 || true
}

cd "$PROJECT_DIR" 2>/dev/null || exit 0

# ── 2. Repo checks (tsc + bun test in the app package) ───────────────────────
APP="$PROJECT_DIR/jre-notion-workers"
CHANGED_RAW="$(
  { git diff --name-only HEAD 2>/dev/null; \
    git ls-files --others --exclude-standard 2>/dev/null; } \
  | grep -E '\.(ts|tsx)$' | sort -u
)"
EXIST=()
while IFS= read -r f; do
  [ -n "$f" ] && [ -f "$f" ] && EXIST+=("$f")
done <<< "$CHANGED_RAW"

TASK_MD="$PROJECT_DIR/TASK.md"

RUN_REPO_CHECKS=0
if [ "${#EXIST[@]}" -gt 0 ] || [ -f "$TASK_MD" ] || [ "${VERIFY_COMPLETION_FULL:-0}" = "1" ]; then
  RUN_REPO_CHECKS=1
fi

if [ "$RUN_REPO_CHECKS" -eq 0 ]; then
  exit 0
fi

if [ -d "$APP" ]; then
  if ! (cd "$APP" && bun run check >/dev/null 2>&1); then
    rec tsc failed "bun run check (tsc --noEmit) failed in jre-notion-workers/"
  fi
  if [ -f "$TASK_MD" ] || [ "${VERIFY_COMPLETION_FULL:-0}" = "1" ]; then
    if ! (cd "$APP" && bun test tests/unit >/dev/null 2>&1); then
      rec bun-test failed "bun test tests/unit failed in jre-notion-workers/"
    fi
  fi
fi

exit 0
