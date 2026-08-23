#!/bin/bash
# PostToolUse hook: nudge when project_tools/ (or plugin builder sources) changed but
# the committed plugins/** payload is stale.
# Project: abstract-data
# Tool: Edit|Write
# Severity: WARN (exit 0, message to stderr)
#
# Mirrors package-manifest-drift.sh (FR-P.1): read-only check, never blocks, never writes.
# Runs `uv run abstract-data build-plugins --check` only when:
#   * the edited file is under plugin-payload source paths (full absolute path match)
#   * the repo carries committed plugin payloads (plugins/abstract-data-claude)
#   * `uv` is on PATH
#
# Foreign projects without plugins/** or abstract-data layout exit 0 silently.

read -r INPUT

FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // .file_path // empty' 2>/dev/null)

if [ -z "$FILE" ]; then
  exit 0
fi

ROOT="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$ROOT" ]; then
  ROOT="${CURSOR_PROJECT_DIR:-}"
fi
if [ -z "$ROOT" ]; then
  ROOT=$(echo "$INPUT" | jq -r '.workspace_roots[0] // empty' 2>/dev/null)
fi
if [ -z "$ROOT" ]; then
  ROOT=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
fi
if [ -z "$ROOT" ]; then
  ROOT=$(pwd)
fi

if [ ! -d "$ROOT" ]; then
  exit 0
fi

case "$FILE" in
  /*) ABS="$FILE" ;;
  *) ABS="$ROOT/$FILE" ;;
esac

# --- containment: full paths that affect build-plugins output ---
case "$ABS" in
  "$ROOT"/src/abstract_data/project_tools/*) ;;
  "$ROOT"/src/abstract_data/authoring/plugins.py) ;;
  "$ROOT"/src/abstract_data/authoring/plugin_manifests.py) ;;
  "$ROOT"/src/abstract_data/catalog/plugin_homes.py) ;;
  *) exit 0 ;;
esac

# Only abstract-data repos with committed payloads
if [ ! -d "$ROOT/plugins/abstract-data-claude" ]; then
  exit 0
fi

if ! command -v uv >/dev/null 2>&1; then
  exit 0
fi

cd "$ROOT" || exit 0

if ! OUT=$(uv run abstract-data build-plugins --check 2>&1); then
  {
    echo "── plugin payload drift: $FILE ──"
    echo "$OUT" | tail -40
    echo "(run: uv run abstract-data build-plugins && commit plugins/ + marketplace manifests)"
  } >&2
fi

exit 0
