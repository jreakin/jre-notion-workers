#!/bin/bash
# PostToolUse hook: Branch verification before PR push (portable)
# Trigger: PostToolUse matcher Bash; internal guard fires only on `git push` / `but push`.
# Severity: BLOCK on failed deterministic checks (Phase 1).
#
# Phase 1 (always, deterministic): runs whatever of the project's frontend
# (tsc/test/lint via the detected package manager) and Python (ruff/mypy/pytest
# via uv) toolchains are actually present, plus a lazy-pattern scan over the
# branch diff. Each check is guarded on both the directory AND the tool existing,
# so it never hard-fails just because a toolchain is absent.
#
# Phase 2 (OPT-IN, semantic): spawns a `claude -p` adversarial review of the
# branch diff. OFF by default — enable with ABSTRACT_DATA_VERIFY_SUBMIT_AI=1
# (requires the `claude` CLI on PATH). Heavy; only for projects that want it.
#
# Config:
#   ABSTRACT_DATA_TRUNK            override trunk branch (else origin/HEAD → main…)
#   ABSTRACT_DATA_VERIFY_SUBMIT_AI=1   enable the Phase 2 AI review

set -euo pipefail

INPUT=$(cat)

# --- FR-4.1: host-tolerant payload accessors ---------------------------------------
# This script runs `set -e`, so every jq expression below carries `|| VAR=…`: jq exits
# non-zero on a malformed payload and a bare assignment would abort the hook.
#
# resolve_command_cwd returns THE DIRECTORY THE PUSH RAN IN — not the session's project
# root. Trunk detection, DIFF_BASE, the branch diff and the toolchain probes below are all
# scoped to the tree the push came from, so a worker pushing from a linked `git worktree`
# must be verified against THAT worktree's branch.
#
# Order (payload first, host chain only as fallback):
#   payload .cwd -> CLAUDE_PROJECT_DIR -> CURSOR_PROJECT_DIR -> .workspace_roots[0] -> cwd
#
# FR-4.1 is still satisfied: Cursor sends `.workspace_roots` and no `.cwd`, so the chain
# resolves there. But CLAUDE_PROJECT_DIR must NOT come first — Claude Code always exports
# it, which would make the `.cwd` leg dead and diff the session root's branch instead.
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

# --- Command guard: only act on a push / PR publish ---
# ``but pr new`` auto-pushes and creates the review; matching only ``but push``/
# ``git push`` let PR publishes skip the pytest gate (PR #274 XPASS fallout).
GUARD_CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // .command // ""' 2>/dev/null) ||
  GUARD_CMD=""
case "$GUARD_CMD" in
  *"but push"* | *"git push"* | *"but pr "* | *"gh pr create"*) ;;
  *) exit 0 ;;
esac

CWD=$(resolve_command_cwd) || CWD="$PWD"
[ -n "$CWD" ] || CWD="$PWD"
cd "$CWD" 2>/dev/null || exit 0

# --- Determine trunk branch (no hardcoded name) ---
detect_trunk() {
  if [[ -n "${ABSTRACT_DATA_TRUNK:-}" ]]; then printf '%s' "$ABSTRACT_DATA_TRUNK"; return; fi
  local ref
  if ref=$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null); then
    printf '%s' "${ref##*/}"; return
  fi
  local b
  for b in main master preview trunk; do
    if git show-ref --verify --quiet "refs/heads/$b" 2>/dev/null; then printf '%s' "$b"; return; fi
  done
  printf 'main'
}
TRUNK=$(detect_trunk)
# Diff base: trunk if it exists locally, else just HEAD's first parent.
DIFF_BASE="$TRUNK"
git rev-parse --verify --quiet "$TRUNK" >/dev/null 2>&1 || DIFF_BASE="HEAD~1"

ERRORS=""
WARNINGS=""
TMPDIR_V=$(mktemp -d 2>/dev/null || echo "/tmp")

have() { command -v "$1" >/dev/null 2>&1; }

# Detect the JS package manager from the lockfile (bun/pnpm/yarn/npm).
detect_pm() {
  local dir="$1"
  if [[ -f "$dir/bun.lockb" || -f "$dir/bun.lock" ]]; then echo bun
  elif [[ -f "$dir/pnpm-lock.yaml" ]]; then echo pnpm
  elif [[ -f "$dir/yarn.lock" ]]; then echo yarn
  elif [[ -f "$dir/package-lock.json" ]]; then echo npm
  else echo ""; fi
}

# Does package.json declare this npm script?
has_script() { grep -qE "\"$2\"[[:space:]]*:" "$1/package.json" 2>/dev/null; }

# ============================================================
# PHASE 1: Automated verification (fast, deterministic)
# ============================================================

# --- Frontend (only if a JS project + its package manager are present) ---
for FE in frontend .; do
  [[ -f "$FE/package.json" ]] || continue
  PM=$(detect_pm "$FE")
  [[ -n "$PM" ]] && have "$PM" || continue
  if has_script "$FE" "tsc" || [[ -f "$FE/tsconfig.json" ]]; then
    if has_script "$FE" build && ! (cd "$FE" && "$PM" run tsc --noEmit >"$TMPDIR_V/tsc" 2>&1); then
      ERRORS+="TSC FAILED:\n$(tail -20 "$TMPDIR_V/tsc")\n\n"
    fi
  fi
  if has_script "$FE" test && ! (cd "$FE" && "$PM" run test >"$TMPDIR_V/test" 2>&1); then
    ERRORS+="TESTS FAILED:\n$(tail -30 "$TMPDIR_V/test")\n\n"
  fi
  if has_script "$FE" lint && ! (cd "$FE" && "$PM" run lint >"$TMPDIR_V/lint" 2>&1); then
    ERRORS+="LINT FAILED:\n$(tail -20 "$TMPDIR_V/lint")\n\n"
  fi
  break
done

# --- Python (backend/ or repo root; only if changed + uv present) ---
for BE in backend .; do
  [[ -f "$BE/pyproject.toml" ]] || continue
  have uv || break
  CHANGED=$(git diff --name-only "$DIFF_BASE"...HEAD -- "$BE" 2>/dev/null || true)
  [[ -n "$CHANGED" ]] || break
  SRC="src"; [[ -d "$BE/src" ]] || SRC="."
  if ! (cd "$BE" && uv run ruff check "$SRC" >"$TMPDIR_V/ruff" 2>&1); then
    ERRORS+="RUFF FAILED:\n$(tail -20 "$TMPDIR_V/ruff")\n\n"
  fi
  if ! (cd "$BE" && uv run pytest --tb=short -q >"$TMPDIR_V/pytest" 2>&1); then
    ERRORS+="PYTEST FAILED:\n$(tail -30 "$TMPDIR_V/pytest")\n\n"
  fi
  break
done

# --- Lazy-pattern scan across the branch diff (always) ---
LAZY_PATTERNS='(\bTODO\b|\bFIXME\b|\bHACK\b|\bXXX\b|\bSTUB\b|\bHARDCODED\b|\.only\(|\.skip\(|console\.log|debugger\b|raise NotImplementedError)'
LAZY=$(git diff "$DIFF_BASE"...HEAD --unified=0 -- '*.ts' '*.tsx' '*.py' '*.js' '*.jsx' 2>/dev/null \
  | grep -E '^\+' | grep -viE '^\+\+\+' | grep -iE "$LAZY_PATTERNS" || true)
[[ -n "$LAZY" ]] && WARNINGS+="LAZY PATTERNS in branch diff:\n$(echo "$LAZY" | head -20)\n\n"

# Block immediately on any deterministic failure.
if [[ -n "$ERRORS" ]]; then
  rm -rf "$TMPDIR_V" 2>/dev/null || true
  if is_claude_host; then
    jq -n --arg reason "$ERRORS" --arg warnings "$WARNINGS" '{
      decision: "block",
      reason: "Branch failed automated verification. Fix before submitting PR.",
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: ($reason + $warnings + "\nNO COMPLETION CLAIMS WITHOUT FRESH EVIDENCE.")
      }
    }'
  else
    # FR-4.2: no other bundled host understands Claude's PostToolUse permission envelope.
    # Follow the bundle's PostToolUse convention instead — findings on stderr, exit 0.
    echo -e "$ERRORS" >&2
    if [[ -n "$WARNINGS" ]]; then echo -e "$WARNINGS" >&2; fi
    echo "NO COMPLETION CLAIMS WITHOUT FRESH EVIDENCE." >&2
  fi
  exit 0
fi

# ============================================================
# PHASE 2: AI-powered adversarial review (OPT-IN, semantic)
# ============================================================
if [[ "${ABSTRACT_DATA_VERIFY_SUBMIT_AI:-0}" == "1" ]] && have claude; then
  BRANCH_DIFF=$(git diff "$DIFF_BASE"...HEAD 2>/dev/null | head -3000)
  COMMIT_LOG=$(git log "$DIFF_BASE"..HEAD --format="%h %s" 2>/dev/null)
  DIFFSTAT=$(git diff --stat "$DIFF_BASE"...HEAD 2>/dev/null)
  COMMIT_COUNT=$(git log "$DIFF_BASE"..HEAD --oneline 2>/dev/null | wc -l | tr -d ' ')

  # Empty-input guard (issue #29): with no branch diff / 0 commits vs base there is nothing to
  # review. An LLM handed an empty diff does NOT no-op — it confabulates a phantom FAIL review
  # (invented file:line issues, fabricated session ids, a fake task-critic BLOCK) and hard-blocks
  # the push. Never invoke the reviewer without real input; exit clean instead.
  if [ "${COMMIT_COUNT:-0}" -eq 0 ] || [ -z "$BRANCH_DIFF" ]; then
    exit 0
  fi

  REVIEW_PROMPT=$(cat <<'PROMPT_END'
You are an adversarial code reviewer. Your job is to find problems, not confirm success.

IRON LAW: NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE.
"The author said it's done" is NOT evidence. The diff IS the evidence. If you
cannot verify a claim from the diff, it is NOT verified.

Review the diff against this checklist. For each, state PASS or FAIL with
specific file:line evidence:

1. SPEC COMPLIANCE — does the diff implement ALL of what the commit messages claim?
   Look for partial implementations.
2. STUB DETECTION — functions declared but not implemented, NotImplementedError,
   placeholder returns, hardcoded values that should be dynamic, "implement later".
3. TEST COVERAGE — tests added/updated for new code, testing real behavior (not
   true===true), covering error paths, not just happy path.
4. ERROR HANDLING — new code handles error cases, not only the happy path.
5. COMPLETENESS — no loose ends: missing imports, dead code, unresolved TODO/FIXME.
6. CODE REUSE — duplicated logic that should be extracted; existing project
   utilities reused rather than reimplemented. Same logic in 2+ places = FAIL.
7. DESIGN PATTERNS — follows established project patterns; separation of concerns;
   new abstractions justified (neither over- nor under-abstracted).
8. TYPE SAFETY — no `any`/`as any`/assertions papering over mismatches without
   justification; clear signatures; type hints on Python functions.

OUTPUT FORMAT:
Line 1 MUST be exactly: PASS or FAIL (nothing else on this line).
Then: ### Checklist Results (per item: number, PASS/FAIL, 1-line evidence),
### Issues (Critical / Important / Minor, each with file:line + fix),
### Assessment (Ready to merge? + 1-2 sentence reasoning).

RULES: Never say "looks good" without citing diff evidence. Never PASS an item you
cannot prove from the diff. If the diff is truncated and a claim is unverifiable,
mark it INCONCLUSIVE (treat as FAIL). Be specific with file:line. Acknowledge strengths.
PROMPT_END
)

  REVIEW_INPUT=$(cat <<EOF
BRANCH: $(git branch --show-current 2>/dev/null || echo "unknown")
COMMITS ($COMMIT_COUNT):
$COMMIT_LOG

DIFFSTAT:
$DIFFSTAT

DIFF (truncated to 3000 lines):
$BRANCH_DIFF
EOF
)

  REVIEW_RESULT=$(echo "$REVIEW_INPUT" | claude -p "$REVIEW_PROMPT" --output-format text 2>/dev/null || echo "FAIL: Reviewer subagent failed to execute")
  VERDICT=$(echo "$REVIEW_RESULT" | head -1 | tr -d '[:space:]' | grep -oE '^(PASS|FAIL)' || echo "FAIL")

  if [[ "$VERDICT" == "FAIL" ]]; then
    REVIEW_TRUNCATED=$(echo "$REVIEW_RESULT" | head -60)
    BLOCK_REASON="AI REVIEWER VERDICT: FAIL\n\n$REVIEW_TRUNCATED"
    [[ -n "$WARNINGS" ]] && BLOCK_REASON+="\n\nADDITIONAL WARNINGS:\n$WARNINGS"
    rm -rf "$TMPDIR_V" 2>/dev/null || true
    if is_claude_host; then
      jq -n --arg reason "$BLOCK_REASON" '{
        decision: "block",
        reason: "Branch failed AI review. Address the issues before submitting.",
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: ($reason + "\n\nNO COMPLETION CLAIMS WITHOUT FRESH EVIDENCE. Fix the MUST FIX items, then retry your push.")
        }
      }'
    else
      # FR-4.2: findings on stderr, exit 0 — the bundle's PostToolUse convention.
      echo -e "$BLOCK_REASON" >&2
      echo "NO COMPLETION CLAIMS WITHOUT FRESH EVIDENCE. Fix the MUST FIX items, then retry your push." >&2
    fi
    exit 0
  fi
fi

rm -rf "$TMPDIR_V" 2>/dev/null || true

# Surface non-blocking warnings, if any.
if [[ -n "$WARNINGS" ]]; then
  echo -e "$WARNINGS" >&2
fi

exit 0
