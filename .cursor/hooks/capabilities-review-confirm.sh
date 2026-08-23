#!/usr/bin/env bash
# capabilities-review-confirm.sh — SessionStart hook
# Surfaces the auto-generated capabilities inventory (.agents/CAPABILITIES.md)
# at the start of a session so the agent reviews available tools before a run.
#
# Two modes:
#   Default (reminder)  — print a summary of the inventory and exit 0.
#   Hard block          — when ABSTRACT_DATA_REQUIRE_CAP_REVIEW=1, require a
#                         fresh confirmation marker
#                         (.abstract-data/capabilities-reviewed.json); block
#                         (exit 2) until it exists. Same marker pattern as
#                         notion-read-confirm / write-session-confirmed.sh.
#
# Exit codes: 0 = allow, 2 = block (Claude Code BLOCK severity).
# Env:  ABSTRACT_DATA_REQUIRE_CAP_REVIEW=1   opt-in hard-block mode
#       ABSTRACT_DATA_SKIP_CAP_REVIEW=1      bypass entirely (CI/automation)
#       ABSTRACT_DATA_CAP_REVIEW_TTL_HOURS   marker TTL (default: 8)

set -euo pipefail

# ── Bypass in non-interactive / CI contexts ──────────────────────────────────
if [[ "${ABSTRACT_DATA_SKIP_CAP_REVIEW:-0}" == "1" ]]; then
  exit 0
fi
if [[ -n "${CI:-}" ]] || [[ -n "${GITHUB_ACTIONS:-}" ]] || \
   [[ -n "${BUILDKITE:-}" ]] || [[ -n "${CIRCLECI:-}" ]]; then
  exit 0
fi

# ── Locate project root ──────────────────────────────────────────────────────
# Prefer the MAIN working-tree root (shared across linked git worktrees) so one
# review covers the whole repo; fall back to walking up from cwd. Keep in sync
# with write-session-confirmed.sh / require-notion-read.sh resolvers.
PROJECT_ROOT=""
_gcd="$(git rev-parse --git-common-dir 2>/dev/null || true)"
if [[ -n "$_gcd" ]]; then
  _gcd_abs="$(cd "$_gcd" 2>/dev/null && pwd || true)"
  if [[ -n "$_gcd_abs" ]]; then
    _main_root="$(dirname "$_gcd_abs")"
    [[ -e "$_main_root/.agents/CAPABILITIES.md" ]] && PROJECT_ROOT="$_main_root"
  fi
fi
if [[ -z "$PROJECT_ROOT" ]]; then
  SEARCH_DIR="$(pwd)"
  while [[ "$SEARCH_DIR" != "/" ]]; do
    if [[ -e "$SEARCH_DIR/.agents/CAPABILITIES.md" ]]; then
      PROJECT_ROOT="$SEARCH_DIR"
      break
    fi
    SEARCH_DIR="$(dirname "$SEARCH_DIR")"
  done
fi
# Fall back to cwd so we can still emit a gentle note even before the inventory
# has been generated.
[[ -z "$PROJECT_ROOT" ]] && PROJECT_ROOT="$(pwd)"

INVENTORY="$PROJECT_ROOT/.agents/CAPABILITIES.md"
MARKER="$PROJECT_ROOT/.abstract-data/capabilities-reviewed.json"

# ── No inventory yet: nothing to review — allow silently ─────────────────────
if [[ ! -f "$INVENTORY" ]]; then
  exit 0
fi

# ── Surface a short summary of the inventory ─────────────────────────────────
cat >&2 <<MSG
──────────────────────────────────────────────────────────────────────
CAPABILITIES INVENTORY — review before proceeding
  $INVENTORY
──────────────────────────────────────────────────────────────────────
MSG
# First ~15 non-blank lines as a preview (headings + first rows).
grep -v '^[[:space:]]*$' "$INVENTORY" 2>/dev/null | head -15 >&2 || true

# ── Default: reminder only ───────────────────────────────────────────────────
if [[ "${ABSTRACT_DATA_REQUIRE_CAP_REVIEW:-0}" != "1" ]]; then
  exit 0
fi

# ── Hard-block mode: require a fresh confirmation marker ──────────────────────
TTL_HOURS="${ABSTRACT_DATA_CAP_REVIEW_TTL_HOURS:-8}"
TTL_SECONDS=$(( TTL_HOURS * 3600 ))
if [[ -f "$MARKER" ]] && command -v python3 &>/dev/null; then
  MARKER_AGE=$(python3 -c "
import json, time
try:
    data = json.load(open('$MARKER'))
    print(int(time.time() - data.get('confirmed_at_unix', 0)))
except Exception:
    print(99999)
")
  if (( MARKER_AGE < TTL_SECONDS )); then
    exit 0
  fi
fi

cat >&2 <<'BLOCK'
╔══════════════════════════════════════════════════════════════════════╗
║  CAPABILITIES REVIEW REQUIRED                                         ║
║                                                                      ║
║  Review .agents/CAPABILITIES.md and confirm before this session      ║
║  proceeds (ABSTRACT_DATA_REQUIRE_CAP_REVIEW=1 is set).                ║
║                                                                      ║
║  Write .abstract-data/capabilities-reviewed.json with a              ║
║  {"confirmed_at_unix": <epoch>} field once reviewed.                 ║
║                                                                      ║
║  To bypass in automation: ABSTRACT_DATA_SKIP_CAP_REVIEW=1            ║
╚══════════════════════════════════════════════════════════════════════╝
BLOCK
exit 2
