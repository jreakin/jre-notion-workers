#!/bin/bash
# scripts/bootstrap.sh
# Run this on a fresh UDM to set up NextDNS config management
# Usage: bash bootstrap.sh <site-name>
#   e.g. bash bootstrap.sh brownsville

set -euo pipefail

OP_SERVICE_ACCOUNT_TOKEN="sqhnz3tcqfoxnhkmwyfegjijne"
OP_GITHUB_PAT_ITEM="pues5sxoqxyggu2mqk4cqgcjlu"
REPO_URL="https://github.com/jreakin/eakin-nextdns-setup.git"
CLONE_DIR="/ssd1/eakin-nextdns-setup"

# Prompt for site selection if not passed as argument
if [[ -n "${1:-}" ]]; then
  SITE="$1"
else
  echo ""
  echo "Which site are you configuring?"
  echo ""
  echo "  1) brownsville"
  echo "  2) parents"
  echo ""
  read -rp "Select [1-2]: " choice
  case $choice in
    1) SITE="brownsville" ;;
    2) SITE="parents" ;;
    *)
      echo "Invalid selection."
      exit 1
      ;;
  esac
fi

echo ""
echo "=== NextDNS Bootstrap for $SITE ==="

# 1. Install op CLI if missing
if command -v op &>/dev/null; then
  echo "[✓] op CLI already installed: $(op --version)"
else
  echo "[1/4] Installing 1Password CLI..."
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
  echo "[✓] Installed op $(op --version)"
fi

# 2. Retrieve GitHub PAT from 1Password
echo "[2/4] Retrieving GitHub PAT from 1Password..."
export OP_SERVICE_ACCOUNT_TOKEN
GITHUB_PAT=$(op item get "$OP_GITHUB_PAT_ITEM" --fields password)

if [[ -z "$GITHUB_PAT" ]]; then
  echo "Error: Failed to retrieve GitHub PAT"
  exit 1
fi
echo "[✓] GitHub PAT retrieved"

# 3. Clone or pull the repo
if [[ -d "$CLONE_DIR/.git" ]]; then
  echo "[3/4] Repo exists, pulling latest..."
  cd "$CLONE_DIR"
  git remote set-url origin "https://$GITHUB_PAT@github.com/jreakin/eakin-nextdns-setup.git"
  git pull
else
  echo "[3/4] Cloning repo..."
  git clone "https://$GITHUB_PAT@github.com/jreakin/eakin-nextdns-setup.git" "$CLONE_DIR"
fi
echo "[✓] Repo ready at $CLONE_DIR"

# 4. Apply NextDNS config
CONF="$CLONE_DIR/sites/$SITE/nextdns.conf"
if [[ ! -f "$CONF" ]]; then
  echo "Error: Config not found at $CONF"
  echo "Available sites:"
  ls "$CLONE_DIR/sites/"
  exit 1
fi

echo "[4/4] Applying NextDNS config for $SITE..."
cp "$CONF" /ssd1/.data/nextdns.conf
nextdns restart

echo ""
echo "=== Bootstrap complete ==="
echo "Config: $CONF -> /ssd1/.data/nextdns.conf"
echo "NextDNS restarted."
echo ""
echo "To update later: cd $CLONE_DIR && git pull && cp sites/$SITE/nextdns.conf /ssd1/.data/nextdns.conf && nextdns restart"
