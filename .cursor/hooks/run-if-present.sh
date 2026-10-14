#!/usr/bin/env bash
# Run a hook script only if it exists; otherwise allow (exit 0) with a one-line
# stderr notice so the gap stays visible.
# Fixes the fail-closed gap where hooks.json referenced scripts that were never
# committed (terraform-guard.sh, session-py-baseline.sh): the missing-file exit
# 127 errored EVERY Shell call, including read-only `gitnexus` CLI calls.
# Mirrors the `if [ -f ... ]` guard .claude/settings.json already uses.
# stdin (the hook payload) is passed through untouched via exec.
script="$1"; shift || true
dir="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$dir/$script" ]; then
  exec bash "$dir/$script" "$@"
fi
echo "run-if-present: .cursor/hooks/$script is missing; skipped (allow)" >&2
exit 0
