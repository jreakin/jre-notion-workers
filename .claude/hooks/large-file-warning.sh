#!/bin/bash
# PostToolUse hook: warn when a Python source file exceeds ~300 lines
# Project: abstract-data
# Tool: Edit|Write
# Severity: WARN (exit 0, message to stderr)
#
# Files over 300 lines are a signal that a module is accumulating too many
# responsibilities and should be split. This is especially relevant in a
# Ports & Adapters architecture where each adapter, use case, and domain
# model should be narrow and focused.
#
# Thresholds:
#   300 lines — soft warning: consider splitting
#   500 lines — hard warning: this file almost certainly needs refactoring
#
# Skips: tests/, migrations/, generated files, and __init__.py (aggregators).

read -r INPUT
FILE=$(echo "$INPUT" | jq -r '.file_path // empty')

if [[ "$FILE" != *.py ]]; then
  exit 0
fi

case "$FILE" in
  *__init__.py|*/tests/*|*/test_*|*_test.py|*/migrations/*)
    exit 0
    ;;
esac

if [[ ! -f "$FILE" ]]; then
  exit 0
fi

LINE_COUNT=$(wc -l < "$FILE" 2>/dev/null | tr -d ' ')

if [[ "$LINE_COUNT" -ge 500 ]]; then
  echo -e "LARGE FILE [hard]: $FILE is $LINE_COUNT lines — this file almost certainly needs splitting." >&2
  echo -e "  Identify cohesive groups of functions/classes and extract them into focused modules." >&2
elif [[ "$LINE_COUNT" -ge 300 ]]; then
  echo -e "LARGE FILE [soft]: $FILE is $LINE_COUNT lines — consider splitting into focused modules." >&2
fi

exit 0
