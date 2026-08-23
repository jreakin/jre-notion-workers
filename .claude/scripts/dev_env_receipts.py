#!/usr/bin/env python3
"""
dev_env_receipts.py — self-contained Notion read-receipt ledger for project-alignment.

Bundled with the project-alignment skill (not fetched from an external CLI). Deployed by
the skill into every audited project as `.claude/scripts/dev_env_receipts.py`, invoked by
`.claude/hooks/require-notion-read.sh` (PreToolUse gate) and
`.claude/hooks/record-notion-read.sh` (PostToolUse recorder).

Stdlib only — no pip install required. Python 3.9+.

Ledger location (auto-detected, first match wins):
  1. .abstract-data/dev-env-read-receipts.json   (if .abstract-data/ already exists —
     keeps existing Abstract Data projects on their current path)
  2. .claude/state/dev-env-read-receipts.json    (default for every other project)

Categories (fixed, matches project-alignment's Step 0.1b table):
  dev-env-index, subagents, hooks, setup-templates, playbooks, skills

Usage:
  dev_env_receipts.py record --category=hooks --item-count=3 --source-id=<page-or-collection-id> [--source-id=...]
  dev_env_receipts.py record-from-hook          # reads a Claude Code PostToolUse hook JSON payload on stdin
  dev_env_receipts.py check [--json] [--ttl-seconds=28800]
  dev_env_receipts.py status                    # human-readable box, same categories every time
"""

import json
import os
import re
import sys
import time
import argparse

CATEGORIES = ["dev-env-index", "subagents", "hooks", "setup-templates", "playbooks", "skills"]

DEFAULT_TTL_SECONDS = 28800  # 8 hours — matches the skill's existing session-confirmed TTL

# Grounded against the live Abstract Data Notion hub on 2026-07-04. If a page moves, update
# the IDs here — the skill's own Step 0 Notion Freshness Check (P0.1-P0.4) is what's meant
# to catch that drift; this manifest doesn't self-heal.
MANIFEST = {
    "dev-env-index": {
        "page_ids": ["3617d7f56298814899f2d14b8f1e5145"],
    },
    "setup-templates-db": {
        # Setup Templates DB. The specific category (subagents / hooks / setup-templates)
        # is decided by the page's own "Document Type" property, checked at record time.
        # Both "Agent Config" (older pages) and "Subagent" (task-critic.md v1.1.0+,
        # post-alignment-code-conformance-reviewer.md, and any future Subagent-type page)
        # credit the "subagents" category — confirmed via live fetch 2026-07-04 that this
        # workspace uses both values for the same conceptual category. A prior version of
        # this classifier only checked "Agent Config" and silently miscategorized Subagent
        # pages as setup-templates; confirmed by test, fixed here.
        "collection_ids": ["2f47d7f5-6298-80bf-b6df-000b7c168543"],
    },
    "playbooks": {
        # Reference Documentation DB
        "collection_ids": ["69c7d7f5-6298-8202-b15c-07d31ec0d230"],
    },
    "skills": {
        # Agent Skills DB
        "collection_ids": ["d22fe5bc-922a-4872-9859-99318bf98b61"],
    },
}


def ledger_path():
    if os.path.isdir(".abstract-data"):
        return os.path.join(".abstract-data", "dev-env-read-receipts.json")
    os.makedirs(os.path.join(".claude", "state"), exist_ok=True)
    return os.path.join(".claude", "state", "dev-env-read-receipts.json")


def load_ledger():
    path = ledger_path()
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


def save_ledger(ledger):
    path = ledger_path()
    with open(path, "w") as f:
        json.dump(ledger, f, indent=2, sort_keys=True)
        f.write("\n")


def record(category, item_count, source_ids):
    if category not in CATEGORIES:
        print(f"ERROR: unknown category '{category}'. Must be one of {CATEGORIES}", file=sys.stderr)
        return 1
    ledger = load_ledger()
    entry = ledger.get(category, {"item_count": 0, "source_ids": []})
    now_source_ids = sorted(set(entry.get("source_ids", []) + list(source_ids)))
    ledger[category] = {
        "fetched_at_unix": time.time(),
        "item_count": max(item_count, entry.get("item_count", 0)),
        "source_ids": now_source_ids,
    }
    save_ledger(ledger)
    print(f"OK: recorded '{category}' ({len(now_source_ids)} source(s) tracked)")
    return 0


def classify_from_response_text(tool_name, text):
    """Best-effort categorization from a Notion MCP tool response body.

    Returns a category name, or None if the response doesn't look like a Notion
    fetch/search/query result we recognize (e.g. a "self"/user-identity lookup).
    """
    if not re.search(r"notion-(fetch|search|query-data-sources)", tool_name or ""):
        return None

    for page_id in MANIFEST["dev-env-index"]["page_ids"]:
        if page_id in text:
            return "dev-env-index"

    if any(cid in text for cid in MANIFEST["setup-templates-db"]["collection_ids"]):
        # JSON re-serialization escapes embedded quotes (\"Document Type\":\"Hook Config\"),
        # so match on the value tokens directly rather than anchoring tightly to the
        # "Document Type" label with a no-quotes-allowed gap.
        if re.search(r"Hook\s*Config", text, re.IGNORECASE):
            return "hooks"
        if re.search(r"Agent\s*Config", text, re.IGNORECASE) or re.search(r"\bSubagent\b", text, re.IGNORECASE):
            return "subagents"
        return "setup-templates"

    if any(cid in text for cid in MANIFEST["playbooks"]["collection_ids"]):
        return "playbooks"

    if any(cid in text for cid in MANIFEST["skills"]["collection_ids"]):
        return "skills"

    return None


def extract_source_id(text):
    m = re.search(r'"url"\s*:\s*"([^"]+)"', text)
    if m:
        return m.group(1)
    m = re.search(r'<page url="([^"]+)"', text)
    if m:
        return m.group(1)
    return "unknown-source"


def record_from_hook():
    """Read a Claude Code PostToolUse hook payload from stdin and record a receipt.

    Hook payload shape (per Claude Code hooks spec): a JSON object containing at least
    `tool_name` and `tool_response`. We don't trust the agent's framing of what it fetched —
    we look at the actual response body Notion returned.
    """
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        print("record-from-hook: no valid JSON on stdin, nothing recorded", file=sys.stderr)
        return 0  # don't block the tool call over a parse issue — this is a recorder, not a gate

    tool_name = payload.get("tool_name", "")
    response = payload.get("tool_response", "")
    if isinstance(response, dict):
        response_text = json.dumps(response)
    else:
        response_text = str(response)

    category = classify_from_response_text(tool_name, response_text)
    if category is None:
        # Not a recognized category fetch (e.g. a Notion search over unrelated content,
        # or a "self" identity lookup) — not an error, just nothing to record.
        return 0

    source_id = extract_source_id(response_text)
    return record(category, item_count=1, source_ids=[source_id])


def check(ttl_seconds, as_json):
    ledger = load_ledger()
    now = time.time()
    results = {}
    all_pass = True
    for cat in CATEGORIES:
        entry = ledger.get(cat)
        if not entry:
            results[cat] = {"status": "MISSING", "age_seconds": None, "item_count": 0}
            all_pass = False
            continue
        age = now - entry.get("fetched_at_unix", 0)
        if age > ttl_seconds:
            results[cat] = {"status": "STALE", "age_seconds": int(age), "item_count": entry.get("item_count", 0)}
            all_pass = False
        else:
            results[cat] = {"status": "FRESH", "age_seconds": int(age), "item_count": entry.get("item_count", 0)}

    if as_json:
        print(json.dumps({"pass": all_pass, "categories": results}, indent=2))
    else:
        print_status_box(results, all_pass)

    return 0 if all_pass else 1


def print_status_box(results, all_pass):
    print("📖 Dev-Env Read-Receipt Summary")
    print("──────────────────────────────────")
    for cat in CATEGORIES:
        r = results[cat]
        if r["status"] == "FRESH":
            mins = r["age_seconds"] // 60
            print(f"  {cat:<17} ✅ fetched {mins}m ago — {r['item_count']} item(s)")
        elif r["status"] == "STALE":
            mins = r["age_seconds"] // 60
            print(f"  {cat:<17} ⚠  STALE — last fetched {mins}m ago")
        else:
            print(f"  {cat:<17} ❌ not fetched")
    print("──────────────────────────────────")
    print(f"  Result: {'PASS' if all_pass else 'BLOCKED — see categories above'}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_record = sub.add_parser("record")
    p_record.add_argument("--category", required=True, choices=CATEGORIES)
    p_record.add_argument("--item-count", type=int, default=1)
    p_record.add_argument("--source-id", action="append", default=[])

    sub.add_parser("record-from-hook")

    p_check = sub.add_parser("check")
    p_check.add_argument("--json", action="store_true")
    p_check.add_argument("--ttl-seconds", type=int, default=DEFAULT_TTL_SECONDS)

    sub.add_parser("status")

    args = parser.parse_args()

    if args.command == "record":
        return record(args.category, args.item_count, args.source_id)
    if args.command == "record-from-hook":
        return record_from_hook()
    if args.command == "check":
        return check(args.ttl_seconds, args.json)
    if args.command == "status":
        return check(DEFAULT_TTL_SECONDS, as_json=False)
    return 1


if __name__ == "__main__":
    sys.exit(main())
