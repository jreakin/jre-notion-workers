#!/usr/bin/env bash
# enforcement-deployment-gate.sh -- Stop hook
# Blocks session completion unless .claude/notion-hook-install-receipt.json exists
# and proves, for every required hook, that the real Notion page was read (not
# guessed) and the real content was deployed (not a stub).

set -euo pipefail

RECEIPT=".claude/notion-hook-install-receipt.json"

if [ ! -f "$RECEIPT" ]; then
  echo "BLOCK: enforcement-deployment-gate -- no .claude/notion-hook-install-receipt.json found." 1>&2
  echo "Run Step 4.7's closing requirement: fetch each required hook from Notion, record proof of the read, deploy it, and record proof of the deployment." 1>&2
  exit 2
fi

python3 - "$RECEIPT" <<'PYEOF'
import json, sys

path = sys.argv[1]
with open(path) as f:
    data = json.load(f)

hooks = data.get("hooks", [])
if not hooks:
    print("BLOCK: enforcement-deployment-gate -- receipt has no hooks recorded.", file=sys.stderr)
    sys.exit(2)

MIN_REAL_BYTES = 200  # a genuine hook script/subagent is never this small; a stub comment is

problems = []
for h in hooks:
    section = h.get("section", "?")
    fname = h.get("file", "?")
    tv = h.get("notion_template_version_read")
    ncl = h.get("notion_content_length")
    present = h.get("deployed_present")
    dbl = h.get("deployed_byte_length")
    wired = h.get("wired_in_settings")

    if not tv:
        problems.append(section + " " + fname + ": no notion_template_version_read recorded -- was Notion actually fetched?")
    if not ncl or ncl < MIN_REAL_BYTES:
        problems.append(section + " " + fname + ": notion_content_length missing or implausibly small (" + str(ncl) + ")")
    if not present:
        problems.append(section + " " + fname + ": not present on disk")
    if not dbl or dbl < MIN_REAL_BYTES:
        problems.append(section + " " + fname + ": deployed_byte_length missing or implausibly small (" + str(dbl) + ") -- looks like a stub, not a real deployment")
    if wired is False:
        problems.append(section + " " + fname + ": not wired in settings.json")

if problems:
    print("BLOCK: enforcement-deployment-gate -- " + str(len(problems)) + " unverified hook(s):", file=sys.stderr)
    for p in problems:
        print("  - " + p, file=sys.stderr)
    sys.exit(2)

if not data.get("all_verified"):
    print("BLOCK: enforcement-deployment-gate -- all_verified is not true despite no per-hook problems found. Recheck.", file=sys.stderr)
    sys.exit(2)

sys.exit(0)
PYEOF
