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
#   Optional: OP_AS_CODE_ENVIRONMENT_ID=<as-code-env-id> for NOTION_API_TOKEN (preferred over GitHub secret)
#
# CI (legacy — env vars pre-exported by another step, e.g. load-secrets-action):
#   SOURCE=env bash scripts/sync-notion-worker-secrets.sh
#
# Requires: op (for SOURCE=1p or SOURCE=op-environment), ntn CLI, NOTION_API_TOKEN
# (from 1Password Environment, OP_AS_CODE_ENVIRONMENT_ID, or process env / GitHub secret)
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
  echo "ntn CLI not found. Install: npm install -g ntn (or bash ../../scripts/install-ntn.sh)" >&2
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

read_env_value_from_file() {
  local file="$1"
  local key="$2"
  local line
  line="$(grep -m1 "^${key}=" "$file" 2>/dev/null || true)"
  if [[ -z "$line" ]]; then
    return 1
  fi
  local val="${line#*=}"
  val="${val%\"}"
  val="${val#\"}"
  printf '%s' "$val"
}

read_workers_workspace_id() {
  local config="${WORKERS_CONFIG_FILE:-$ROOT/workers.json}"
  if [[ ! -f "$config" ]]; then
    return 1
  fi
  local line
  line="$(grep -m1 '"workspaceId"' "$config" 2>/dev/null || true)"
  if [[ -z "$line" ]]; then
    return 1
  fi
  local val="${line#*:}"
  val="${val#*\"}"
  val="${val%%\"*}"
  printf '%s' "$val"
}

resolve_notion_api_token() {
  local token=""
  local as_code_env=""

  if [[ -n "${OP_AS_CODE_ENVIRONMENT_ID:-}" ]]; then
    as_code_env="$(mktemp)"
    if op environment read "$OP_AS_CODE_ENVIRONMENT_ID" > "$as_code_env" 2>/dev/null; then
      if token="$(read_env_value_from_file "$as_code_env" "NOTION_API_TOKEN")"; then
        echo "Resolved NOTION_API_TOKEN from OP_AS_CODE_ENVIRONMENT_ID."
      elif token="$(read_env_value_from_file "$as_code_env" "NTN_WORKERS_TOKEN")"; then
        echo "Resolved NTN_WORKERS_TOKEN from OP_AS_CODE_ENVIRONMENT_ID (mapped to NOTION_API_TOKEN for ntn CLI)."
      fi
    else
      echo "Warning: could not read OP_AS_CODE_ENVIRONMENT_ID ($OP_AS_CODE_ENVIRONMENT_ID)." >&2
    fi
    rm -f "$as_code_env"
  fi

  if [[ -z "$token" ]] && [[ -s "$RAW_ENV" ]]; then
    if token="$(read_env_value "NOTION_API_TOKEN")"; then
      echo "Resolved NOTION_API_TOKEN from source environment."
    elif token="$(read_env_value "NTN_WORKERS_TOKEN")"; then
      echo "Resolved NTN_WORKERS_TOKEN from source environment (mapped to NOTION_API_TOKEN for ntn CLI)."
    fi
  fi

  if [[ -z "$token" ]] && [[ -n "${NOTION_API_TOKEN:-}" ]]; then
    token="$NOTION_API_TOKEN"
    echo "Using NOTION_API_TOKEN from process environment (e.g. GitHub secret fallback)."
  fi

  if [[ -z "$token" ]]; then
    cat >&2 <<'EOF'
NOTION_API_TOKEN / NTN_WORKERS_TOKEN is not set.

The ntn CLI requires a Notion personal access token (PAT) with Workers manage access —
not the worker runtime integration token (NTN_API_TOKEN).

Add NTN_WORKERS_TOKEN (or NOTION_API_TOKEN) to your 1Password Environment:
  NTN_WORKERS_TOKEN=ntn_...

For CI, the sync script reads NTN_WORKERS_TOKEN from the workers 1Password Environment
automatically. GitHub secret NOTION_API_TOKEN is only a fallback.
EOF
    exit 1
  fi

  export NOTION_API_TOKEN="$token"
}

verify_ntn_workers_auth() {
  if [[ -z "${NOTION_WORKSPACE_ID:-}" ]]; then
    if workspace_id="$(read_workers_workspace_id)"; then
      export NOTION_WORKSPACE_ID="$workspace_id"
      echo "Using NOTION_WORKSPACE_ID from workers.json: $NOTION_WORKSPACE_ID"
    fi
  fi

  if ! ntn workers list --json >/dev/null 2>&1; then
    cat >&2 <<'EOF'
ntn Workers authentication failed (unauthorized).

Common causes:
  - NOTION_API_TOKEN is the worker integration token (NTN_API_TOKEN) instead of a PAT
  - The PAT expired or was revoked
  - The PAT lacks Workers manage permission for this workspace

Fix:
  1. Create a personal access token at https://www.notion.so/my-integrations
  2. Store it as NOTION_API_TOKEN in your 1Password as-code Environment
  3. Set OP_AS_CODE_ENVIRONMENT_ID in the GitHub Environment (or update NOTION_API_TOKEN secret)
  4. Re-run the workflow

Do not use NTN_API_TOKEN for ntn CLI authentication.
EOF
    exit 1
  fi

  echo "ntn Workers authentication OK."
}

materialize_raw_env
resolve_notion_api_token

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

if grep -q '^NTN_API_TOKEN=' "$FILTERED_ENV" 2>/dev/null; then
  ntn_token="$(grep -m1 '^NTN_API_TOKEN=' "$FILTERED_ENV" | cut -d= -f2-)"
  if [[ "$NOTION_API_TOKEN" == "$ntn_token" ]]; then
    cat >&2 <<'EOF'
NOTION_API_TOKEN matches NTN_API_TOKEN — these must be different credentials.

NTN_API_TOKEN is the worker runtime integration token.
NOTION_API_TOKEN must be a personal access token for the ntn CLI.

Store the PAT as NOTION_API_TOKEN in your 1Password as-code Environment and remove
the incorrect value from the GitHub Environment secret if present.
EOF
    exit 1
  fi
fi

verify_ntn_workers_auth

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
