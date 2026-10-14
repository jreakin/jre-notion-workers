#!/usr/bin/env bash
# Cursor Cloud Agent install step (.cursor/environment.json "install").
# Runs at Build time; idempotent. Package deps always install; GitNexus is
# optional tooling and can never fail the Build.
set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
# shellcheck source=scripts/gitnexus-env.sh
. scripts/gitnexus-env.sh

bun_install() {  # $1 = dir; frozen when a bun.lock exists, plain as fallback
  local d="$1"
  if command -v bun >/dev/null 2>&1; then
    (cd "$d" && { bun install --frozen-lockfile || bun install; })
  else
    echo "cloud-agent-install: bun not on PATH; npm install in $d" >&2
    (cd "$d" && npm install --no-audit --no-fund)
  fi
}

# 1. Package dependencies (always).
#    jre-notion-workers: plain `bun install` (bun.lock may drift; see its AGENTS.md).
if command -v bun >/dev/null 2>&1; then
  (cd jre-notion-workers && bun install)
else
  (cd jre-notion-workers && npm install --no-audit --no-fund)
fi
#    Cloudflare workers (wrangler + typescript): bun.lock each, frozen like CI.
bun_install packages/cf-workers/notion-comments-relay
bun_install packages/cf-workers/clef-gate
#    packages/clef-core has no dependencies; packages/workers is the legacy
#    mirror with no lockfile (not installed, as before).

# 2. GitNexus (optional). Never fails the Build.
if ! gitnexus_node_ok; then
  gitnexus_unknown "node $(node --version 2>/dev/null || echo none) does not satisfy ^22.18.0 || >=24.11.0"
  exit 0
fi
if ! timeout 600 bash -c "cd \"$GITNEXUS_TOOL_DIR\" && npm ci --no-audit --no-fund"; then
  gitnexus_unknown "npm ci in $GITNEXUS_TOOL_DIR failed or exceeded 600s"
  exit 0
fi
if ! timeout 300 "$GITNEXUS_BIN" analyze --index-only --skip-agents-md; then
  gitnexus_unknown "analyze failed or exceeded 300s"
fi
exit 0
