#!/usr/bin/env bash
# verify-completion.sh — repo completion gate (wired as a Stop hook).
#
# Two jobs, in order:
#   1. Keep the enforcement-gate ledger persistent. The gate writes to
#      .claude/state/, which is gitignored and gets cleaned by the GitButler
#      worktree between turns — wiping the task-critic verdict. We relocate the
#      ledger to a stable store OUTSIDE the worktree and restore the symlink here,
#      every turn-end, BEFORE gate.py stop-check reads it.
#   2. Run this repo's checks and record failures into the ledger so the
#      loop-closure gate can refuse to end the turn on an undisposed failure.
#
# ALWAYS exits 0 — the BLOCK is enforced by gate.py reading the ledger.
set -uo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
GATE="$PROJECT_DIR/.claude/hooks/gate.py"
# Fall back to the machine-global gate (~/.claude/hooks/gate.py) so a deployed
# project (which gets no local gate.py) still feeds the global enforcement gate.
[ -f "$GATE" ] || GATE="$HOME/.claude/hooks/gate.py"
[ -f "$GATE" ] || exit 0  # gate not installed anywhere; nothing to enforce

# ── 1. Persist the gate ledger outside the worktree ──────────────────────────
STORE_BASE="$HOME/.local/state/abstract-data-gate"
STORE_KEY="$(printf '%s' "$PROJECT_DIR" | shasum 2>/dev/null | cut -c1-12)"
STORE="$STORE_BASE/${STORE_KEY:-default}"
STATE="$PROJECT_DIR/.claude/state"
mkdir -p "$STORE" 2>/dev/null || true
if [ -d "$STATE" ] && [ ! -L "$STATE" ]; then
  # A real dir means GitButler removed our symlink and the gate wrote here this
  # turn — migrate those ledgers into the persistent store, then re-link.
  cp "$STATE"/*.json "$STORE"/ 2>/dev/null || true
  find "$STATE" -type f -delete 2>/dev/null || true
  rmdir "$STATE" 2>/dev/null || true
fi
[ -e "$STATE" ] || ln -s "$STORE" "$STATE" 2>/dev/null || true

# Read session_id from the Stop payload so our records land in the ledger
# gate.py stop-check reads (it keys the ledger by session_id).
PAYLOAD="$(cat 2>/dev/null || true)"
SESSION_ID="$(
  printf '%s' "$PAYLOAD" | python3 -c 'import sys, json
try:
    print(json.load(sys.stdin).get("session_id", ""))
except Exception:
    print("")' 2>/dev/null || true
)"

# #341: this used to end in `>/dev/null 2>&1 || true`, discarding both the output and the
# exit status. A recorder that failed for ANY reason (usage error, unresolvable session, a
# future required argument, permissions) therefore recorded nothing, `open_items` saw
# nothing, and Stop PASSED — fail-open on the one path whose entire job is recording
# failures. Now a failure is surfaced on stderr AND appended to a marker file that the Stop
# gate blocks on, cleared by `gate.py clear-record-errors`.
#
# The marker is written with plain `printf`, deliberately NOT through gate.py: the whole
# point is that gate.py just failed. It is named *.json so it survives the `*.json`-only
# state-dir repair above.
REC_ERRORS="$STATE/gate-record-errors.json"

rec() {  # rec <check-name> <failed|skipped> <detail>
  local out rc
  out="$(python3 "$GATE" record-failure --check "$1" --status "$2" --detail "$3" \
    ${SESSION_ID:+--session "$SESSION_ID"} 2>&1)"
  rc=$?
  [ $rc -eq 0 ] && return 0

  printf '[verify-completion] FAILED to record check "%s" (exit %s): %s\n' \
    "$1" "$rc" "$out" >&2

  # Append to the marker as a JSON array, tolerating an absent or corrupt existing file.
  python3 - "$REC_ERRORS" "$1" "$2" "$rc" "$out" <<'PY' 2>/dev/null || \
    printf '[{"check":"%s","detail":"recorder failed and the marker could not be written"}]\n' \
      "$1" > "$REC_ERRORS" 2>/dev/null || true
import json, pathlib, sys, time
path, check, status, rc, out = pathlib.Path(sys.argv[1]), *sys.argv[2:6]
try:
    data = json.loads(path.read_text())
    if not isinstance(data, list):
        data = []
except Exception:
    data = []
data.append({"check": check, "status": status, "exit": rc,
             "detail": out[:500], "at": int(time.time())})
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(data, indent=2))
PY
  return 0  # the hook's exit contract is unchanged; the BLOCK comes from the gate
}

cd "$PROJECT_DIR" 2>/dev/null || exit 0

# ── 2. Repo checks (changed-file scoped; full suite only for declared tasks) ──
# Two scope corrections (#45):
#  (a) EXCLUDE vendored abstract-data-deployed hook files (.claude/.cursor/.agents/.github
#      hooks/*.py) — they are tool-owned artifacts, not this project's source, and formatting
#      them marks them MODIFIED and diverges the bundle (#37).
#  (b) SUBTRACT files that were already dirty at SESSION START (recorded by
#      session-py-baseline.sh) — a session that changed no .py of its own must not be blamed for
#      pre-existing uncommitted drift. Falls back to current behavior when no baseline exists.
BASELINE_FILE="$STORE/py-baseline-$(printf '%s' "${SESSION_ID:-}" | tr -c 'A-Za-z0-9._-' '_').txt"
CHANGED_RAW="$(
  { git diff --name-only HEAD 2>/dev/null; \
    git ls-files --others --exclude-standard 2>/dev/null; } \
  | grep -E '\.py$' \
  | grep -vE '(^|/)\.(claude|cursor|agents|github)/(.*/)?hooks/' \
  | sort -u
)"
if [ -n "${SESSION_ID:-}" ] && [ -n "$CHANGED_RAW" ] && [ -f "$BASELINE_FILE" ]; then
  CHANGED_RAW="$(comm -23 <(printf '%s\n' "$CHANGED_RAW") <(sort -u "$BASELINE_FILE"))"
fi
EXIST=()
while IFS= read -r f; do
  [ -n "$f" ] && [ -f "$f" ] && EXIST+=("$f")
done <<< "$CHANGED_RAW"

TASK_MD="$PROJECT_DIR/TASK.md"

if [ "${#EXIST[@]}" -eq 0 ] && [ ! -f "$TASK_MD" ]; then
  exit 0
fi

if [ "${#EXIST[@]}" -gt 0 ]; then
  if ! uv run ruff check "${EXIST[@]}" >/dev/null 2>&1; then
    rec ruff failed "ruff check failed on changed files: ${EXIST[*]}"
  fi
  # CI parity (issue #25): the quality workflow runs `ruff format --check .` repo-wide, so a
  # format-only drift (correct lint, wrong formatting) passes this gate but fails CI. Mirror it
  # on the changed files — same changed-file scope as ruff check above.
  if ! uv run ruff format --check "${EXIST[@]}" >/dev/null 2>&1; then
    rec ruff-format failed "ruff format --check failed on changed files (run: ruff format ${EXIST[*]})"
  fi
  SRC=()
  for f in "${EXIST[@]}"; do
    case "$f" in src/*) SRC+=("$f");; esac
  done
  if [ "${#SRC[@]}" -gt 0 ]; then
    if ! uv run ty check "${SRC[@]}" >/dev/null 2>&1; then
      rec ty failed "ty check failed on changed src files: ${SRC[*]}"
    fi
  fi
fi

if [ -f "$TASK_MD" ] || [ "${VERIFY_COMPLETION_FULL:-0}" = "1" ]; then
  # Run the unit suite by PATH, not `-m unit` (issue #22): an UNMARKED test under
  # tests/unit/ is silently DESELECTED by `-m unit`, so a project whose tests lack
  # markers gets a false-green gate (e.g. "2 passed, 134 deselected") while CI runs
  # the full suite. Running the directory includes unmarked tests. Fall back to the
  # full run when there is no tests/unit/ directory.
  PYTEST_TARGET="tests/unit"
  [ -d "$PYTEST_TARGET" ] || PYTEST_TARGET=""
  # Parallelize with pytest-xdist ONLY when secrets are already warmed into the env
  # (e.g. running under `op run --environment <id> --`): xdist workers inherit
  # NOTION_TOKEN and take the auth fast-path, so none of them triggers a fresh
  # 1Password biometric prompt. A COLD parallel run would prompt once PER worker,
  # so default to serial (which resolves op once and caches) when the token is absent.
  XDIST=""
  [ -n "${NOTION_TOKEN:-}" ] && command -v uv >/dev/null 2>&1 && \
    uv run python -c "import xdist" >/dev/null 2>&1 && XDIST="-n auto"
  if ! uv run pytest -q $XDIST $PYTEST_TARGET >/dev/null 2>&1; then
    rec pytest failed "uv run pytest ${PYTEST_TARGET:-(full suite)} failed"
  fi
fi

# ── 3. Outcome-eval regression gate (ADR-0015) ───────────────────────────────
# When an eval kit with cases is deployed and `abstract-data` is runnable, gate
# turn-completion on the committed baseline — the same model as ruff/ty/pytest above.
# Scoped to declared tasks (TASK.md present or VERIFY_COMPLETION_FULL=1) so casual turns
# stay fast; off-switch VERIFY_COMPLETION_EVALS=0. Exit 1 = regression (record + block via
# the gate); exit 2 = no kit/adapter/pydantic-evals → skip silently (never a turn failure).
if { [ -f "$TASK_MD" ] || [ "${VERIFY_COMPLETION_FULL:-0}" = "1" ]; } \
   && [ "${VERIFY_COMPLETION_EVALS:-1}" = "1" ] \
   && command -v abstract-data >/dev/null 2>&1 \
   && compgen -G "$PROJECT_DIR/evals/golden/*.y*ml" >/dev/null 2>&1; then
  # issue #276 defect 3: `eval-outcomes` exits 1 for BOTH a real regression and a crash, so the
  # output has to be captured and inspected — otherwise every failure is filed as a baseline
  # regression and the actual cause (ImportError, missing dep, unreachable judge) is discarded.
  EVAL_OUT="$(mktemp -t ad-eval-outcomes)"
  abstract-data eval-outcomes . --json >"$EVAL_OUT" 2>&1
  EVAL_RC=$?
  case $EVAL_RC in
    1)
      if grep -qE 'Traceback \(most recent call last\)|ModuleNotFoundError|ImportError' "$EVAL_OUT"; then
        EVAL_MSG="$(grep -E '^[A-Za-z_.]*(Error|Exception):' "$EVAL_OUT" | tail -1 | cut -c1-200)"
        rec eval-outcomes failed \
          "eval harness CRASHED (not a baseline regression): ${EVAL_MSG:-see: abstract-data eval-outcomes .}"
      elif grep -qE 'declared but produced no assertion' "$EVAL_OUT"; then
        EVAL_MSG="$(grep -E 'declared but produced no assertion' "$EVAL_OUT" | head -1 | cut -c1-200)"
        rec eval-outcomes failed \
          "eval judge unreachable (check \`ollama serve\`, \`ollama list\`, EVAL_JUDGE_MODEL): ${EVAL_MSG}"
      else
        EVAL_MSG="$(grep -iE 'regression:' "$EVAL_OUT" | head -2 | tr '\n' ' ' | cut -c1-200)"
        rec eval-outcomes failed \
          "outcome-eval regression vs committed baseline: ${EVAL_MSG:-run: abstract-data eval-outcomes .}"
      fi
      ;;
  esac
  rm -f "$EVAL_OUT"
fi

# ── 4. TASK.md checked-box claim verification (abstract-data#333) ─────────────
# Until now TASK.md was only a SCOPING signal here (§2/§3 use it to decide whether to
# run the suite) — the boxes themselves were never read, so a `[x]` was trusted purely
# for being checked. The completeness judgment lived entirely in the task-critic
# subagent, which is an LLM and therefore not a mechanical guarantee.
#
# This is the mechanical half, and it is deliberately WEAK on purpose. A heuristic
# that hard-blocks on prose it cannot parse becomes the next unsatisfiable gate — this
# repo has shipped that bug more than once — so the rule is:
#   • unparseable item, vague claim, external claim, hedged wording → WARN + record only
#   • claim that is concrete AND checkable AND provably false → record a failure, which
#     the Stop gate then requires a human-readable disposition for
# The escalation set is narrow by construction (repo-relative path with a known file
# extension; a file:line citation past EOF; a `pkg==X.Y` pin contradicted by a
# manifest). Everything else is written to the note file for the reader/task-critic,
# never blocked on. Off-switch: VERIFY_COMPLETION_TASK_CLAIMS=0.
if [ -f "$TASK_MD" ] && [ "${VERIFY_COMPLETION_TASK_CLAIMS:-1}" = "1" ]; then
  CLAIMS_NOTE="$STATE/task-md-claims.json"
  CLAIMS_MSG="$(python3 - "$TASK_MD" "$PROJECT_DIR" "$CLAIMS_NOTE" <<'TASKCLAIMS'
"""Verify the concrete claims made by checked TASK.md boxes against the working tree.

Prints ONE line to stdout only when a claim is provably false (that line becomes the
recorded failure detail). Warnings go to stderr; the full classification goes to the
note file. Any internal error is swallowed — a broken verifier must never be able to
stop a turn.
"""

import json
import os
import re
import subprocess
import sys
import time

# Extensions we are willing to be WRONG about: a token carrying one of these is a real
# file reference, so "it is not in the tree" is a provable failure rather than a guess.
EXT = re.compile(
    r"\.(?:py|pyi|sh|bash|zsh|md|rst|toml|json|jsonc|ya?ml|lock|txt|cfg|ini|env|"
    r"ts|tsx|js|jsx|mjs|cjs|vue|svelte|sql|tf|tfvars|hcl|rs|go|rb|java|kt|"
    r"css|scss|html|svg|xml|csv|ipynb)$"
)
LINEREF = re.compile(r":(\d+)(?:-\d+)?$")
CHECKED = re.compile(r"^(\s*)(?:[-*+]\s*)?\[[xX]\]\s*(.*)$")
ANYBOX = re.compile(r"^\s*(?:[-*+]\s*)?\[[ xX]\]")
SPAN = re.compile(r"`([^`\n]+)`")
PIN = re.compile(r"\b([A-Za-z][A-Za-z0-9._-]{1,40})\s*(?:==|>=)\s*v?(\d+(?:\.\d+){0,3})\b")
# Wording that makes a missing path the EXPECTED state (a deletion, a rename, a
# rejected alternative) or that marks the item as intent rather than assertion. Any
# hit demotes every claim in the item to advisory — recall traded for precision, on
# purpose: a false block here costs more than a missed check.
HEDGE = re.compile(
    r"\b(?:remove[ds]?|removing|delete[ds]?|deleting|drop(?:s|ped|ping)?|"
    r"renam(?:e|ed|es|ing)|mov(?:e|ed|es|ing)|replac(?:e|ed|es|ing)|"
    r"deprecat\w*|revert(?:ed)?|no longer|instead of|rather than|not\b|n/a|"
    r"would|should|todo|tbd|defer(?:red)?|skip(?:ped)?)\b",
    re.I,
)
# Manifests a version pin can be checked against, cheapest/most authoritative first.
MANIFESTS = ("pyproject.toml", "uv.lock", "requirements.txt", "requirements-dev.txt", "package.json")
TRIM = " \t\"'`.,;:!?()[]{}<>"
# Leading "." must NOT be stripped: dotfile paths are the common case in this repo
# (.github/workflows/x.yml, .claude/hooks/y.sh) and stripping it turned a TRUE claim
# into a lookup for "github/workflows/x.yml", which does not exist — so the verifier
# reported truthful items as contradicted. Right-strip always; left-strip only the
# characters that are never path-leading.
LTRIM = " \t\"'`(,;:!?[]{}<>"


def path_like(tok):
    """A repo-relative file reference we can resolve, or None."""
    tok = tok.rstrip(TRIM).lstrip(LTRIM)
    if not tok or "://" in tok or "=" in tok or tok.startswith(("-", "~", "/", "$")):
        return None  # flags, URLs, absolute/home paths (outside the working tree), vars
    if any(c in tok for c in " \t*?|\"'()[]{}<>"):
        return None  # globs and placeholders are not resolvable paths
    if "/" not in tok:
        return None  # bare basenames ("requirements.txt") are too ambiguous to block on
    return tok


def scan(text):
    """Every path-shaped token in an item, backticked or bare."""
    out = []
    for tok in re.split(r"\s+", SPAN.sub(lambda m: " " + m.group(1) + " ", text)):
        p = path_like(tok)
        if p:
            out.append(p)
    return out


def tree_index(project_dir):
    """Every file git knows about, tracked or newly written but not yet added.

    Needed because TASK.md items routinely write a path relative to the thing they
    are about, not to the repo root — `assets/foo.sh` inside a skill's section is a
    true claim about `.../community-skills/<skill>/assets/foo.sh`. Resolving only
    from the root turned those into fabricated "missing file" blocks, which is the
    unsatisfiable-gate failure this check must not reintroduce. None = git could not
    answer, and callers then refuse to escalate at all.
    """
    paths = set()
    for args in (["ls-files", "-z"], ["ls-files", "--others", "--exclude-standard", "-z"]):
        try:
            out = subprocess.run(
                ["git", "-C", project_dir] + args,
                capture_output=True,
                timeout=20,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        if out.returncode != 0:
            return None
        paths.update(p for p in out.stdout.decode("utf-8", "replace").split("\0") if p)
    return paths


def resolve(project_dir, index, rel):
    """The real file for a claimed path, matched from the root or by path suffix."""
    if os.path.exists(os.path.join(project_dir, rel)):
        return rel
    if index is None:
        return None
    tail = "/" + rel.lstrip("./")
    for known in index:
        if known.endswith(tail):
            return known
    return None


def main():
    task_md, project_dir, note_path = sys.argv[1], sys.argv[2], sys.argv[3]
    lines = open(task_md, encoding="utf-8", errors="replace").read().splitlines()
    index = tree_index(project_dir)

    manifest_text = ""
    for name in MANIFESTS:
        try:
            manifest_text += open(os.path.join(project_dir, name), encoding="utf-8", errors="replace").read()
        except OSError:
            pass

    false_claims, unverifiable, confirmed, checked = [], [], [], 0

    for idx, line in enumerate(lines):
        m = CHECKED.match(line)
        if not m:
            continue
        checked += 1
        lineno, indent, body = idx + 1, len(m.group(1)), m.group(2)
        # Evidence usually lives in the item's indented continuation lines, so fold
        # them in rather than judging the headline alone.
        j = idx + 1
        while j < len(lines):
            nxt = lines[j]
            if not nxt.strip() or ANYBOX.match(nxt) or (len(nxt) - len(nxt.lstrip())) <= indent:
                break
            body += " " + nxt.strip()
            j += 1

        hedged = bool(HEDGE.search(body))
        claims = 0

        for tok in scan(body):
            ref = LINEREF.search(tok)
            path = tok[: ref.start()] if ref else tok
            if not EXT.search(path):
                # Path-shaped but unrecognized (a package path, "and/or", a Notion URL
                # fragment) — note it, never block on it.
                unverifiable.append({"line": lineno, "claim": tok, "why": "no recognizable file extension"})
                continue
            claims += 1
            found = resolve(project_dir, index, path)
            if found is None:
                entry = {"line": lineno, "claim": path, "why": "path does not exist in the working tree"}
                # index is None ⇒ git could not enumerate the tree, so "missing" is
                # our blind spot rather than the item's lie: advisory only.
                (unverifiable if (hedged or index is None) else false_claims).append(entry)
                continue
            full = os.path.join(project_dir, found)
            if ref and os.path.isfile(full):
                try:
                    with open(full, "rb") as fh:
                        total = sum(1 for _ in fh)
                except OSError:
                    total = None
                if total is not None and int(ref.group(1)) > total:
                    entry = {
                        "line": lineno,
                        "claim": tok,
                        "why": "cites line %s but the file has %d line(s)" % (ref.group(1), total),
                    }
                    (unverifiable if hedged else false_claims).append(entry)
                    continue
            confirmed.append({"line": lineno, "claim": tok})

        for name, version in PIN.findall(body):
            # Only checkable when the package is actually declared here; an
            # undeclared name is somebody else's manifest, so it stays advisory.
            if not re.search(r"(?i)\b%s\b" % re.escape(name), manifest_text):
                unverifiable.append({"line": lineno, "claim": "%s==%s" % (name, version), "why": "package not declared in any local manifest"})
                continue
            claims += 1
            if version in manifest_text:
                confirmed.append({"line": lineno, "claim": "%s==%s" % (name, version)})
            else:
                entry = {"line": lineno, "claim": "%s==%s" % (name, version), "why": "version pinned in TASK.md is in no local manifest"}
                (unverifiable if hedged else false_claims).append(entry)

        if claims == 0:
            unverifiable.append({"line": lineno, "claim": body[:120], "why": "no machine-checkable claim in this item"})

    note = {
        "generated_at": int(time.time()),
        "task_md": task_md,
        "checked_items": checked,
        "confirmed": confirmed,
        "unverifiable": unverifiable,
        "false_claims": false_claims,
    }
    try:
        os.makedirs(os.path.dirname(note_path), exist_ok=True)
        with open(note_path, "w", encoding="utf-8") as fh:
            json.dump(note, fh, indent=2)
    except OSError:
        pass

    if unverifiable:
        sys.stderr.write(
            "[verify-completion] TASK.md: %d checked item claim(s) could not be verified "
            "mechanically (advisory, not blocking) — see %s\n" % (len(unverifiable), note_path)
        )
    if false_claims:
        detail = "; ".join(
            "TASK.md:%s '%s' %s" % (c["line"], c["claim"], c["why"]) for c in false_claims[:5]
        )
        if len(false_claims) > 5:
            detail += " (+%d more in %s)" % (len(false_claims) - 5, note_path)
        sys.stdout.write(detail[:600] + "\n")


try:
    main()
except Exception as exc:  # never let a heuristic stop a turn
    sys.stderr.write("[verify-completion] TASK.md claim check skipped: %s\n" % exc)
TASKCLAIMS
)" || true
  # ADVISORY ONLY — deliberately does NOT call `rec`. Replaying this verifier over 60
  # historical TASK.md revisions escalated 4 of them on claims that were actually true
  # (documented commands, paths inside fenced code blocks, dotfile paths). A heuristic with
  # that false-positive rate, wired to a check that blocks Stop, is the unsatisfiable-gate
  # pattern this repo keeps shipping — and it would block on prose it simply cannot parse.
  # Surface it to the human, record it for later analysis, and let the turn end.
  if [ -n "${CLAIMS_MSG:-}" ]; then
    printf '[verify-completion] TASK.md claim check (ADVISORY, not blocking): %s\n' \
      "$CLAIMS_MSG" >&2
  fi
fi

exit 0
