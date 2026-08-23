#!/usr/bin/env bash
# archive-session.sh — Stop hook
# Archives the current Claude Code session to Notion after the agent finishes.
# Runs silently on success; never blocks session end.
#
# Stop hooks MUST exit 0 — any non-zero exit causes Claude Code to retry.
# This hook always exits 0.

set -uo pipefail

# Skip if abstract-data is not installed
if ! command -v abstract-data &>/dev/null; then
  exit 0
fi

# Opt-out switch
if [[ "${ABSTRACT_DATA_SKIP_TRANSCRIPT_ARCHIVE:-0}" == "1" ]]; then
  exit 0
fi

# Walk up to find project root
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

# Run in the background so it never delays session end. Logs to the daily log dir.
LOG_DIR="${HOME}/.local/share/abstract-data/logs"
mkdir -p "$LOG_DIR" 2>/dev/null || true
abstract-data transcripts push "$PROJECT_ROOT" --limit 5 \
  >> "$LOG_DIR/transcripts.log" 2>&1 &

exit 0
