#!/usr/bin/env bash
# agent-config-versioning-gate.sh -- Stop hook
# Blocks completion if .claude/, .cursor/, skills, subagents, agent docs, or plans/
# changed this session without a fresh agent-config-audit-receipt.json.
# Abstract Data enforcement-bundle pattern (Draft, Template Version 1.0.0),
# deployed verbatim per the 2026-07-04 fixed-string-loop rewrite.

set -euo pipefail

RECEIPT=".claude/agent-config-audit-receipt.json"
TTL_SECONDS=14400

changed=$(git diff --name-only HEAD 2>/dev/null; git diff --cached --name-only 2>/dev/null)

touched=""
for pattern in ".claude/skills/" ".claude/agents/" ".cursor/rules/" "AGENTS.md" "GUARDRAILS.md" "TESTING.md" "ARCHITECTURE.md" "plans/"; do
  if echo "$changed" | grep -qF "$pattern"; then
    touched="yes"
    break
  fi
done

if [ -z "$touched" ]; then
  exit 0
fi

if [ ! -f "$RECEIPT" ]; then
  echo "BLOCK: agent-config-versioning-gate -- config/doc files changed but no audit receipt found." 1>&2
  echo "Dispatch agent-config-conformance-auditor via Task tool, then retry." 1>&2
  exit 2
fi

now_ts=$(date +%s)
receipt_ts=$(python3 -c "import json; print(json.load(open('$RECEIPT'))['passed_at_unix'])" 2>/dev/null || echo 0)
age=$(( now_ts - receipt_ts ))

if [ "$age" -gt "$TTL_SECONDS" ]; then
  echo "BLOCK: agent-config-versioning-gate -- receipt is stale." 1>&2
  exit 2
fi

exit 0
