#!/usr/bin/env bash
# Run a hook script only if it exists; otherwise allow (exit 0, no output).
# Fixes the fail-closed gap where hooks.json referenced scripts that were never
# committed (terraform-guard.sh, session-py-baseline.sh): the missing-file exit
# 127 blocked or errored EVERY Shell call, including read-only `gitnexus` CLI
# calls. Mirrors the `if [ -f ... ]` guard .claude/settings.json already uses.
# stdin (the hook payload) is passed through untouched via exec.
script="$1"; shift || true
dir="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$dir/$script" ]; then
  exec bash "$dir/$script" "$@"
fi
exit 0
