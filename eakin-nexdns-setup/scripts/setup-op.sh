#!/bin/bash
# scripts/setup-op.sh
# Install 1Password CLI on a UDM gateway
# Usage: ./scripts/setup-op.sh <site-name>

OP_SERVICE_ACCOUNT_TOKEN="sqhnz3tcqfoxnhkmwyfegjijne"

SITE=$1
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Load site env for gateway IP
source "$REPO_ROOT/sites/$SITE/.env"

SITE_UPPER=$(echo "$SITE" | tr '[:lower:]' '[:upper:]')
UDM_IP_VAR="${SITE_UPPER}_GATEWAY_IP"
UDM_IP="${!UDM_IP_VAR}"

if [[ -z "$UDM_IP" ]]; then
  echo "Error: ${UDM_IP_VAR} not set"
  exit 1
fi

echo "Installing 1Password CLI on $SITE ($UDM_IP)..."

ssh root@$UDM_IP 'bash -s' <<'REMOTE'
  # Check if op is already installed
  if command -v op &>/dev/null; then
    echo "op CLI already installed: $(op --version)"
    exit 0
  fi

  # Detect architecture
  ARCH=$(uname -m)
  case $ARCH in
    aarch64|arm64) OP_ARCH="arm64" ;;
    x86_64)        OP_ARCH="amd64" ;;
    *)
      echo "Unsupported architecture: $ARCH"
      exit 1
      ;;
  esac

  # Download and install op CLI
  curl -sSfo /tmp/op.zip "https://cache.agilebits.com/dist/1P/op2/pkg/v2.30.0/op_linux_${OP_ARCH}_v2.30.0.zip"
  unzip -o /tmp/op.zip -d /usr/local/bin/
  chmod +x /usr/local/bin/op
  rm -f /tmp/op.zip

  echo "Installed: $(op --version)"
REMOTE

echo "Done."
