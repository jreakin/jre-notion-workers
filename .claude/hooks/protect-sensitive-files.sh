#!/bin/bash
# PreToolUse hook: block edits to secret and SCM paths (Hooks Reference #6)
# Project: abstract-data
# Tool: Edit, Write
# Severity: BLOCK (exit 2)
#
# .env.example and *.example are allowed.

set -euo pipefail

read -r INPUT
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // .file_path // empty')

if [[ -z "$FILE" ]]; then
  exit 0
fi

norm=$(echo "$FILE" | tr '\\' '/')
base=$(basename "$norm")

# Secret env files (allow documented templates only)
if [[ "$base" == ".env" || "$base" == .env.* ]]; then
  if [[ "$base" == ".env.example" || "$base" == ".env.sample" || "$base" == .env.*.example ]]; then
    exit 0
  fi
  echo "BLOCKED: refuse to edit secret env file: $FILE" >&2
  exit 2
fi

case "$norm" in
  */.git/*|.git/*|*/.git)
    echo "BLOCKED: refuse to edit under .git: $FILE" >&2
    exit 2
    ;;
esac

case "$norm" in
  *.pem|*.key|*/secrets/*|*/\.ssh/*)
    echo "BLOCKED: refuse to edit key material path: $FILE" >&2
    exit 2
    ;;
esac

exit 0
