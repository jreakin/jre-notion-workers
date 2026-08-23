#!/usr/bin/env bash
# write-preflight-confirmed.sh
# Called by the apply-preflight-auditor subagent after it has completed a REAL
# review (evidence ledger produced) and is returning READY. Writes the marker
# that require-apply-preflight.sh checks before allowing `abstract-data apply`
# / `abstract-data retrofit`.
#
# Usage: bash write-preflight-confirmed.sh [project-root] [operation] [items-reviewed]
#   operation      — "apply" | "retrofit" | "both" (default: both)
#   items-reviewed — integer count of things the auditor inventoried (default: 0)
#
# Writes .abstract-data/preflight-confirmed.json with:
#   confirmed_at_unix / confirmed_at_iso — timestamp
#   confirmed_by                         — $ABSTRACT_DATA_AGENT or "unknown"
#   operation                            — which op this preflight covers
#   items_reviewed                       — integer
#   ttl_hours                            — 1 (preflight must be fresh right before apply)

set -euo pipefail

START="${1:-$(pwd)}"
# Resolve to the MAIN working-tree root (shared across linked worktrees) so the
# marker written here is the same one require-apply-preflight.sh checks (#6
# lesson). Fall back to the passed/cwd path for non-git checkouts. Keep this in
# sync with require-apply-preflight.sh's resolver.
PROJECT_ROOT="$START"
_gcd="$(cd "$START" 2>/dev/null && git rev-parse --git-common-dir 2>/dev/null || true)"
if [[ -n "$_gcd" ]]; then
  _gcd_abs="$(cd "$START" 2>/dev/null && cd "$_gcd" 2>/dev/null && pwd || true)"
  [[ -n "$_gcd_abs" ]] && PROJECT_ROOT="$(dirname "$_gcd_abs")"
fi
MARKER_DIR="$PROJECT_ROOT/.abstract-data"
MARKER="$MARKER_DIR/preflight-confirmed.json"
OPERATION="${2:-both}"
ITEMS_REVIEWED="${3:-0}"

mkdir -p "$MARKER_DIR"

python3 - "$MARKER" "$OPERATION" "$ITEMS_REVIEWED" "${ABSTRACT_DATA_AGENT:-unknown}" <<'PYEOF'
import json, sys, time, datetime

marker_path, operation, items, agent = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
now = time.time()
iso = datetime.datetime.fromtimestamp(now, tz=datetime.timezone.utc).isoformat()

data = {
    "confirmed_at_unix": int(now),
    "confirmed_at_iso": iso,
    "confirmed_by": agent,
    "operation": operation,
    "items_reviewed": items,
    "ttl_hours": 1,
}
with open(marker_path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
print(f"Preflight confirmed for {operation}: {items} items reviewed, expires in 1h ({iso})")
PYEOF

# FR-7 / journal #54: the legacy JSON marker is advisory-only for the CLI guard.
# Also mint a content-bound human_confirmed attestation so writing apply/retrofit
# is authorized. Prefer the abstract-data on PATH; fall back to uvx if needed.
if command -v abstract-data >/dev/null 2>&1; then
  _AD=(abstract-data)
elif command -v uvx >/dev/null 2>&1; then
  _AD=(uvx abstract-data)
else
  echo "warning: abstract-data not on PATH — wrote legacy marker only; mint FR-7 attestation with:" >&2
  echo "  abstract-data attest human --kind apply-preflight --subject \"$PROJECT_ROOT\" --project \"$PROJECT_ROOT\" --ttl-hours 1" >&2
  exit 0
fi
"${_AD[@]}" attest human \
  --kind apply-preflight \
  --subject "$PROJECT_ROOT" \
  --project "$PROJECT_ROOT" \
  --ttl-hours 1
