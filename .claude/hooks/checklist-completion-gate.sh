#!/usr/bin/env bash
# checklist-completion-gate.sh -- Stop hook
# Blocks session completion unless .claude/checklist-completion-receipt.json exists,
# has internally consistent item counts, and has zero unresolved open_gaps.

set -euo pipefail

RECEIPT=".claude/checklist-completion-receipt.json"

if [ ! -f "$RECEIPT" ]; then
  echo "BLOCK: checklist-completion-gate -- no .claude/checklist-completion-receipt.json found." 1>&2
  echo "Run Step 7.0 of project-alignment: walk references/validation-checklist.md in full and write the receipt." 1>&2
  exit 2
fi

python3 - "$RECEIPT" <<'PYEOF'
import json, sys

path = sys.argv[1]
with open(path) as f:
    data = json.load(f)

items_total = data.get("items_total")
dispositions = data.get("dispositions", {})
open_gaps = data.get("open_gaps", [])

if items_total is None:
    print("BLOCK: checklist-completion-gate -- receipt missing items_total.", file=sys.stderr)
    sys.exit(2)

if len(dispositions) != items_total:
    print(
        "BLOCK: checklist-completion-gate -- items_total says " + str(items_total) +
        " but dispositions has " + str(len(dispositions)) + " entries. Every item must be dispositioned.",
        file=sys.stderr,
    )
    sys.exit(2)

if open_gaps:
    print(
        "BLOCK: checklist-completion-gate -- " + str(len(open_gaps)) + " unresolved open_gaps in the receipt.",
        file=sys.stderr,
    )
    for gap in open_gaps:
        print("  - " + str(gap), file=sys.stderr)
    sys.exit(2)

sys.exit(0)
PYEOF
