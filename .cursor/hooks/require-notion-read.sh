#!/usr/bin/env bash
# require-notion-read.sh — PreToolUse hook (Edit, Write)
# Blocks file writes until the agent has confirmed reading all Notion context
# for this project. Session-scoped (8h TTL). Bypassable in CI.
#
# Exit codes: 0 = allow, 2 = block (Claude Code BLOCK severity)
# Reads: .abstract-data/session-confirmed.json
# Env:   ABSTRACT_DATA_SKIP_READ_CONFIRM=1 to bypass (CI/automation)
#        ABSTRACT_DATA_READ_CONFIRM_TTL_HOURS to override TTL (default: 8)

set -euo pipefail

# ── Bypass in non-interactive / CI contexts ──────────────────────────────────
if [[ "${ABSTRACT_DATA_SKIP_READ_CONFIRM:-0}" == "1" ]]; then
  exit 0
fi
# Detect common CI environments
if [[ -n "${CI:-}" ]] || [[ -n "${GITHUB_ACTIONS:-}" ]] || \
   [[ -n "${BUILDKITE:-}" ]] || [[ -n "${CIRCLECI:-}" ]]; then
  exit 0
fi

# ── Locate project root ──────────────────────────────────────────────────────
# Prefer the MAIN working-tree root (shared across linked git worktrees) so one
# confirmation covers the whole repo instead of re-tripping in every worktree
# under .claude/worktrees/ (#6). Resolve it from git's common dir; fall back to
# walking up from cwd for non-git checkouts. Must match write-session-confirmed.sh.
PROJECT_ROOT=""
_gcd="$(git rev-parse --git-common-dir 2>/dev/null || true)"
if [[ -n "$_gcd" ]]; then
  _gcd_abs="$(cd "$_gcd" 2>/dev/null && pwd || true)"
  if [[ -n "$_gcd_abs" ]]; then
    _main_root="$(dirname "$_gcd_abs")"
    [[ -d "$_main_root/.abstract-data" ]] && PROJECT_ROOT="$_main_root"
  fi
fi
if [[ -z "$PROJECT_ROOT" ]]; then
  SEARCH_DIR="$(pwd)"
  while [[ "$SEARCH_DIR" != "/" ]]; do
    if [[ -d "$SEARCH_DIR/.abstract-data" ]]; then
      PROJECT_ROOT="$SEARCH_DIR"
      break
    fi
    SEARCH_DIR="$(dirname "$SEARCH_DIR")"
  done
fi

# No .abstract-data/ means abstract-data apply hasn't run — allow silently.
# (Don't block projects that haven't opted in yet.)
if [[ -z "$PROJECT_ROOT" ]]; then
  exit 0
fi

LOCKFILE="$PROJECT_ROOT/.abstract-data/lockfile.toml"
MARKER="$PROJECT_ROOT/.abstract-data/session-confirmed.json"
TTL_HOURS="${ABSTRACT_DATA_READ_CONFIRM_TTL_HOURS:-8}"
TTL_SECONDS=$(( TTL_HOURS * 3600 ))

# ── Check lockfile exists (apply has run) ────────────────────────────────────
if [[ ! -f "$LOCKFILE" ]]; then
  exit 0
fi

# ── Check marker freshness ───────────────────────────────────────────────────
if [[ -f "$MARKER" ]]; then
  if command -v python3 &>/dev/null; then
    MARKER_AGE=$(python3 -c "
import json, time, sys
try:
    data = json.load(open('$MARKER'))
    confirmed_at = data.get('confirmed_at_unix', 0)
    age = time.time() - confirmed_at
    print(int(age))
except Exception:
    print(99999)
")
    if (( MARKER_AGE < TTL_SECONDS )); then
      # ── Staleness warning (non-blocking) ─────────────────────────────────
      # Session marker is fresh, but warn if the Notion cache is out of sync
      # with what was applied. The agent reads local files — if Notion content
      # changed since the last pull+apply, the reading may be stale.
      if command -v abstract-data &>/dev/null; then
        STALE_ITEMS=$(abstract-data status --json 2>/dev/null | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    # status --json returns a list for --all, single object otherwise
    if isinstance(d,list): d=d[0] if d else {}
    print(int(d.get('stale_items',0)))
except: print(0)
" 2>/dev/null || echo "0")
        if (( STALE_ITEMS > 0 )); then
          cat >&2 <<WARN
⚠  Notion cache is stale ($STALE_ITEMS item(s) changed in Notion since last apply).
   Your reading confirmation will cover the currently-deployed versions, not the
   latest Notion content. To read current content first:
     abstract-data pull && abstract-data apply
   Then re-run /notion-read-confirm.
WARN
        fi
      fi
      exit 0  # Fresh confirmation — allow (staleness is a warning, not a block)
    fi
  fi
fi

# ── Block ────────────────────────────────────────────────────────────────────
cat >&2 <<'MSG'
╔══════════════════════════════════════════════════════════════════════╗
║  NOTION READING CONFIRMATION REQUIRED                                ║
║                                                                      ║
║  You must confirm you have read all Notion dev environment context   ║
║  for this project before writing any files.                          ║
║                                                                      ║
║  Run the notion-read-confirm skill:                                  ║
║    → Type: /notion-read-confirm                                      ║
║    → Or invoke the skill inline if no slash command is registered    ║
║                                                                      ║
║  To bypass in automation: ABSTRACT_DATA_SKIP_READ_CONFIRM=1          ║
╚══════════════════════════════════════════════════════════════════════╝
MSG
exit 2
