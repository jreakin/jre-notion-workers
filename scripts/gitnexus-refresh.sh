#!/usr/bin/env bash
# Build/refresh the local GitNexus index. Never fails the caller.
# --index-only: no AGENTS.md / CLAUDE.md / skills injection (repo docs stay hand-owned).
# --skip-agents-md: belt-and-braces with --index-only.
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
export GITNEXUS_NO_UPDATE_NOTIFIER=1
if ! command -v gitnexus >/dev/null 2>&1; then
  echo "gitnexus-refresh: gitnexus not installed; skipping (impact = UNKNOWN)" >&2
  exit 0
fi
gitnexus analyze --index-only --skip-agents-md \
  || echo "gitnexus-refresh: analyze failed; skipping (impact = UNKNOWN)" >&2
exit 0
