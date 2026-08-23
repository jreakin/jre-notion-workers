#!/usr/bin/env bash
# eval-golden-review-nudge.sh — PostToolUse hook (Bash), ADR-0015 companion
#
# Fires right after `abstract-data eval-outcomes .` runs. If evals/golden/ has
# uncommitted changes (new or modified candidate cases), nudges the agent to run the
# golden-case review pair — eval-golden-scorer, then eval-golden-critic — and present
# both viewpoints to the human BEFORE the candidate is committed into the versioned suite.
#
# Advisory by default: prints to stderr, always exits 0 (never blocks mid-turn). Set
# EVAL_GOLDEN_REVIEW_ENFORCE=1 to also record a ledger check ('eval-golden-review') so the
# Stop-time loop-closure gate (gate.py stop-check) holds the turn until the review has run
# or the omission is explicitly disposed — mirrors eval-authoring-reminder.sh's enforcement
# knob (EVAL_COVERAGE_ENFORCE).
#
# By design this only fires on `abstract-data eval-outcomes` invocations, and only when
# evals/golden/ is both present and dirty — every other Bash command, and a clean/committed
# suite, pass through silently.

set -uo pipefail

# ── Command guard: only act on `abstract-data eval-outcomes` ────────────────────────────
INPUT="$(cat 2>/dev/null || true)"
CMD=""
if command -v python3 &>/dev/null; then
  # FR-4.1: Claude nests the command under .tool_input; Cursor sends it top-level.
  CMD=$(printf '%s' "$INPUT" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    print((d.get('tool_input') or {}).get('command') or d.get('command') or '')
except Exception:
    print('')
" 2>/dev/null || true)
fi
if ! printf '%s' "$CMD" | grep -qE '(^|[^A-Za-z0-9_-])abstract[-_]data([[:space:]]+[^[:space:]]+)*[[:space:]]+eval-outcomes([[:space:]]|$)'; then
  exit 0
fi

# ── FR-4.1: host-tolerant project-root resolution ───────────────────────────────────────
# Mirrors gate.py:project_dir() exactly:
#   CLAUDE_PROJECT_DIR -> CURSOR_PROJECT_DIR -> payload .workspace_roots[0] -> .cwd -> cwd
# The old code walked up from `pwd` only, so on any host that spawns the hook outside the
# workspace it found no repo and exited 0 — a silent no-op. Extraction stays on python3
# (this handler has no jq dependency) and is guarded exactly like the command guard above.
# The ancestor walk is retained as the final fallback, so a host that sends no root signal
# at all behaves exactly as it did before.
resolve_project_root() {
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then printf '%s' "$CLAUDE_PROJECT_DIR"; return 0; fi
  if [ -n "${CURSOR_PROJECT_DIR:-}" ]; then printf '%s' "$CURSOR_PROJECT_DIR"; return 0; fi
  local root=""
  if command -v python3 &>/dev/null; then
    root=$(printf '%s' "$INPUT" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    roots = d.get('workspace_roots')
    first = roots[0] if isinstance(roots, list) and roots else None
    print(first or d.get('cwd') or '')
except Exception:
    print('')
" 2>/dev/null || true)
  fi
  if [ -n "$root" ]; then printf '%s' "$root"; return 0; fi
  pwd
}

PROJECT_ROOT="$(resolve_project_root)"

# The ancestor walk below seeds from PROJECT_ROOT, which is HOST-SUPPLIED and may be
# RELATIVE (e.g. a payload `{"cwd": "."}` or a relative CLAUDE_PROJECT_DIR). `dirname`
# never escapes a relative path — `$(dirname .)` == "." is a FIXPOINT — so a relative
# seed outside a git repo spun the walk forever and HUNG the session on a PostToolUse
# hook. The seed used to be `$(pwd)` (always absolute); absolutise it back.
case "$PROJECT_ROOT" in
  /*) ;;
  *) PROJECT_ROOT="$(cd "$PROJECT_ROOT" 2>/dev/null && pwd)" || PROJECT_ROOT="" ;;
esac
[[ -n "$PROJECT_ROOT" ]] || PROJECT_ROOT="$PWD"

if [[ ! -d "$PROJECT_ROOT/.git" ]]; then
  # Original behavior: first ancestor holding a .git dir.
  SEARCH_DIR="$PROJECT_ROOT"
  PROJECT_ROOT=""
  while [[ -n "$SEARCH_DIR" && "$SEARCH_DIR" != "/" ]]; do
    if [[ -d "$SEARCH_DIR/.git" ]]; then
      PROJECT_ROOT="$SEARCH_DIR"
      break
    fi
    PARENT_DIR="$(dirname "$SEARCH_DIR")"
    # Belt-and-braces loop guard: terminate on ANY non-advancing dirname, not just "/".
    [[ "$PARENT_DIR" == "$SEARCH_DIR" ]] && break
    SEARCH_DIR="$PARENT_DIR"
  done
fi

# No git repo, or no eval kit deployed yet — nothing to review.
if [[ -z "$PROJECT_ROOT" || ! -d "$PROJECT_ROOT/evals/golden" ]]; then
  exit 0
fi

# ── Candidate detection: golden-case files changed vs HEAD (staged + unstaged) ──────────
CHANGED_CASES=$(git -C "$PROJECT_ROOT" diff --name-only HEAD -- evals/golden 2>/dev/null)
[[ -z "$CHANGED_CASES" ]] && exit 0

cat >&2 <<MSG
ℹ  [eval-golden-review] evals/golden/ has uncommitted changes after this eval run:
$(printf '%s\n' "$CHANGED_CASES" | sed 's/^/       /')

   Before committing these as golden, run the review pair, in order:
     1) Invoke the eval-golden-scorer subagent (scores against docs/golden-case-rubric.md,
        with a real evidence ledger).
     2) Invoke the eval-golden-critic subagent against the scorer's output (independent
        re-check of the fatal dimensions; flags any disagreement instead of smoothing it over).
     3) Present BOTH viewpoints to the human, per case, and wait for an explicit
        agree/disagree before committing anything.

   For a full-suite re-audit instead of just this diff, use /eval-audit.
MSG

# Opt-in enforcement (EVAL_GOLDEN_REVIEW_ENFORCE=1): record into the same gate ledger
# eval-authoring-reminder.sh uses, so the Stop gate refuses to end the turn until the
# review has run (or the omission is disposed with a reason). Default stays advisory.
if [[ "${EVAL_GOLDEN_REVIEW_ENFORCE:-0}" == "1" ]]; then
  GATE="$PROJECT_ROOT/.claude/hooks/gate.py"
  [[ -f "$GATE" ]] || GATE="$HOME/.claude/hooks/gate.py"
  if [[ -f "$GATE" ]]; then
    # FR-4.1: Claude sends session_id; Cursor sends conversation_id (gate.py:_sid_from_payload).
    SESSION_ID="$(
      printf '%s' "$INPUT" | python3 -c 'import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get("session_id") or d.get("conversation_id") or "")
except Exception:
    print("")' 2>/dev/null || true
    )"
    python3 "$GATE" record-failure --check eval-golden-review --status skipped \
      --detail "evals/golden/ changed (${CHANGED_CASES//$'\n'/, }) without a completed scorer+critic review" \
      ${SESSION_ID:+--session "$SESSION_ID"} >/dev/null 2>&1 || true
    echo "   EVAL_GOLDEN_REVIEW_ENFORCE=1 -> recorded 'eval-golden-review' (skipped); run the review or dispose it." >&2
  fi
else
  echo "   Advisory only — not blocking." >&2
fi

exit 0
