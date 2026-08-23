#!/bin/bash
# PostToolUse hook: nudge when a top-level package manifest's lockfile is out of sync
# Project: abstract-data
# Tool: Edit|Write
# Severity: WARN (exit 0, message to stderr)
#
# FR-P.1 (package-change-hooks v0.2.0). When pyproject.toml / uv.lock or
# package.json / package-lock.json is written at the PROJECT ROOT, re-check the
# corresponding lockfile so the drift surfaces in the same turn rather than in CI.
# A nudge only: never re-resolves, never writes, never blocks.
#
# Four deliberate choices, each of which has a silently-wrong alternative:
#   * containment compares the FULL absolute path against the four exact top-level
#     manifests — NOT the basename. This repo really does carry
#     workers/packages/package.json (plus four more vendored/fixture package.json
#     files); a basename match would `cd` to the root and check the WRONG lockfile,
#     nudging on every edit to a subpackage that this version does not cover.
#   * `npm ci --dry-run --offline` — the `--offline` is load-bearing, NOT an
#     optimization. It puts npm's cache in only-if-cached mode, so zero network
#     requests are issued and a registry outage cannot influence the result.
#     Measured with real fixtures: in-sync lock -> exit 0; drifted lock -> non-zero;
#     clean lock with a COLD (empty) cache -> exit 0, i.e. no false positive.
#     Plain `npm ci --dry-run` would reach the network and report an outage as drift.
#     Consequently there is deliberately NO network-error-text grepping fallback
#     here: it would be dead code guarding a case that cannot occur.
#   * `uv lock --check` — checks only. It is the read-only form; `uv lock` (no flag)
#     would rewrite the lockfile the hook is supposed to be merely reporting on.
#   * `cd` to the project root before either command, because both `uv` and `npm`
#     resolve their project from the current working directory (precedent:
#     changed-file-test.sh, ruff-and-ty-check.sh).
#
# Missing tool, or the JS branch with no lockfile, runs nothing and says nothing.

read -r INPUT

FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // .file_path // empty' 2>/dev/null)

if [ -z "$FILE" ]; then
  exit 0
fi

# --- project root: gate.py's chain (CLAUDE → CURSOR → workspace_roots[0] → cwd → pwd) ---
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

# --- containment: the four exact top-level manifests, full path, nothing nested ---
case "$ABS" in
  "$ROOT"/pyproject.toml | "$ROOT"/uv.lock) ECOSYSTEM="python" ;;
  "$ROOT"/package.json | "$ROOT"/package-lock.json) ECOSYSTEM="js" ;;
  *) exit 0 ;;
esac

cd "$ROOT" || exit 0

if [ "$ECOSYSTEM" = "python" ]; then
  if ! command -v uv >/dev/null 2>&1; then
    exit 0
  fi

  # No lockfile is NOT drift — it means this project does not use uv. `uv lock --check`
  # against a poetry/pdm/pip project (a pyproject.toml with no uv.lock beside it) reports
  # the missing lockfile as a failure, which this hook would relay as "lockfile drift": a
  # 100%-false WARN on EVERY edit of that file, whose remediation (`uv lock`) would create
  # a lockfile the project does not want. This is the exact symmetric counterpart of the
  # JS branch's `[ ! -f package-lock.json ]` guard below; its absence was the single
  # highest-severity finding, raised independently by three review lenses. `language = []`
  # on the manifest row fans this hook out to every profile, so the blast radius would be
  # every managed non-uv Python project.
  if [ ! -f uv.lock ]; then
    exit 0
  fi

  if ! OUT=$(uv lock --check 2>&1); then
    # tail: uv leads with its resolution log and puts `error:`/`hint:` LAST.
    {
      echo "── lockfile drift: $FILE ──"
      echo "$OUT" | tail -30
      echo "(uv.lock is out of sync with pyproject.toml — fix: uv lock)"
    } >&2
  fi
else
  if ! command -v npm >/dev/null 2>&1; then
    exit 0
  fi

  if [ ! -f package-lock.json ]; then
    exit 0
  fi

  if ! OUT=$(npm ci --dry-run --offline 2>&1); then
    # head, NOT tail: npm's EUSAGE drift report leads with the error code and one
    # `Missing: <pkg> from lock file` line per drifted dependency, then dumps ~20
    # lines of `npm ci` usage boilerplate. tail -30 would clip the diagnostic and
    # print only the boilerplate once a few dependencies are out of sync.
    {
      echo "── lockfile drift: $FILE ──"
      echo "$OUT" | head -30
      echo "(package-lock.json is out of sync with package.json — fix: npm install)"
    } >&2
  fi
fi

exit 0
