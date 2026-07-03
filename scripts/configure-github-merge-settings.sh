#!/usr/bin/env bash
# Configure GitHub repo merge settings for release-please compatibility.
# Release Please requires squash merges so each PR becomes one conventional commit on main.
#
# Prerequisites: gh CLI authenticated with admin access to the repo.
# Usage: ./scripts/configure-github-merge-settings.sh [--dry-run]

set -euo pipefail

REPO="jreakin/jre-notion-workers"
DRY_RUN=false

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

SETTINGS='{
  "allow_merge_commit": false,
  "allow_squash_merge": true,
  "allow_rebase_merge": false,
  "squash_merge_commit_title": "PR_TITLE",
  "squash_merge_commit_message": "COMMIT_MESSAGES",
  "delete_branch_on_merge": true
}'

echo "Target repo: $REPO"
echo "Settings:"
echo "$SETTINGS" | jq .

if $DRY_RUN; then
  echo "[dry-run] gh api -X PATCH repos/$REPO --input -"
  exit 0
fi

echo "$SETTINGS" | gh api -X PATCH "repos/$REPO" --input -
echo "Repository merge settings updated."

echo ""
echo "Verify in GitHub → Settings → General → Pull Requests:"
echo "  ✓ Allow squash merging"
echo "  ✗ Allow merge commits"
echo "  ✗ Allow rebase merging"
echo "  ✓ Default to PR title for squash commit message"
