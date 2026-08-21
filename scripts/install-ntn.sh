#!/usr/bin/env bash
# scripts/install-ntn.sh
# Install the Notion CLI (ntn) for Cloud Agent / CI environments without sudo.
#
# Usage:
#   bash scripts/install-ntn.sh
#
# Cursor Cloud Environment install line (repo root):
#   bash scripts/install-ntn.sh && cd jre-notion-workers && bun install
#
# Requires: curl, bash. Installs to ~/.local/bin by default (official installer).
# Open-source safe — no secrets.

set -euo pipefail

NTN_BIN_DIR="${NTN_BIN_DIR:-${HOME}/.local/bin}"
export PATH="${NTN_BIN_DIR}:${PATH}"

if command -v ntn >/dev/null 2>&1; then
  echo "ntn already on PATH: $(ntn --version)"
  exit 0
fi

echo "Installing ntn via https://ntn.dev ..."
curl -fsSL https://ntn.dev | bash

if ! command -v ntn >/dev/null 2>&1; then
  echo "ntn not found after install. Expected binary in ${NTN_BIN_DIR}" >&2
  exit 1
fi

echo "ntn ready: $(ntn --version)"
echo "Ensure PATH includes ${NTN_BIN_DIR} (Cloud Agent shells usually include ~/.local/bin)."
