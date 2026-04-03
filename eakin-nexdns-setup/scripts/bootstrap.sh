#!/bin/bash
# scripts/bootstrap.sh
# Called by first-run.sh after op + repo are ready, or run standalone.
# Usage: bash bootstrap.sh [brownsville|parents]

set -euo pipefail

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
echo "=== Applying NextDNS config for $SITE ==="

# Apply NextDNS config
CONF="$CLONE_DIR/sites/$SITE/nextdns.conf"
if [[ ! -f "$CONF" ]]; then
  echo "Error: Config not found at $CONF"
  echo "Available sites:"
  ls "$CLONE_DIR/sites/"
  exit 1
fi

cp "$CONF" /ssd1/.data/nextdns.conf
nextdns restart

echo ""
echo "=== Done ==="
echo "Config: $CONF -> /ssd1/.data/nextdns.conf"
echo "NextDNS restarted."
echo ""
echo "To update later: cd $CLONE_DIR && git pull && bash scripts/bootstrap.sh $SITE"
