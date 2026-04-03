#!/bin/bash
# scripts/first-run.sh
# Paste this entire script into a fresh UDM gateway via SSH.
# It installs op CLI, clones the repo, and runs bootstrap.

set -euo pipefail

OP_SERVICE_ACCOUNT_TOKEN="ops_eyJzaWduSW5BZGRyZXNzIjoibXkuMXBhc3N3b3JkLmNvbSIsInVzZXJBdXRoIjp7Im1ldGhvZCI6IlNSUGctNDA5NiIsImFsZyI6IlBCRVMyZy1IUzI1NiIsIml0ZXJhdGlvbnMiOjY1MDAwMCwic2FsdCI6IlJPU0JUa2pST2FzZEpHMDNkeTA0d1EifSwiZW1haWwiOiJ3ZjJ6a29vc3NubDM0QDFwYXNzd29yZHNlcnZpY2VhY2NvdW50cy5jb20iLCJzcnBYIjoiNDY4YWU5OGQ0ZjZiMWRjZTkyYzVmMGJiNjExYmJlYWJkY2Y0OTQ0NTdmOTM0NDA4ZTczNTVlMDgyZmViYTIzNiIsIm11ayI6eyJhbGciOiJBMjU2R0NNIiwiZXh0Ijp0cnVlLCJrIjoiYllUc29JOG9kdXZQWTFwTGFDd2t4N01mOHRHVmExNzA2TGhoQ0UxeVNTTSIsImtleV9vcHMiOlsiZW5jcnlwdCIsImRlY3J5cHQiXSwia3R5Ijoib2N0Iiwia2lkIjoibXAifSwic2VjcmV0S2V5IjoiQTMtNTlFTTZNLTM2OUhEVi1YU0EySi1STEJNRy1XQkhMUC0yOEIyRSIsInRocm90dGxlU2VjcmV0Ijp7InNlZWQiOiJhODFmYzMzNmNmYmNjY2I2NTRhOTg1Zjg0MzQ4MTIwNzVhZmI3ZTc1ZmM4MmFiNDk5OWE4OTRiOTMxMGQxMjZmIiwidXVpZCI6IldTSVMzNFZLWlpHRlBNNlhUT0pTUEFKWEZFIn0sImRldmljZVV1aWQiOiJmdjd5NGZya3BqNW1tYmVjNjN2bmNqc25tZSJ9"
OP_GITHUB_PAT_ITEM="xxafpqssjup3knnqtra5ym5goa"
CLONE_DIR="/ssd1/eakin-nextdns-setup"

echo ""
echo "=== NextDNS First-Run Setup ==="
echo ""

# 1. Install op CLI
if command -v op &>/dev/null; then
  echo "[1/3] op CLI already installed: $(op --version)"
else
  echo "[1/3] Installing 1Password CLI..."
  ARCH=$(uname -m)
  case $ARCH in
    aarch64|arm64) OP_ARCH="arm64" ;;
    x86_64)        OP_ARCH="amd64" ;;
    *)
      echo "Error: Unsupported architecture: $ARCH"
      exit 1
      ;;
  esac
  curl -sSfo /tmp/op.zip "https://cache.agilebits.com/dist/1P/op2/pkg/v2.30.0/op_linux_${OP_ARCH}_v2.30.0.zip"
  unzip -o /tmp/op.zip -d /usr/local/bin/
  chmod +x /usr/local/bin/op
  rm -f /tmp/op.zip
  echo "[1/3] Installed op $(op --version)"
fi

# 2. Clone the repo
echo "[2/3] Retrieving GitHub PAT from 1Password..."
export OP_SERVICE_ACCOUNT_TOKEN
GITHUB_PAT=$(op item get "$OP_GITHUB_PAT_ITEM" --vault Dev --fields credential)

if [[ -z "$GITHUB_PAT" ]]; then
  echo "Error: Failed to retrieve GitHub PAT"
  exit 1
fi

echo "[2/3] Downloading repo..."
mkdir -p "$CLONE_DIR"
curl -sSfL \
  -H "Authorization: token $GITHUB_PAT" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/jreakin/eakin-nextdns-setup/tarball/main" \
  | tar xz --strip-components=1 -C "$CLONE_DIR"
echo "[2/3] Repo ready at $CLONE_DIR"

# 3. Hand off to bootstrap
echo "[3/3] Running bootstrap..."
echo ""
bash "$CLONE_DIR/scripts/bootstrap.sh"
