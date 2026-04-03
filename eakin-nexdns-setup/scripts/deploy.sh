#!/bin/bash
# scripts/deploy.sh

OP_SERVICE_ACCOUNT_TOKEN="sqhnz3tcqfoxnhkmwyfegjijne"
OP_GITHUB_PAT_ITEM="pues5sxoqxyggu2mqk4cqgcjlu"

SITE=$1
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

case $SITE in
  brownsville|parents)
    CONF="sites/$SITE/nextdns.conf"
    ;;
  *)
    echo "Usage: ./deploy.sh [brownsville|parents]"
    exit 1
    ;;
esac

# Load site env (gateway IP, profile IDs)
ENV_FILE="$REPO_ROOT/sites/$SITE/.env"
if [[ -f "$ENV_FILE" ]]; then
  source "$ENV_FILE"
else
  echo "Error: No .env found at $ENV_FILE"
  exit 1
fi

# Resolve gateway IP
SITE_UPPER=$(echo "$SITE" | tr '[:lower:]' '[:upper:]')
UDM_IP_VAR="${SITE_UPPER}_GATEWAY_IP"
UDM_IP="${!UDM_IP_VAR}"

if [[ -z "$UDM_IP" ]]; then
  echo "Error: ${UDM_IP_VAR} not set in $ENV_FILE"
  exit 1
fi

# Retrieve GitHub PAT from 1Password via op CLI
echo "Retrieving GitHub PAT from 1Password..."
GITHUB_PAT=$(OP_SERVICE_ACCOUNT_TOKEN="$OP_SERVICE_ACCOUNT_TOKEN" \
  op item get "$OP_GITHUB_PAT_ITEM" --fields password 2>/dev/null)

if [[ -z "$GITHUB_PAT" ]]; then
  echo "Error: Failed to retrieve GitHub PAT from 1Password"
  exit 1
fi

echo "Deploying $CONF to $SITE ($UDM_IP)..."
scp "$REPO_ROOT/$CONF" root@$UDM_IP:/ssd1/.data/nextdns.conf
ssh root@$UDM_IP "nextdns restart && echo 'NextDNS restarted OK'"
echo "Done."
