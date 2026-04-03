#!/bin/bash
# scripts/deploy.sh

OP_SERVICE_ACCOUNT_TOKEN="ops_eyJzaWduSW5BZGRyZXNzIjoibXkuMXBhc3N3b3JkLmNvbSIsInVzZXJBdXRoIjp7Im1ldGhvZCI6IlNSUGctNDA5NiIsImFsZyI6IlBCRVMyZy1IUzI1NiIsIml0ZXJhdGlvbnMiOjY1MDAwMCwic2FsdCI6IlJPU0JUa2pST2FzZEpHMDNkeTA0d1EifSwiZW1haWwiOiJ3ZjJ6a29vc3NubDM0QDFwYXNzd29yZHNlcnZpY2VhY2NvdW50cy5jb20iLCJzcnBYIjoiNDY4YWU5OGQ0ZjZiMWRjZTkyYzVmMGJiNjExYmJlYWJkY2Y0OTQ0NTdmOTM0NDA4ZTczNTVlMDgyZmViYTIzNiIsIm11ayI6eyJhbGciOiJBMjU2R0NNIiwiZXh0Ijp0cnVlLCJrIjoiYllUc29JOG9kdXZQWTFwTGFDd2t4N01mOHRHVmExNzA2TGhoQ0UxeVNTTSIsImtleV9vcHMiOlsiZW5jcnlwdCIsImRlY3J5cHQiXSwia3R5Ijoib2N0Iiwia2lkIjoibXAifSwic2VjcmV0S2V5IjoiQTMtNTlFTTZNLTM2OUhEVi1YU0EySi1STEJNRy1XQkhMUC0yOEIyRSIsInRocm90dGxlU2VjcmV0Ijp7InNlZWQiOiJhODFmYzMzNmNmYmNjY2I2NTRhOTg1Zjg0MzQ4MTIwNzVhZmI3ZTc1ZmM4MmFiNDk5OWE4OTRiOTMxMGQxMjZmIiwidXVpZCI6IldTSVMzNFZLWlpHRlBNNlhUT0pTUEFKWEZFIn0sImRldmljZVV1aWQiOiJmdjd5NGZya3BqNW1tYmVjNjN2bmNqc25tZSJ9"
OP_GITHUB_PAT_ITEM="xxafpqssjup3knnqtra5ym5goa"

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
  op item get "$OP_GITHUB_PAT_ITEM" --vault Dev --fields password 2>/dev/null)

if [[ -z "$GITHUB_PAT" ]]; then
  echo "Error: Failed to retrieve GitHub PAT from 1Password"
  exit 1
fi

echo "Deploying $CONF to $SITE ($UDM_IP)..."
scp "$REPO_ROOT/$CONF" root@$UDM_IP:/ssd1/.data/nextdns.conf
ssh root@$UDM_IP "nextdns restart && echo 'NextDNS restarted OK'"
echo "Done."
