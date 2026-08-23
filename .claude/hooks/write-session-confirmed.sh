#!/usr/bin/env bash
# write-session-confirmed.sh
# Called by notion-read-confirm skill after reading confirmation is complete.
# Usage: bash write-session-confirmed.sh [project-root] [items-confirmed] [cache-stale]
#
# Writes .abstract-data/session-confirmed.json with:
#   confirmed_at_unix       — epoch seconds
#   confirmed_at_iso        — ISO-8601 for humans
#   confirmed_by            — value of $ABSTRACT_DATA_AGENT env var or "unknown"
#   items_confirmed         — integer count from first arg
#   cache_stale_at_confirm  — true if the 3rd arg is "1"/"true" (read against stale cache)

set -euo pipefail

START="${1:-$(pwd)}"
# Resolve to the MAIN working-tree root (shared across linked worktrees) so the
# marker written here is the same one require-notion-read.sh checks (#6). Fall
# back to the passed/cwd path for non-git checkouts. Keep this in sync with
# require-notion-read.sh's resolver.
PROJECT_ROOT="$START"
_gcd="$(cd "$START" 2>/dev/null && git rev-parse --git-common-dir 2>/dev/null || true)"
if [[ -n "$_gcd" ]]; then
  _gcd_abs="$(cd "$START" 2>/dev/null && cd "$_gcd" 2>/dev/null && pwd || true)"
  [[ -n "$_gcd_abs" ]] && PROJECT_ROOT="$(dirname "$_gcd_abs")"
fi
MARKER_DIR="$PROJECT_ROOT/.abstract-data"
MARKER="$MARKER_DIR/session-confirmed.json"
ITEMS_CONFIRMED="${2:-0}"
CACHE_STALE="${3:-0}"

mkdir -p "$MARKER_DIR"

python3 - "$MARKER" "$ITEMS_CONFIRMED" "${ABSTRACT_DATA_AGENT:-unknown}" "$CACHE_STALE" <<'PYEOF'
import json, sys, time, datetime

marker_path = sys.argv[1]
items = int(sys.argv[2])
agent = sys.argv[3]
cache_stale = sys.argv[4] in ("1", "true", "True")
now = time.time()
iso = datetime.datetime.fromtimestamp(now, tz=datetime.timezone.utc).isoformat()

data = {
    "confirmed_at_unix": int(now),
    "confirmed_at_iso": iso,
    "confirmed_by": agent,
    "items_confirmed": items,
    "ttl_hours": 8,
    "cache_stale_at_confirm": cache_stale,
}
with open(marker_path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
print(f"Session confirmed: {items} items, expires in 8h ({iso})")
PYEOF
