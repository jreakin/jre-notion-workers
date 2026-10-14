#!/usr/bin/env bash
# Cursor Cloud Agent install step (.cursor/environment.json "install").
# Runs at Build time; must stay idempotent (Cursor may re-run it on prepared disk).
#
# 1. Require Node >= 22 (repo engines + GitNexus requirement).
# 2. Package deps: `bun install` in jre-notion-workers/ (same as the prior
#    dashboard update script; NOT --frozen-lockfile, see jre-notion-workers/AGENTS.md).
# 3. GitNexus code graph (pilot, LOCK-61): pinned global install + index.
#    The index (.gitnexus/) is local and gitignored, never committed.
set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

GITNEXUS_VERSION="1.6.12"

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" -lt 22 ]; then
  # Try nvm if the image ships it; otherwise fail loudly (do not silently degrade).
  if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    nvm install 22 >/dev/null && nvm alias default 22 >/dev/null
  fi
fi
if [ "$(node_major)" -lt 22 ]; then
  echo "cloud-agent-install: Node >= 22 required, found $(node -v 2>/dev/null || echo none)" >&2
  exit 1
fi

if command -v bun >/dev/null 2>&1; then
  (cd jre-notion-workers && bun install)
else
  echo "cloud-agent-install: bun not on PATH; falling back to npm install" >&2
  (cd jre-notion-workers && npm install --no-audit --no-fund)
fi

# GitNexus is optional tooling: a failure here must not fail the Build.
if [ "$(gitnexus --version 2>/dev/null || true)" != "$GITNEXUS_VERSION" ]; then
  npm i -g "gitnexus@${GITNEXUS_VERSION}" --no-audit --no-fund \
    || echo "cloud-agent-install: gitnexus install failed; agents will report impact UNKNOWN" >&2
fi
bash scripts/gitnexus-refresh.sh || true
