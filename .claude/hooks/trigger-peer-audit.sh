#!/usr/bin/env bash
# trigger-peer-audit.sh — PreToolUse hook (Edit, Write)
# Layer 5 cross-model peer audit before writes to HIGH-risk paths.
# Fires `abstract-data peer-audit` (which uses the claude CLI / your
# subscription, no API key). Exit 2 = BLOCK (audit rejected). Exit 0 = allow.
#
# Env:
#   ABSTRACT_DATA_SKIP_PEER_AUDIT=1  bypass entirely (CI/automation)
# Fail-open: a missing CLI, timeout, or unparseable verdict allows the write.

set -uo pipefail

# ── Bypass in non-interactive / CI contexts ──────────────────────────────────
if [[ "${ABSTRACT_DATA_SKIP_PEER_AUDIT:-0}" == "1" ]]; then exit 0; fi
if [[ -n "${CI:-}" ]] || [[ -n "${GITHUB_ACTIONS:-}" ]] || \
   [[ -n "${BUILDKITE:-}" ]] || [[ -n "${CIRCLECI:-}" ]]; then exit 0; fi

# ── Extract the target file path from the PreToolUse JSON on stdin ────────────
# Claude Code passes {"tool_name": ..., "tool_input": {"file_path": ...}}.
TARGET_FILE=""
if command -v python3 &>/dev/null; then
  TARGET_FILE=$(python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    ti = data.get('tool_input', {}) if isinstance(data, dict) else {}
    print(ti.get('file_path') or ti.get('path') or data.get('file_path') or data.get('path') or '')
except Exception:
    print('')
" 2>/dev/null || echo "")
fi

# No path resolved → nothing to gate, allow.
if [[ -z "$TARGET_FILE" ]]; then exit 0; fi

# ── High-risk path patterns (basename match) ─────────────────────────────────
HIGH_RISK_PATTERNS=(
  "apply.py"
  "apply_pipeline.py"
  "atomic.py"
  "locking.py"
  "lockfile.py"
  "snapshot.py"
  "conflict.py"
)

IS_HIGH_RISK=false
for pattern in "${HIGH_RISK_PATTERNS[@]}"; do
  if [[ "$TARGET_FILE" == *"$pattern"* ]]; then
    IS_HIGH_RISK=true
    break
  fi
done

if [[ "$IS_HIGH_RISK" == "false" ]]; then exit 0; fi

# Without the CLI there is nothing to run — fail open.
if ! command -v abstract-data &>/dev/null; then exit 0; fi

# ── Run the peer audit; first stdout line is the verdict ─────────────────────
VERDICT=$(abstract-data peer-audit 2>/dev/null | head -1 || echo "TIMEOUT")

if [[ "$VERDICT" == "REJECT" ]]; then
  abstract-data peer-audit >&2 2>/dev/null || true
  cat >&2 <<MSG

Layer 5 peer audit REJECTED this write to ${TARGET_FILE}.
Fix the issues above before proceeding.
Bypass with: ABSTRACT_DATA_SKIP_PEER_AUDIT=1
MSG
  exit 2
fi

# APPROVE, TIMEOUT, or anything else → allow (fail-open).
exit 0
