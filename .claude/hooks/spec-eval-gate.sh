#!/bin/bash
# PreToolUse hook: gate spec -> plan on the four-lens spec-eval panel.
# Project: abstract-data
# Tool: ExitPlanMode, Write, Edit, MultiEdit, mcp__abstract-data__abstract_data_create_plan
# Severity: BLOCK (exit 2) on the hard write + MCP seams; warn-only on ExitPlanMode.
#
# Thin wrapper around `abstract-data spec-eval check` (all real logic lives in
# tested Python). Threat model (deliberate): the attestation marker is
# agent-writable, so this stops lazy-skip / assert-without-running, NOT a
# hand-forged marker. Two disclosed fail-open residuals: the CLI being absent,
# and no spec binding to the plan (the MCP seam is the exception — a missing
# spec there BLOCKs). The command is fixed: no env override / off-switch.

set -euo pipefail

INPUT=$(cat)
TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')
FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty')
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"

# Run `abstract-data spec-eval check` with the given args and translate its exit
# code into the hook contract:
#   0            -> pass / warn / fail-open (allow)
#   2            -> gate BLOCK (surface stderr, deny)
#   anything else-> internal CLI error -> fail open + warn (never a false block)
# The CLI being absent is itself a disclosed fail-open (allow).
run_check() {
  if ! command -v abstract-data >/dev/null 2>&1; then
    exit 0
  fi
  set +e
  out=$(abstract-data spec-eval check --project "$PROJECT_DIR" "$@" 2>&1)
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    exit 0
  elif [[ "$rc" -eq 2 ]]; then
    printf '%s\n' "$out" >&2
    exit 2
  else
    printf 'spec-eval-gate: internal check error (exit %s), failing open\n' "$rc" >&2
    printf '%s\n' "$out" >&2
    exit 0
  fi
}

case "$TOOL_NAME" in
  ExitPlanMode)
    run_check --plan-mode-exit
    ;;
  mcp__abstract-data__abstract_data_create_plan)
    # Legacy specify wrote root SPEC.md. ADR-0060 durable specs live under
    # docs/specs/; Notion create_plan is gated warn-only when SPEC.md is absent
    # (git plan writes still hard-gate via Write/Edit on docs/plans/**/PLAN.md).
    if [[ -f "$PROJECT_DIR/SPEC.md" ]]; then
      run_check --spec "$PROJECT_DIR/SPEC.md"
    else
      run_check --plan-mode-exit
    fi
    ;;
  Write | Edit | MultiEdit)
    # Path-filter in shell BEFORE spawning Python: ADR-0060 plan files + legacy.
    case "$FILE_PATH" in
      *docs/plans/*/PLAN.md | *docs/plans/*/plan.md | *docs/superpowers/plans/*.md)
        run_check --plan "$FILE_PATH"
        ;;
      *)
        exit 0
        ;;
    esac
    ;;
  *)
    exit 0
    ;;
esac
