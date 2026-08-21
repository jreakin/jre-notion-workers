#!/usr/bin/env bash
# scripts/sync-notion-worker-secrets.sh
# Materialize production secrets from 1Password and push new/changed keys to Notion Workers.
#
# Local (1Password CLI, item/field secret references):
#   bash scripts/sync-notion-worker-secrets.sh
#   DRY_RUN=1 bash scripts/sync-notion-worker-secrets.sh
#
# CI (1Password Environment, via `op environment read`):
#   SOURCE=op-environment OP_ENVIRONMENT_ID=<environment-id> bash scripts/sync-notion-worker-secrets.sh
#
# CI (legacy — env vars pre-exported by another step, e.g. load-secrets-action):
#   SOURCE=env bash scripts/sync-notion-worker-secrets.sh
#
# Requires: op (for SOURCE=1p or SOURCE=op-environment), ntn CLI, NOTION_API_TOKEN
# (or ntn login) for ntn workers env.
# Open-source safe — no plaintext secrets in this file.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SOURCE="${SOURCE:-1p}"
ENV_FILE="${ENV_FILE:-}"
DRY_RUN="${DRY_RUN:-0}"
KEYS_FILE="${KEYS_FILE:-$ROOT/scripts/worker-env-keys.txt}"
OP_INJECT_FILE="${OP_INJECT_FILE:-.env.1p}"

if [[ ! -f "$KEYS_FILE" ]]; then
  echo "Keys manifest not found: $KEYS_FILE" >&2
  exit 1
fi

if ! command -v ntn >/dev/null 2>&1; then
  echo "ntn CLI not found. Install: npm install -g ntn" >&2
  exit 1
fi

if [[ -z "${NOTION_API_TOKEN:-}" ]]; then
  echo "NOTION_API_TOKEN is not set. Export a Notion PAT for ntn CLI (CI / unattended use)." >&2
  exit 1
fi

export NOTION_KEYRING="${NOTION_KEYRING:-0}"

RAW_ENV="$(mktemp)"
FILTERED_ENV="$(mktemp)"
trap 'rm -f "$RAW_ENV" "$FILTERED_ENV"' EXIT

materialize_raw_env() {
  case "$SOURCE" in
    1p)
      if ! command -v op >/dev/null 2>&1; then
        echo "op CLI not found (required for SOURCE=1p)." >&2
        exit 1
      fi
      if [[ ! -f "$OP_INJECT_FILE" ]]; then
        echo "Missing $OP_INJECT_FILE" >&2
        exit 1
      fi
      op inject -i "$OP_INJECT_FILE" -o "$RAW_ENV"
      ;;
    op-environment)
      if ! command -v op >/dev/null 2>&1; then
        echo "op CLI not found (required for SOURCE=op-environment)." >&2
        exit 1
      fi
      if [[ -z "${OP_ENVIRONMENT_ID:-}" ]]; then
        echo "OP_ENVIRONMENT_ID is not set (required for SOURCE=op-environment)." >&2
        exit 1
      fi
      # `op environment read` is a beta CLI feature — no op:// item/field paths
      # required, just a service account (or desktop app session) scoped to
      # the Environment itself.
      op environment read "$OP_ENVIRONMENT_ID" > "$RAW_ENV"
      ;;
    file)
      if [[ -z "$ENV_FILE" || ! -f "$ENV_FILE" ]]; then
        echo "SOURCE=file requires ENV_FILE pointing to an existing file." >&2
        exit 1
      fi
      cp "$ENV_FILE" "$RAW_ENV"
      ;;
    env)
      : > "$RAW_ENV"
      while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
        line="${raw_line%%#*}"
        line="${line#"${line%%[![:space:]]*}"}"
        line="${line%"${line##*[![:space:]]}"}"
        [[ -z "$line" ]] && continue
        key="$line"
        if [[ -n "${!key:-}" ]]; then
          printf '%s=%s\n' "$key" "${!key}" >> "$RAW_ENV"
        fi
      done < "$KEYS_FILE"
      ;;
    *)
      echo "Unknown SOURCE=$SOURCE (use 1p, op-environment, file, or env)." >&2
      exit 1
      ;;
  esac
}

read_env_value() {
  local key="$1"
  local line
  line="$(grep -m1 "^${key}=" "$RAW_ENV" 2>/dev/null || true)"
  if [[ -z "$line" ]]; then
    return 1
  fi
  local val="${line#*=}"
  val="${val%\"}"
  val="${val#\"}"
  printf '%s' "$val"
}

materialize_raw_env

: > "$FILTERED_ENV"
keys_found=0
keys_missing=()

while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
  line="${raw_line%%#*}"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [[ -z "$line" ]] && continue

  key="$line"
  if [[ "$key" == TEST_* ]]; then
    continue
  fi

  if ! val="$(read_env_value "$key")"; then
    if [[ "$key" == "NTN_API_TOKEN" ]]; then
      if val="$(read_env_value "NOTION_TOKEN")"; then
        echo "Note: using NOTION_TOKEN value for NTN_API_TOKEN (legacy 1Password field name)."
      else
        keys_missing+=("$key")
        continue
      fi
    else
      keys_missing+=("$key")
      continue
    fi
  fi

  if [[ -z "$val" ]]; then
    keys_missing+=("$key")
    continue
  fi

  printf '%s=%s\n' "$key" "$val" >> "$FILTERED_ENV"
  keys_found=$((keys_found + 1))
done < "$KEYS_FILE"

if [[ "$keys_found" -eq 0 ]]; then
  echo "No production keys resolved. Check 1Password item fields and worker-env-keys.txt." >&2
  if [[ ${#keys_missing[@]} -gt 0 ]]; then
    echo "Missing or empty: ${keys_missing[*]}" >&2
  fi
  exit 1
fi

echo "Resolved $keys_found production key(s) for Notion Workers sync."
if [[ ${#keys_missing[@]} -gt 0 ]]; then
  echo "Skipped (missing or empty in source): ${keys_missing[*]}"
fi

remote_keys=""
if remote_keys="$(ntn workers env list 2>/dev/null)"; then
  echo "Remote keys currently configured: $(echo "$remote_keys" | tr '\n' ' ')"
else
  echo "Could not list remote keys (continuing with push)."
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo "DRY_RUN=1 — would push the following keys:"
  while IFS= read -r line || [[ -n "$line" ]]; do
    key="${line%%=*}"
    echo "  - $key"
  done < "$FILTERED_ENV"
  exit 0
fi

echo "Pushing to Notion Workers (adds new keys, updates changed values)..."
ntn workers env push --file="$FILTERED_ENV" --yes

echo "Done. Redeploy if a running secret value changed: npm run build && ntn workers deploy"
