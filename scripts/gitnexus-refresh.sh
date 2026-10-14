#!/usr/bin/env bash
# Refresh the local GitNexus index (environment.json "start").
# Returns immediately: analyze runs in the background, bounded by `timeout 120`,
# logging to /tmp/gitnexus-refresh.log. Never fails, never blocks agent start.
# --index-only/--skip-agents-md: never rewrites AGENTS.md, CLAUDE.md or skills.
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
# shellcheck source=scripts/gitnexus-env.sh
. scripts/gitnexus-env.sh
LOG="${GITNEXUS_REFRESH_LOG:-/tmp/gitnexus-refresh.log}"
if ! gitnexus_node_ok || [ ! -x "$GITNEXUS_BIN" ]; then
  gitnexus_unknown "not installed or unsupported node"
  exit 0
fi
if [ "${1:-}" = "--foreground" ]; then
  if ! timeout 120 "$GITNEXUS_BIN" analyze --index-only --skip-agents-md >"$LOG" 2>&1; then
    gitnexus_unknown "refresh failed or exceeded 120s (see $LOG)"
    exit 1
  fi
  exit 0
fi
nohup timeout 120 "$GITNEXUS_BIN" analyze --index-only --skip-agents-md >"$LOG" 2>&1 </dev/null &
echo "gitnexus-refresh: started in background (pid $!, log $LOG)" >&2
exit 0
