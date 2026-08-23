#!/bin/bash
# Cursor afterFileEdit hook: WARN-ONLY spec-eval backstop.
# Project: abstract-data
# Tool: Cursor `afterFileEdit`
# Severity: WARN only — NEVER blocks (exit 0 always).
#
# Cursor has no pre-write block event, so the spec-eval gate cannot deny an edit
# there. This post-write hook instead surfaces an advisory when a `plans/*.md`
# file was just edited but its bound spec has not passed the four-lens panel. It
# is a thin wrapper around `abstract-data spec-eval check --plan`; a gate BLOCK
# (exit 2) from the CLI is downgraded to an advisory here and still exits 0.
#
# Threat model (deliberate): the attestation marker is agent-writable — this
# nudges against lazy-skip / assert-without-running, not a hand-forged marker.
# Fail-open residuals (CLI absent, no spec bound) are intentional. The command is
# fixed: no env override / off-switch.

set -euo pipefail

INPUT=$(cat)
# Cursor's afterFileEdit payload carries the edited path at `.file_path`; tolerate
# the Claude-style `.tool_input.file_path` too so the same script is portable.
FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.file_path // .tool_input.file_path // empty')
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"

# Plan files under docs/plans/**/PLAN.md (ADR-0060) or legacy docs/superpowers/plans/.
case "$FILE_PATH" in
  *docs/plans/*/PLAN.md | *docs/plans/*/plan.md | *docs/superpowers/plans/*.md) ;;
  *) exit 0 ;;
esac

# CLI absent -> disclosed fail-open (silent allow).
if ! command -v abstract-data >/dev/null 2>&1; then
  exit 0
fi

set +e
out=$(abstract-data spec-eval check --project "$PROJECT_DIR" --plan "$FILE_PATH" 2>&1)
rc=$?
set -e

# WARN-ONLY: a non-zero CLI exit (a real BLOCK, or an internal error) is surfaced
# as an advisory and the hook still exits 0 — afterFileEdit is post-write, so
# blocking is pointless and could never be correct.
if [[ "$rc" -ne 0 ]]; then
  printf 'spec-eval (warn): %s edits a plan whose spec has not passed the four-lens panel.\n' "$FILE_PATH" >&2
  printf 'Run the spec-eval skill and `abstract-data spec-eval attest` before relying on this plan.\n' >&2
  printf '%s\n' "$out" >&2
fi
exit 0
