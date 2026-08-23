#!/bin/bash
# PostToolUse hook: detect hardcoded secrets in committed source files
# Project: abstract-data
# Tool: Edit|Write
# Severity: WARN (exit 0, message to stderr)
#
# Catches common secret patterns: API keys, tokens, high-entropy strings,
# and known service prefixes (Notion, GitHub, Anthropic, AWS, etc.).
# Skips .env files (those are managed separately), test fixtures, and
# files with only placeholder/example values.

read -r INPUT
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // .file_path // empty')

if [[ -z "$FILE" || ! -f "$FILE" ]]; then
  exit 0
fi

# Skip .env files, .example files, and test fixtures
case "$FILE" in
  *.env|*.env.*|*/.env|*example*|*fixture*|*/cassettes/*)
    exit 0
    ;;
esac

# Skip non-source files
case "$FILE" in
  *.py|*.toml|*.yaml|*.yml|*.json|*.sh|*.md)
    ;;
  *)
    exit 0
    ;;
esac

WARNINGS=""

# Known token prefixes (format: PREFIX followed by alphanum/dash/underscore)
token_patterns=(
  'secret_[a-zA-Z0-9_-]{20,}'         # Notion integration tokens
  'ntn_[a-zA-Z0-9]{30,}'               # Notion API token prefix
  'ghp_[a-zA-Z0-9]{36}'               # GitHub personal access token
  'github_pat_[a-zA-Z0-9_]{82}'       # GitHub fine-grained PAT
  'sk-ant-[a-zA-Z0-9_-]{40,}'         # Anthropic API key
  'sk-[a-zA-Z0-9]{48}'                # OpenAI-style API key
  'AKIA[A-Z0-9]{16}'                   # AWS access key ID
  'xoxb-[0-9-a-zA-Z]{50,}'            # Slack bot token
  'xoxp-[0-9-a-zA-Z]{50,}'            # Slack user token
)

for pattern in "${token_patterns[@]}"; do
  matches=$(grep -nE "$pattern" "$FILE" 2>/dev/null | grep -vE '^\s*#|example|placeholder|your_|<.*>' 2>/dev/null || true)
  if [[ -n "$matches" ]]; then
    WARNINGS="${WARNINGS}SECRET SCAN: possible secret in $FILE:\n"
    while IFS= read -r line; do
      WARNINGS="${WARNINGS}  $line\n"
    done <<< "$matches"
  fi
done

# Generic high-entropy string heuristic: long base64-looking strings assigned to likely-secret vars
secret_var_pattern='(token|secret|key|password|passwd|api_key|auth)[[:space:]]*=[[:space:]]*["\x27][A-Za-z0-9+/]{32,}["\x27]'
matches=$(grep -niE "$secret_var_pattern" "$FILE" 2>/dev/null | grep -vE '^\s*#|example|placeholder|your_|<.*>|os\.environ|os\.getenv|keyring' 2>/dev/null || true)
if [[ -n "$matches" ]]; then
  WARNINGS="${WARNINGS}SECRET SCAN: possible hardcoded credential in $FILE:\n"
  while IFS= read -r line; do
    WARNINGS="${WARNINGS}  $line\n"
  done <<< "$matches"
fi

if [[ -n "$WARNINGS" ]]; then
  echo -e "$WARNINGS" >&2
  echo -e "  Use keyring.get_password() or os.environ[] for secrets. Never hardcode." >&2
fi

exit 0
