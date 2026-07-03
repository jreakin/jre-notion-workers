#!/usr/bin/env bash
# Backfill git tags and GitHub releases for versions documented in CHANGELOG.md.
# Run once after merging the release-please bootstrap PR.
#
# Prerequisites: gh CLI authenticated with repo write access.
# Usage: ./scripts/backfill-github-releases.sh [--dry-run]

set -euo pipefail

REPO="jreakin/jre-notion-workers"
DRY_RUN=false

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "Dry run — no tags or releases will be created."
fi

# tag → commit SHA → release date (ISO 8601)
declare -A TAG_SHA=(
  [v0.1.0]="4a153217d199539b694f2219d26856f8f04945b8"
  [v0.2.0]="2301e299d7a32588ce0afed7657e83701863128a"
  [v0.3.0]="096989e7fb235b99126eba84d4d3945d23361f7a"
  [v0.4.0]="112c48c0ec76d5c40dc8a0c40c2e308ba84b914d"
  [v1.0.0]="b1ead7227cc5e37e3f4984906a37bf1e38370e52"
)

declare -A TAG_DATE=(
  [v0.1.0]="2026-03-11T20:58:23Z"
  [v0.2.0]="2026-03-15T06:24:07Z"
  [v0.3.0]="2026-03-19T05:04:27Z"
  [v0.4.0]="2026-04-03T03:46:29Z"
  [v1.0.0]="2026-05-03T00:59:30Z"
)

extract_section() {
  local version="$1"
  local next_version="$2"
  # Strip leading 'v' for CHANGELOG heading match
  local ver="${version#v}"
  local next_ver="${next_version#v}"

  if [[ -z "$next_version" ]]; then
    awk -v ver="$ver" '
      $0 ~ "^## \\[" ver "\\]" { found=1; next }
      found && /^## \[/ { exit }
      found { print }
    ' CHANGELOG.md
  else
    awk -v ver="$ver" -v next="$next_ver" '
      $0 ~ "^## \\[" ver "\\]" { found=1; next }
      found && $0 ~ "^## \\[" next "\\]" { exit }
      found { print }
    ' CHANGELOG.md
  fi
}

VERSIONS=(v0.1.0 v0.2.0 v0.3.0 v0.4.0 v1.0.0)

for i in "${!VERSIONS[@]}"; do
  tag="${VERSIONS[$i]}"
  sha="${TAG_SHA[$tag]}"
  date="${TAG_DATE[$tag]}"
  next_tag=""
  if (( i + 1 < ${#VERSIONS[@]} )); then
    next_tag="${VERSIONS[$((i + 1))]}"
  fi

  notes="$(extract_section "$tag" "$next_tag")"

  echo "--- $tag @ $sha ($date) ---"

  if $DRY_RUN; then
    echo "[dry-run] git tag -a $tag $sha"
    echo "[dry-run] gh release create $tag --repo $REPO --target $sha --title \"$tag\" --notes-file -"
    echo "$notes" | head -20
    continue
  fi

  if git rev-parse "$tag" >/dev/null 2>&1; then
    echo "Tag $tag already exists — skipping tag creation."
  else
    git tag -a "$tag" "$sha" -m "Release $tag"
    echo "Created tag $tag"
  fi

  if gh release view "$tag" --repo "$REPO" >/dev/null 2>&1; then
    echo "Release $tag already exists — skipping release creation."
  else
    echo "$notes" | gh release create "$tag" \
      --repo "$REPO" \
      --target "$sha" \
      --title "$tag" \
      --notes-file -
    echo "Created GitHub release $tag"
  fi
done

echo "Done. Push tags with: git push origin --tags"
