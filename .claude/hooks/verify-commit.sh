#!/bin/bash
# PostToolUse hook: Lightweight Commit Verification (portable)
# Trigger: PostToolUse matcher Bash; internal guard fires only on `git commit`.
# Severity: BLOCK on stub implementations in new files, WARN on lazy patterns.
#
# Catches lazy/incomplete work without slowing iteration. Language-agnostic
# (scans *.ts/*.tsx/*.py/*.js/*.jsx). The heavy AI review runs at push time.

set -euo pipefail

INPUT=$(cat)

# --- FR-4.1: host-tolerant payload accessors ---------------------------------------
# This script runs `set -e`, so every jq expression below carries `|| true` / `|| VAR=…`:
# jq exits non-zero on a malformed payload and a bare assignment would abort the hook.
#
# resolve_command_cwd returns THE DIRECTORY THE COMMAND RAN IN — not the session's
# project root. Everything downstream is a git query about the tree the commit landed
# in (`git rev-parse HEAD~1`, `git diff HEAD~1 HEAD`, `--diff-filter=A`), so a batch
# worker committing inside a linked `git worktree` must be scanned in THAT worktree.
#
# Order (payload first, host chain only as fallback):
#   payload .cwd -> CLAUDE_PROJECT_DIR -> CURSOR_PROJECT_DIR -> .workspace_roots[0] -> cwd
#
# FR-4.1 is still satisfied: Cursor sends `.workspace_roots` and no `.cwd`, so the chain
# resolves there. But CLAUDE_PROJECT_DIR must NOT come first — Claude Code always exports
# it, which would make the `.cwd` leg dead and run every git query in the session root.
#
# The old `.cwd // "."` default stays gone: `"."` is never empty, so it shadowed the rest
# of the chain and made `cd` succeed against the wrong directory. Only a genuinely
# ABSENT/empty `.cwd` may fall through here.
resolve_command_cwd() {
  local cwd="" root=""
  cwd=$(printf '%s' "$INPUT" | jq -r '.cwd? // empty' 2>/dev/null) || cwd=""
  if [ -n "$cwd" ] && [ "$cwd" != "null" ]; then printf '%s' "$cwd"; return 0; fi
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then printf '%s' "$CLAUDE_PROJECT_DIR"; return 0; fi
  if [ -n "${CURSOR_PROJECT_DIR:-}" ]; then printf '%s' "$CURSOR_PROJECT_DIR"; return 0; fi
  root=$(printf '%s' "$INPUT" | jq -r '.workspace_roots[0]? // empty' 2>/dev/null) || root=""
  if [ -n "$root" ] && [ "$root" != "null" ]; then printf '%s' "$root"; return 0; fi
  pwd
}

# FR-4.2: emit the Claude PostToolUse permission envelope ONLY on a Claude-shaped signal.
# Cursor injects no project-dir environment variable, so a "not Cursor" test could never
# fire and the envelope would leak to every non-Claude host. Discriminate POSITIVELY on
# Claude, with the Cursor payload markers gate.py:_harness() uses as an explicit veto.
is_claude_host() {
  if printf '%s' "$INPUT" |
    jq -e 'has("conversation_id") or has("cursor_version") or has("generation_id")' \
      >/dev/null 2>&1; then
    return 1
  fi
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then return 0; fi
  local ev="" sid=""
  ev=$(printf '%s' "$INPUT" | jq -r '.hook_event_name // empty' 2>/dev/null) || ev=""
  case "$ev" in
    PreToolUse | PostToolUse | Stop | SubagentStop | SessionStart | SessionEnd | \
      UserPromptSubmit | Notification | PreCompact) return 0 ;;
  esac
  sid=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null) || sid=""
  [ -n "$sid" ]
}

# --- Command guard: only act on git commit ---
GUARD_CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // .command // ""' 2>/dev/null) ||
  GUARD_CMD=""
case "$GUARD_CMD" in *"git commit"*) ;; *) exit 0 ;; esac

# Skip if the commit itself failed. Claude reports it under .tool_response.exitCode;
# accept the snake_case spellings other harnesses use before falling back to "1" (skip).
EXIT_CODE=$(printf '%s' "$INPUT" |
  jq -r '.tool_response.exitCode // .tool_response.exit_code // .exit_code // "1"' 2>/dev/null) ||
  EXIT_CODE="1"
[[ "$EXIT_CODE" != "0" ]] && exit 0

CWD=$(resolve_command_cwd) || CWD="$PWD"
[ -n "$CWD" ] || CWD="$PWD"
cd "$CWD" 2>/dev/null || exit 0

# Need at least one parent commit to diff against (skip the root commit)
git rev-parse --verify --quiet HEAD~1 >/dev/null 2>&1 || exit 0

ERRORS=""
WARNINGS=""

# --- 1. Lazy-pattern scan on the committed diff ---
LAZY_PATTERNS='(\bTODO\b|\bFIXME\b|\bHACK\b|\bXXX\b|\bSTUB\b|\bHARDCODED\b|\.only\(|\.skip\(|console\.log|debugger\b|raise NotImplementedError)'
LAZY=$(git diff HEAD~1 --unified=0 -- '*.ts' '*.tsx' '*.py' '*.js' '*.jsx' 2>/dev/null \
  | grep -E '^\+' \
  | grep -viE '^\+\+\+' \
  | grep -iE "$LAZY_PATTERNS" || true)

if [[ -n "$LAZY" ]]; then
  WARNINGS+="VERIFY-COMMIT: Suspicious patterns found in committed diff:\n"
  WARNINGS+="$(echo "$LAZY" | head -15)\n"
  WARNINGS+="These may indicate incomplete work (TODOs, stubs, debug statements).\n"
  WARNINGS+="If intentional, proceed. Otherwise, amend the commit.\n\n"
fi

# --- 2. Empty or trivially small commits ---
FILES_CHANGED=$(git diff --stat HEAD~1 HEAD 2>/dev/null | tail -1 || echo "")
INSERTIONS=$(echo "$FILES_CHANGED" | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+' || echo "0")
[[ -z "$INSERTIONS" ]] && INSERTIONS=0

if [[ "$INSERTIONS" -lt 3 ]]; then
  WARNINGS+="VERIFY-COMMIT: Very small commit ($INSERTIONS insertions). "
  WARNINGS+="Ensure this isn't a stub or placeholder commit.\n\n"
fi

# --- 3. Stub patterns in newly added files ---
# Scoped to the same code pathspec the lazy scan uses (abstract-data#332): without it an
# added .md was scanned as source, and the unanchored `pass$` / `...` patterns matched
# ordinary prose — a sentence ending in an ellipsis, or a line ending in the word "pass"
# — and hard-blocked the commit. The stub regexes are anchored for the same reason: only
# a `pass` / `...` STATEMENT BODY is a stub, not an inline mention of either. The leading
# `(^|:)` keeps the one-line form in scope — `def do_work(): pass` and the Protocol idiom
# `def m(self) -> int: ...` are exactly the stubs this scan exists to catch — while still
# rejecting prose like `# the suite has to pass` or `note = "weighed options..."`.
# NOTE: the pathspec also narrows the scan to those five extensions, so a newly added
# .go/.rs/.java/.rb/.sh stub is no longer inspected (the `// implement` alternative is now
# reachable only for .ts/.tsx/.js/.jsx). That is the same blind spot the lazy scan on line
# 88 already has; widening both is a separate change.
NEW_FILES=$(git diff --name-only --diff-filter=A HEAD~1 HEAD -- '*.ts' '*.tsx' '*.py' '*.js' '*.jsx' 2>/dev/null || true)
for f in $NEW_FILES; do
  if [[ -f "$f" ]]; then
    STUBS=$(grep -nE '(raise NotImplementedError|(^|:)\s*pass\s*$|return null|return undefined|(^|:)\s*\.\.\.\s*$|// implement)' "$f" 2>/dev/null | head -5 || true)
    if [[ -n "$STUBS" ]]; then
      ERRORS+="VERIFY-COMMIT: New file '$f' contains stub implementations:\n"
      ERRORS+="$STUBS\n"
      ERRORS+="Complete the implementation before proceeding.\n\n"
    fi
  fi
done

# --- Output ---
if [[ -n "$ERRORS" ]]; then
  if is_claude_host; then
    jq -n --arg reason "$ERRORS" --arg warnings "$WARNINGS" '{
      decision: "block",
      reason: "Commit verification failed. Evidence of incomplete work found.",
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: ($reason + "\n" + $warnings + "\nNO COMPLETION CLAIMS WITHOUT FRESH EVIDENCE. Fix the issues above before proceeding.")
      }
    }'
  else
    # FR-4.2: no other bundled host understands Claude's PostToolUse permission envelope.
    # Follow the bundle's PostToolUse convention instead — findings on stderr, exit 0.
    echo -e "$ERRORS" >&2
    if [[ -n "$WARNINGS" ]]; then echo -e "$WARNINGS" >&2; fi
    echo "NO COMPLETION CLAIMS WITHOUT FRESH EVIDENCE. Fix the issues above before proceeding." >&2
  fi
  exit 0
fi

if [[ -n "$WARNINGS" ]]; then
  echo -e "$WARNINGS" >&2
fi

exit 0
