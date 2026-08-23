#!/usr/bin/env bash
# backfill-telemetry.sh — SessionEnd hook (Claude Code only; manifest ide_support=['claude'])
# When the agent finishes, backfill tool-usage telemetry (capped at the 50 most-recent
# sessions) and harvest gate ledgers into gate_outcomes. Runs silently; never blocks session end.
#
# SessionEnd hooks MUST exit 0 — any non-zero exit causes Claude Code to retry.
# This hook always exits 0.

set -uo pipefail

# Skip if abstract-data is not installed.
if ! command -v abstract-data &>/dev/null; then
  exit 0
fi

# Opt-out switch.
if [[ "${ABSTRACT_DATA_SKIP_TELEMETRY_BACKFILL:-0}" == "1" ]]; then
  exit 0
fi

# Walk up to find the project root.
PROJECT_ROOT=""
SEARCH_DIR="$(pwd)"
while [[ "$SEARCH_DIR" != "/" ]]; do
  if [[ -f "$SEARCH_DIR/pyproject.toml" ]] || \
     [[ -f "$SEARCH_DIR/package.json" ]] || \
     [[ -d "$SEARCH_DIR/.git" ]]; then
    PROJECT_ROOT="$SEARCH_DIR"
    break
  fi
  SEARCH_DIR="$(dirname "$SEARCH_DIR")"
done

if [[ -z "$PROJECT_ROOT" ]]; then
  exit 0
fi

# ${HOME:-/tmp}: HOME may be unset in a stripped hook environment; under `set -u` a bare
# ${HOME} would be a fatal unbound-variable error and break the always-exit-0 contract.
LOG_DIR="${HOME:-/tmp}/.local/share/abstract-data/logs"
mkdir -p "$LOG_DIR" 2>/dev/null || true

# Bound each run so session end is never delayed indefinitely. `timeout` is not on every
# macOS by default — fall back to a plain run when it is absent. Each command is `|| true`
# so an inner failure never propagates a non-zero exit.
run_bounded() {
  if command -v timeout &>/dev/null; then
    timeout 60 "$@"
  else
    "$@"
  fi
}

run_bounded abstract-data tools backfill --project "$PROJECT_ROOT" --limit 50 \
  >> "$LOG_DIR/telemetry.log" 2>&1 || true
run_bounded abstract-data state harvest "$PROJECT_ROOT" \
  >> "$LOG_DIR/telemetry.log" 2>&1 || true

exit 0
