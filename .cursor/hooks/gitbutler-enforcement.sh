#!/bin/bash
# PreToolUse hook: GitButler branch enforcement (portable / self-gating)
# Trigger: PreToolUse matcher Bash. Severity: BLOCK (with worktree exception).
#
# Blocks raw git branch/commit/rebase in agent sessions to steer toward a GitButler
# (`but`) workflow. This hook is SELF-GATING: it does nothing (exit 0) unless the
# project actually uses GitButler, so it is safe to bundle/register by default.
#
# Enable when:  `.git/gitbutler/` exists  OR  ABSTRACT_DATA_ENFORCE_GITBUTLER=1
# Trunk branch: ABSTRACT_DATA_TRUNK, else origin/HEAD, else main/master/preview.
#
# WORKTREE EXCEPTION: inside a linked git worktree, `git commit` is ALLOWED (batch
# workers commit locally). Branch creation and rebase stay blocked. A commit on a
# generic batch-branch name produces a NUDGE (no block).
# Direct commits to the trunk branch are ALWAYS blocked, even in worktrees.

set -euo pipefail

INPUT=$(cat)
# FR-4.1: Claude nests the command under .tool_input; Cursor sends it top-level.
COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // .command // ""' 2>/dev/null || true)

# --- FR-4.1: host-tolerant working-directory resolution -----------------------------
# resolve_command_cwd returns THE DIRECTORY THE COMMAND RAN IN — not the session's project
# root. Every decision below is a git query about that tree: the `.git/gitbutler` self-gate
# (git-common-dir), the WORKTREE EXCEPTION (git-dir vs git-common-dir) and CURRENT_BRANCH.
# Resolving to the session root instead makes IS_WORKTREE false for a real worktree commit
# and reads the branch from the MAIN tree, which fires a FALSE "Direct commits to <trunk>"
# block against the very worktree flow this hook documents as ALLOWED.
#
# Order (payload first, host chain only as fallback):
#   payload .cwd -> CLAUDE_PROJECT_DIR -> CURSOR_PROJECT_DIR -> .workspace_roots[0] -> cwd
#
# FR-4.1 is still satisfied: Cursor sends `.workspace_roots` and no `.cwd`, so the chain
# resolves there. But CLAUDE_PROJECT_DIR must NOT come first — Claude Code always exports
# it, which would make the `.cwd` leg dead on Claude.
#
# The old `.cwd // "."` default stays gone: `"."` is never empty, so it shadowed the rest of
# the chain and let the self-gate below see no `.git/gitbutler` — silent non-enforcement.
# Only a genuinely ABSENT/empty `.cwd` may fall through here.
# Every chain expression carries `|| true` / `|| VAR=…` because this script runs `set -e`.
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

CWD=$(resolve_command_cwd) || CWD="$PWD"
[ -n "$CWD" ] || CWD="$PWD"

# --- Command guard: only act on git branch/commit/rebase commands ---
case "$COMMAND" in
  *"git checkout -b"*|*"git branch "*|*"git switch -c"*|*"git switch --create"*|*"git commit"*|*"git rebase"*) ;;
  *) exit 0 ;;
esac

# --- Effective cwd: honor a leading `cd <dir> && …` so worktree detection sees
#     the shell's real directory, not just the harness-tracked .cwd (issue #5) ---
EFFECTIVE_CWD="$CWD"
CD_TARGET=$(printf '%s' "$COMMAND" | sed -nE 's/^[[:space:]]*cd[[:space:]]+([^&;|]+).*/\1/p' | head -1 | sed 's/[[:space:]]*$//')
if [[ -n "$CD_TARGET" ]]; then
  case "$CD_TARGET" in
    /*) EFFECTIVE_CWD="$CD_TARGET" ;;
    *)  EFFECTIVE_CWD="$CWD/$CD_TARGET" ;;
  esac
fi
cd "$EFFECTIVE_CWD" 2>/dev/null || cd "$CWD" 2>/dev/null || true

# --- Self-gate: only enforce in GitButler projects (unless forced) ---
GIT_COMMON_DIR=$(git rev-parse --git-common-dir 2>/dev/null || echo "")
if [[ "${ABSTRACT_DATA_ENFORCE_GITBUTLER:-0}" != "1" ]]; then
  if [[ -z "$GIT_COMMON_DIR" || ! -d "$GIT_COMMON_DIR/gitbutler" ]]; then
    exit 0
  fi
fi

# --- Detect trunk branch (no hardcoded name) ---
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

# --- Detect linked worktree: absolute git-dir differs from the shared common dir ---
IS_WORKTREE="false"
GD=$(git rev-parse --absolute-git-dir 2>/dev/null || echo "")
GCD=$( (cd "$GIT_COMMON_DIR" 2>/dev/null && pwd) || echo "")
if [[ -n "$GD" && -n "$GCD" && "$GD" != "$GCD" ]]; then
  IS_WORKTREE="true"
fi

# --- Current branch ---
CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo "")

# --- Generic batch-branch name (worktree-agent-* / worker-N / agent-*) ---
IS_GENERIC_BATCH_BRANCH="false"
if [[ "$CURRENT_BRANCH" =~ ^worktree-agent-[a-z0-9]+$ ]] || \
   [[ "$CURRENT_BRANCH" =~ ^worker-?[0-9]+$ ]] || \
   [[ "$CURRENT_BRANCH" =~ ^agent-[a-z0-9]+$ ]]; then
  IS_GENERIC_BATCH_BRANCH="true"
fi

# --- Block: git checkout -b (create new branch) ---
if printf '%s' "$COMMAND" | grep -qE '(^|&&|;|\| )[[:space:]]*git checkout -b\b'; then
  jq -n '{
    decision: "block",
    reason: "Use GitButler for branch creation.",
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: "BLOCKED: raw `git checkout -b` in agent sessions.\n\nUse **GitButler** (`but`) for branch/PR work."
    }
  }'
  exit 0
fi

# --- Block: git branch <name> (create branch without switching) ---
if printf '%s' "$COMMAND" | grep -qE '(^|&&|;|\| )[[:space:]]*git branch [^-]'; then
  jq -n '{
    decision: "block",
    reason: "Use GitButler for branch creation.",
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: "BLOCKED: raw `git branch` for new branches.\n\nUse **GitButler** (`but`)."
    }
  }'
  exit 0
fi

# --- Block: git switch -c / --create ---
if printf '%s' "$COMMAND" | grep -qE '(^|&&|;|\| )[[:space:]]*git switch (-c|--create)\b'; then
  jq -n '{
    decision: "block",
    reason: "Use GitButler for branch creation.",
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: "BLOCKED: raw `git switch -c`.\n\nUse **GitButler** (`but`)."
    }
  }'
  exit 0
fi

# --- Block/Allow: git commit ---
if printf '%s' "$COMMAND" | grep -qE '(^|&&|;|\| )[[:space:]]*git commit\b'; then

  # ALWAYS block commits to the trunk branch
  if [[ -n "$TRUNK" && "$CURRENT_BRANCH" == "$TRUNK" ]]; then
    jq -n --arg trunk "$TRUNK" '{
      decision: "block",
      reason: ("Never commit directly to " + $trunk + "."),
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: ("BLOCKED: Direct commits to `" + $trunk + "` (the trunk) are forbidden.\n\nWork on a feature branch (GitButler lane), push, and open a PR.")
      }
    }'
    exit 0
  fi

  # ALLOW git commit in worktrees (batch workers need this)
  if [[ "$IS_WORKTREE" == "true" ]]; then
    if [[ "$IS_GENERIC_BATCH_BRANCH" == "true" ]]; then
      jq -n --arg branch "$CURRENT_BRANCH" '{
        decision: "approve",
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: ("⚠️ Worktree commit on generic branch `" + $branch + "`. Commit is allowed, but BEFORE merge-back, rename to a descriptive `<phase>/<unit-slug>` so the orchestrator can map it to a lane:\n  git branch -m " + $branch + " <phase>/<unit-slug>")
        }
      }'
      exit 0
    fi
    exit 0
  fi

  # BLOCK git commit in the main working tree
  if printf '%s' "$COMMAND" | grep -qE '\-\-amend'; then
    jq -n '{
      decision: "block",
      reason: "Use GitButler / coordinated amend flow.",
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: "BLOCKED: `git commit --amend` from the main agent working tree.\n\nUse your **GitButler** lane workflow (or worktree batch flow)."
      }
    }'
    exit 0
  fi

  # Portable commit-message extraction (BSD grep has no -P; issue: macOS crash)
  MSG=$(printf '%s' "$COMMAND" | sed -nE 's/.*-m[[:space:]]+"([^"]*)".*/\1/p' | head -1)
  if [[ -z "$MSG" ]]; then
    MSG=$(printf '%s' "$COMMAND" | sed -nE "s/.*-m[[:space:]]+'([^']*)'.*/\1/p" | head -1)
  fi
  [[ -z "$MSG" ]] && MSG="your commit message"

  jq -n --arg msg "$MSG" '{
    decision: "block",
    reason: "Use GitButler / worktree commit flow.",
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: ("BLOCKED: raw `git commit` in the main working tree.\n\nUse **GitButler** or a git worktree batch flow.\n\nIntended message: " + $msg)
    }
  }'
  exit 0
fi

# --- Block: git rebase --continue ---
if printf '%s' "$COMMAND" | grep -qE '(^|&&|;|\| )[[:space:]]*git rebase --continue'; then
  jq -n '{
    decision: "block",
    reason: "Complete rebases via GitButler / team workflow.",
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: "BLOCKED: `git rebase --continue` in this agent hook context.\n\nFinish the rebase using **GitButler** or plain git per your runbook."
    }
  }'
  exit 0
fi

# --- Block: git rebase (allow --abort for recovery) ---
if printf '%s' "$COMMAND" | grep -qE '(^|&&|;|\| )[[:space:]]*git rebase\b'; then
  if printf '%s' "$COMMAND" | grep -qE '\-\-abort'; then
    exit 0
  fi
  jq -n '{
    decision: "block",
    reason: "Use GitButler / team sync for rebasing.",
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: "BLOCKED: raw `git rebase` in agent sessions.\n\nUse **GitButler** lane/stack operations."
    }
  }'
  exit 0
fi

# Allow everything else
exit 0
