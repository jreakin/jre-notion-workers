#!/usr/bin/env bash
# eval-authoring-reminder.sh — Stop hook (ADR-0015)
# Advisory only: if this session changed behavior-bearing source but evals/golden/ was not
# updated, nudge the author to add an outcome case via /eval-authoring.
# NEVER blocks — always exits 0 (respects "never block mid-plan"; writes no gate ledger entry).

set -uo pipefail

# The Stop payload (JSON on stdin) carries session_id; capture it up front so the opt-in
# enforcement branch can record into the session's gate ledger. Harmless when advisory.
STOP_PAYLOAD="$(cat 2>/dev/null || true)"

# Walk up to the project root (first ancestor with a .git dir).
PROJECT_ROOT=""
SEARCH_DIR="$(pwd)"
while [[ "$SEARCH_DIR" != "/" ]]; do
  if [[ -d "$SEARCH_DIR/.git" ]]; then
    PROJECT_ROOT="$SEARCH_DIR"
    break
  fi
  SEARCH_DIR="$(dirname "$SEARCH_DIR")"
done

# No git repo, or no eval kit deployed yet — nothing to remind about.
if [[ -z "$PROJECT_ROOT" || ! -d "$PROJECT_ROOT/evals/golden" ]]; then
  exit 0
fi

# Changed files this session (staged + unstaged vs HEAD).
CHANGED=$(git -C "$PROJECT_ROOT" diff --name-only HEAD 2>/dev/null)
[[ -z "$CHANGED" ]] && exit 0

# Behavior-bearing source changed? (.py/.ts/.tsx/.js, excluding tests and the evals/ tree).
BEHAVIOR=$(printf '%s\n' "$CHANGED" \
  | grep -E '\.(py|ts|tsx|js)$' \
  | grep -vE '(^|/)(test_|tests/|evals/)' \
  | head -1)
[[ -z "$BEHAVIOR" ]] && exit 0

# Did evals/golden/ change in the same session? If so, coverage was tended — stay quiet.
if printf '%s\n' "$CHANGED" | grep -qE '^evals/golden/'; then
  exit 0
fi

cat >&2 <<MSG
ℹ  [eval-authoring] Behavior changed this session (e.g. ${BEHAVIOR}) but evals/golden/
   was not updated. Consider adding an outcome case so the gate covers it:
       /eval-authoring         (or: abstract-data eval-outcomes .)
MSG

# Opt-in enforcement (EVAL_COVERAGE_ENFORCE=1): record a disposable check into the gate
# ledger so the loop-closure gate refuses to end the turn until a case is added (fix) or the
# omission is disposed with a reason. Default (unset) stays advisory — exit 0, no ledger
# entry — honoring "never block mid-plan". The hook itself still exits 0; the BLOCK is the
# gate reading the ledger, exactly like verify-completion.sh.
if [[ "${EVAL_COVERAGE_ENFORCE:-0}" == "1" ]]; then
  GATE="$PROJECT_ROOT/.claude/hooks/gate.py"
  [[ -f "$GATE" ]] || GATE="$HOME/.claude/hooks/gate.py"
  if [[ -f "$GATE" ]]; then
    SESSION_ID="$(
      printf '%s' "$STOP_PAYLOAD" | python3 -c 'import sys, json
try:
    print(json.load(sys.stdin).get("session_id", ""))
except Exception:
    print("")' 2>/dev/null || true
    )"
    python3 "$GATE" record-failure --check eval-coverage --status skipped \
      --detail "behavior changed (${BEHAVIOR}) without an evals/golden/ case" \
      ${SESSION_ID:+--session "$SESSION_ID"} >/dev/null 2>&1 || true
    echo "   EVAL_COVERAGE_ENFORCE=1 → recorded 'eval-coverage' (skipped); add a case or dispose it." >&2

    # Beyond mere presence: if a lint-capable CLI and a populated kit are both available,
    # run the golden-case linter. A non-zero exit (2 == golden-case violations) records a
    # FAILED 'eval-lint' check into the SAME ledger, so the gate refuses the turn until the
    # cases are fixed or the failure is disposed. Never fails if the CLI/kit is absent.
    if command -v abstract-data >/dev/null 2>&1 \
       && compgen -G "$PROJECT_ROOT/evals/golden/*.y*ml" >/dev/null 2>&1; then
      LINT_STDERR="$(abstract-data eval-outcomes "$PROJECT_ROOT" --lint 2>&1 >/dev/null)"
      LINT_RC=$?
      if [[ "$LINT_RC" -ne 0 ]]; then
        LINT_VIOLATIONS="$(printf '%s\n' "$LINT_STDERR" | grep -vE '^[[:space:]]*$' | head -3 | tr '\n' ';' | sed 's/;$//')"
        [[ -z "$LINT_VIOLATIONS" ]] && LINT_VIOLATIONS="abstract-data eval-outcomes --lint exited ${LINT_RC}"
        python3 "$GATE" record-failure --check eval-lint --status failed \
          --detail "golden-case lint violations: ${LINT_VIOLATIONS}" \
          ${SESSION_ID:+--session "$SESSION_ID"} >/dev/null 2>&1 || true
        echo "   EVAL_COVERAGE_ENFORCE=1 → recorded 'eval-lint' (failed); fix the golden cases or dispose it." >&2
      fi
    fi
  fi
else
  echo "   Advisory only — not blocking." >&2
fi

exit 0
