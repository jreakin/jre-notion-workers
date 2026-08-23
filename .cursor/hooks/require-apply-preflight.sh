#!/usr/bin/env bash
# require-apply-preflight.sh — PreToolUse hook (Bash)
# Blocks `abstract-data apply` / `retrofit` / `hooks upgrade` / `hooks provision` until the
# apply-preflight-auditor has completed a REAL review and written a fresh
# .abstract-data/preflight-confirmed.json marker (1h TTL). This stops agents
# from running apply/retrofit before reviewing the playbook, the existing
# .claude/ state (hooks/agents/skills/commands/settings), the docs, and the
# lockfile / clobber risk.
#
# Exit codes: 0 = allow, 2 = block (Claude Code BLOCK severity)
# Reads: .abstract-data/preflight-confirmed.json ; the PreToolUse JSON on stdin.
# Env:   ABSTRACT_DATA_SKIP_APPLY_PREFLIGHT=1 to bypass (CI/automation)
#        ABSTRACT_DATA_APPLY_PREFLIGHT_TTL_HOURS to override TTL (default: 1)
#
# By design this hook matches ONLY the guarded write verbs — every other Bash
# command (including the auditor's own reads/greps and the marker writer) passes
# through untouched, so there is no circular self-block (#6 lesson). The match is
# scoped to the INVOCATION SEGMENT it appears in, so a --dry-run belonging to some
# other command in a compound line no longer previews a real write.
#
# It is ALSO scoped to a real INVOCATION, not to prose (abstract-data#332 defect class).
# A substring match on the raw command string fired on any command that merely CONTAINED
# the words — e.g. `gh issue create --body "the abstract-data hook … we should apply …"`,
# or a `--note 'apply this later'` argument. The words in a QUOTED argument are one shell
# token, never a command; so the decision is now made on TOKENS: the `abstract-data`
# binary must stand in COMMAND POSITION (optionally behind a launcher — `uv run`, `env`,
# `sudo`, `op run --environment <id> --`, a `VAR=…` assignment — or inside a `bash -c "…"`
# / `su -c "…"` / `eval "…"` command string), and the guarded verb must be its first real
# ARGUMENT. Prose cannot satisfy both conditions. Heredoc BODIES are skipped for the same
# reason: `cat > note.md <<EOF … EOF` writes data, it does not run a command.
#
# Scoping is fail-CLOSED where the two goals conflict: an unrecognised word after a
# launcher (a docker image, a `direnv exec .` path) still counts as a real invocation,
# because a missed apply is a clobbered project while a spurious prompt costs one review.

set -euo pipefail

# ── Command guard: only act on `abstract-data apply` / `retrofit` / `hooks upgrade`
#    / `hooks provision`, and only within the matched INVOCATION SEGMENT ──────────
INPUT="$(cat 2>/dev/null || true)"
CMD=""
if command -v python3 &>/dev/null; then
  # FR-4.1: Claude nests the command under .tool_input; Cursor's beforeShellExecution
  # sends it TOP-LEVEL. Same host-tolerant chain the sibling handlers use
  # (`.tool_input.command // .command // empty`) — without it a Cursor-shaped payload
  # left CMD empty, matched no segment, and let an unpreflighted write through.
  CMD=$(printf '%s' "$INPUT" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    if not isinstance(d, dict):
        d = {}
    ti = d.get('tool_input')
    if not isinstance(ti, dict):
        ti = {}
    print(ti.get('command') or d.get('command') or '')
except Exception:
    print('')
" 2>/dev/null || true)
fi

# ── Stage 1: cheap PREFILTER ─────────────────────────────────────────────────
# Matches 'abstract-data apply' / 'retrofit' / 'hooks upgrade' / 'hooks provision' (also
# the underscore console-script spelling) anywhere in the command, tolerant of flags/paths
# between binary and verb. This is deliberately LOOSE and is NOT the decision: it only
# answers "is it even worth tokenising this command?" so that the overwhelming majority of
# Bash calls exit here without paying for a parse. Newlines are folded to spaces first
# because grep is line-oriented and a real invocation may be split over a backslash
# continuation. Stage 2 below is the authority on whether a real invocation is present.
if ! printf '%s' "$CMD" | tr '\n' ' ' | grep -qE '(^|[^A-Za-z0-9_-])abstract[-_]data([[:space:]]+[^[:space:]]+)*[[:space:]]+(apply|retrofit|hooks[[:space:]]+(upgrade|provision))([[:space:]]|$)'; then
  exit 0  # nothing that even resembles a guarded invocation
fi

# ── Stage 2: token-level INVOCATION analysis (the authority) ─────────────────
# Splits the command into invocation SEGMENTS at any UNQUOTED shell operator (&&, ||, ;,
# |, newline) or UNQUOTED `#` comment, then shlex-tokenises each segment and reports:
#   REAL — at least one guarded invocation that is NOT a --dry-run preview
#   DRY  — guarded invocation(s), every one of them a --dry-run preview
#   ""   — no guarded invocation (prose, an unrelated command, a quoted mention)
# Quote-aware on both passes, which is what kills the #332 defect class: the words inside
# `--body "… abstract-data … apply …"` or `--note 'apply this later'` collapse into ONE
# token whose basename is not the binary, so they can never reach command position.
# `--dry-run` is scoped to the ARGV of the invocation it belongs to (the in-CLI
# preflight_guard allows dry runs: apply=not dry_run), so `echo --dry-run && abstract-data
# apply` is still a real write. Written with double-quoted Python literals only, so the
# whole program can sit inside single quotes and reach python3 byte-for-byte.
VERDICT="$(printf '%s' "$CMD" | python3 -c '
import os, re, shlex, sys

SQ = chr(39)
DQ = chr(34)
BINARIES = {"abstract-data", "abstract_data"}
ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
# Tokens that may legally stand BEFORE the binary without making it an argument:
# launchers/wrappers, their subcommand words, and shell grouping keywords.
WRAPPERS = {
    "env", "sudo", "doas", "command", "exec", "nohup", "time", "nice", "stdbuf",
    "timeout", "caffeinate", "xargs", "uv", "uvx", "poetry", "pipx", "pdm", "hatch",
    "rye", "python", "python3", "py", "npx", "pnpm", "yarn", "npm",
    # Environment/secret launchers and container/tty wrappers. `op run --environment <id> --`
    # is THIS project documented invocation prefix, so leaving it out let a real
    # `op run ... -- abstract-data apply .` walk straight past the gate.
    "op", "mise", "asdf", "direnv", "dotenv", "devbox", "nix-shell", "conda", "micromamba",
    "docker", "podman", "script", "watch", "setsid", "flock", "arch", "chpst", "runuser",
    "just", "task", "hyperfine", "strace", "dtruss",
}
WRAPPER_WORDS = {"run", "tool", "exec", "--", "{", "(", "!", "then", "else", "do", "elif"}
# Anything that takes a COMMAND STRING as an argument and runs it in a fresh parse.
SHELLS = {"bash", "sh", "zsh", "dash", "ksh", "su"}
EVALS = {"eval"}
VERBS = {"apply", "retrofit"}
HOOK_SUBVERBS = {"upgrade", "provision"}
MAX_DEPTH = 3


def heredoc_delim(text, i):
    """Parse a `<<`/`<<-` redirection at ``i``; return (delimiter, index after it)."""
    n = len(text)
    j = i + 2
    if j < n and text[j] == "-":
        j += 1
    while j < n and text[j] in " \t":
        j += 1
    quote = None
    if j < n and text[j] in (SQ, DQ):
        quote = text[j]; j += 1
    start = j
    while j < n and (text[j].isalnum() or text[j] in "_-."):
        j += 1
    delim = text[start:j]
    if quote and j < n and text[j] == quote:
        j += 1
    return delim, j


def segments(text):
    segs, cur, q, i, n = [], [], None, 0, len(text)
    pending = []  # heredoc delimiters whose BODY starts at the next newline
    while i < n:
        c = text[i]
        if q:
            cur.append(c)
            if c == "\\" and q == DQ and i + 1 < n:
                cur.append(text[i + 1]); i += 2; continue
            if c == q:
                q = None
            i += 1; continue
        if c == SQ or c == DQ:
            q = c; cur.append(c); i += 1; continue
        if c == "\\" and i + 1 < n:
            cur.append(c); cur.append(text[i + 1]); i += 2; continue
        if c == "<" and text[i:i + 2] == "<<":
            # A heredoc BODY is data, not commands. Without this, the very case that
            # motivated #332 — writing a fixture/doc whose text begins with
            # `abstract-data apply …` — was split out as its own segment and read as a
            # command in command position, hard-blocking an innocent `cat > note.md`.
            delim, j = heredoc_delim(text, i)
            cur.append(text[i:j]); i = j
            if delim:
                pending.append(delim)
            continue
        if c == "#" and (not cur or cur[-1].isspace()):
            segs.append("".join(cur)); cur = []
            while i < n and text[i] != "\n":
                i += 1
            continue
        if c == "\n" and pending:
            segs.append("".join(cur)); cur = []; i += 1
            for delim in pending:
                while i < n:
                    eol = text.find("\n", i)
                    line = text[i:eol] if eol != -1 else text[i:]
                    i = eol + 1 if eol != -1 else n
                    if line.strip() == delim:
                        break
            pending = []
            continue
        if c in ";&|\n":
            segs.append("".join(cur)); cur = []; i += 1; continue
        cur.append(c); i += 1
    segs.append("".join(cur))
    return [s.strip() for s in segs if s.strip()]


def norm(tok):
    """Strip shell grouping punctuation so `(abstract-data apply)` still reads."""
    return tok.strip("()")


def preamble_ok(toks, idx):
    """True when nothing before ``idx`` turns the binary into someone ELSE argument.

    The preamble must BEGIN with a launcher — an assignment, a flag, a known wrapper,
    or a shell keyword. Once a launcher has been seen, ITS OWN arguments may be
    arbitrary words (an image name, a path, a `--` separator), because a launcher
    exists precisely to hand a command line to something else:
        op run --environment <id> -- abstract-data apply .
        direnv exec . abstract-data apply .
        docker run img abstract-data apply .
    An allowlist that had to name every intermediate word let all three escape.
    Prose still dies on its FIRST word — `gh issue create --title Fix abstract-data
    apply overmatch` is rejected at `gh`, never having launched anything — which is
    what keeps the #332 false-positive class closed.
    """
    launched = False
    for tok in toks[:idx]:
        t = norm(tok)
        if not t or ASSIGN.match(t):
            continue  # `VAR=value` prefixes neither launch nor disqualify
        base = os.path.basename(t)
        if (
            t.startswith("-")
            or base in WRAPPERS
            or base in WRAPPER_WORDS
            or base in SHELLS
            or base in EVALS
        ):
            launched = True
            continue
        if not launched:
            return False
    return True


def guarded_verb(args):
    """True when the invocation first real ARGUMENT is a guarded verb.

    A separated flag VALUE is skipped, so a global option that takes a value cannot
    hide the verb behind it (`abstract-data --config /tmp/c.toml apply .`). A value
    that IS a guarded verb is never skipped — fail closed, since the cost is at worst
    a spurious preflight prompt while the reverse is an unpreflighted write.
    """
    rest = [norm(a) for a in args]
    i, n = 0, len(rest)
    while i < n:
        a = rest[i]
        if not a:
            i += 1
            continue
        if a.startswith("-"):
            i += 1
            nxt = rest[i] if i < n else ""
            if nxt and not nxt.startswith("-") and nxt not in VERBS and nxt != "hooks":
                i += 1  # the flag separated value
            continue
        if a in VERBS:
            return True
        return a == "hooks" and i + 1 < n and rest[i + 1] in HOOK_SUBVERBS
    return False


def is_dry_run(args):
    return any(a == "--dry-run" or a.startswith("--dry-run=") for a in args)


def _hooks_upgrade_tail(args):
    """Return argv after ``hooks upgrade``, skipping leading global flags.

    ``guarded_verb`` already skips leading options before deciding whether a guarded
    verb is present; this helper applies the same rule so a reconcile exemption is not
    defeated by innocuous globals like ``--verbose``.
    """
    rest = [norm(a) for a in args]
    i, n = 0, len(rest)
    while i < n:
        a = rest[i]
        if not a:
            i += 1
            continue
        if a.startswith("-"):
            i += 1
            nxt = rest[i] if i < n else ""
            if nxt and not nxt.startswith("-") and nxt not in VERBS and nxt != "hooks":
                i += 1  # the flag separated value
            continue
        break
    if i + 1 < n and rest[i] == "hooks" and rest[i + 1] == "upgrade":
        return rest[i + 2 :]
    return None


def is_no_write_reconcile(args):
    """True for `hooks upgrade --reconcile`, which deploys nothing (#336).

    The guard keyed on the VERB, so it refused the one command that repairs a
    manifest/state.db disagreement — even though that path calls reconcile_check then
    rewrites the state.db mirror FROM THE ALREADY-COMMITTED MANIFEST and returns. No hook
    is written, no file under .claude/hooks/ is touched, the trust anchor is untouched.

    That made the documented remediation for a tamper signal reachable only via --force, an
    env bypass, or an attestation misdescribing an operation that writes nothing — every
    route teaching the user to reach for a bypass, which is the opposite of the point.

    Deliberately narrow: `--reconcile` ONLY, and only under `hooks upgrade`. Any other flag
    alongside it (e.g. a real deploying upgrade that also reconciles) is NOT exempt, because
    the exemption is about the effect, and mixed invocations write.
    """
    tail = _hooks_upgrade_tail(args)
    if tail is None:
        return False
    rest = [a for a in tail if a != "--reconcile"]
    return len(rest) < len(tail) and not rest


def scan(toks, depth):
    matched = unpreviewed = False
    for i, tok in enumerate(toks):
        base = os.path.basename(norm(tok))
        if base in SHELLS and depth < MAX_DEPTH and preamble_ok(toks, i):
            # `bash -c "<command string>"` / `su -c "<string>" user` — analyse the
            # nested string as a command so a shell cannot smuggle an apply past.
            for j in range(i + 1, len(toks) - 1):
                if toks[j] == "-c":
                    m, u = analyse(toks[j + 1], depth + 1)
                    matched = matched or m
                    unpreviewed = unpreviewed or u
                    break
            continue
        if base in EVALS and depth < MAX_DEPTH and preamble_ok(toks, i):
            # `eval "<command string>"` is the same escape without the -c: bash joins
            # eval remaining words and re-parses them, so analyse the join.
            m, u = analyse(" ".join(toks[i + 1:]), depth + 1)
            matched = matched or m
            unpreviewed = unpreviewed or u
            continue
        if base not in BINARIES or not preamble_ok(toks, i):
            continue
        args = toks[i + 1:]
        if not guarded_verb(args):
            continue
        matched = True
        if not is_dry_run(args) and not is_no_write_reconcile(args):
            unpreviewed = True
    return matched, unpreviewed


def analyse(text, depth=0):
    matched = unpreviewed = False
    for seg in segments(text):
        try:
            groups = [shlex.split(seg, comments=False, posix=True)]
        except ValueError:
            # Unbalanced quotes (a stray apostrophe in `echo it is fine && …` swallows the
            # rest of the line into ONE segment). Degrade instead of crashing, and re-split
            # naively on the operators so a real invocation cannot hide behind that quote.
            # Naive splitting leaves quote characters attached to the tokens, so a quoted
            # mention still cannot look like the binary in command position.
            groups = [part.split() for part in re.split(r"[;&|\n]+", seg)]
        for toks in groups:
            if not toks:
                continue
            m, u = scan(toks, depth)
            matched = matched or m
            unpreviewed = unpreviewed or u
    return matched, unpreviewed


m, u = analyse(sys.stdin.read())
sys.stdout.write("REAL" if u else ("DRY" if m else ""))
' 2>/dev/null)" || VERDICT="ERROR"

# ERROR = the analyser itself failed AFTER the prefilter already matched. Fail CLOSED:
# the command looks like a guarded invocation and nothing proved otherwise.
case "$VERDICT" in
  REAL | ERROR) ;;    # a real write — continue to the marker check
  *) exit 0 ;;        # no guarded invocation, or every one of them is a --dry-run preview
esac

# ── Bypass in non-interactive / CI contexts ──────────────────────────────────
if [[ "${ABSTRACT_DATA_SKIP_APPLY_PREFLIGHT:-0}" == "1" ]]; then
  exit 0
fi
if [[ -n "${CI:-}" ]] || [[ -n "${GITHUB_ACTIONS:-}" ]] || \
   [[ -n "${BUILDKITE:-}" ]] || [[ -n "${CIRCLECI:-}" ]]; then
  exit 0
fi

# ── Locate the MAIN working-tree root (shared across linked worktrees, #6) ────
# git-common-dir stays FIRST: it is the only step that resolves a linked worktree back
# to the main tree, and every host variable below would point at the worktree instead.
# The FR-4.1 host chain is PREPENDED to the bare `pwd` fallback, not substituted for the
# git step: CLAUDE_PROJECT_DIR -> CURSOR_PROJECT_DIR -> payload .workspace_roots[0] ->
# payload .cwd -> pwd. Without it, a Cursor session outside a git repo resolved the
# marker against the process cwd and blocked a legitimately preflighted run.
PROJECT_ROOT=""
_gcd="$(git rev-parse --git-common-dir 2>/dev/null || true)"
if [[ -n "$_gcd" ]]; then
  _gcd_abs="$(cd "$_gcd" 2>/dev/null && pwd || true)"
  [[ -n "$_gcd_abs" ]] && PROJECT_ROOT="$(dirname "$_gcd_abs")"
fi
if [[ -z "$PROJECT_ROOT" ]]; then
  PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-}"
fi
if [[ -z "$PROJECT_ROOT" ]]; then
  PROJECT_ROOT="${CURSOR_PROJECT_DIR:-}"
fi
if [[ -z "$PROJECT_ROOT" ]] && command -v python3 &>/dev/null; then
  PROJECT_ROOT=$(printf '%s' "$INPUT" | python3 -c '
import json, sys
try:
    p = json.load(sys.stdin)
except Exception:
    p = {}
if not isinstance(p, dict):
    p = {}
roots = p.get("workspace_roots") or []
print(roots[0] if roots else (p.get("cwd") or ""))
' 2>/dev/null || true)
fi
if [[ -z "$PROJECT_ROOT" ]]; then
  PROJECT_ROOT="$(pwd)"
fi

MARKER="$PROJECT_ROOT/.abstract-data/preflight-confirmed.json"
TTL_HOURS="${ABSTRACT_DATA_APPLY_PREFLIGHT_TTL_HOURS:-1}"
TTL_SECONDS=$(( TTL_HOURS * 3600 ))

# ── Check marker freshness ───────────────────────────────────────────────────
if [[ -f "$MARKER" ]] && command -v python3 &>/dev/null; then
  # The path is passed as ARGV, never interpolated into the program text: a project path
  # containing an apostrophe (e.g. /tmp/wei'rd) used to close the Python string literal
  # and raise SyntaxError, and under `set -e` the failed assignment aborted the hook with
  # exit 1 — which Claude does not treat as blocking, so the write proceeded. The `||`
  # fallback and the numeric guard keep the assignment from ever aborting or from feeding
  # an empty value into the arithmetic (where it would evaluate to 0 = "fresh").
  MARKER_AGE=$(python3 -c '
import json, sys, time
try:
    with open(sys.argv[1], encoding="utf-8") as fh:
        print(int(time.time() - json.load(fh).get("confirmed_at_unix", 0)))
except Exception:
    print(99999)
' "$MARKER" 2>/dev/null) || MARKER_AGE=99999
  [[ "$MARKER_AGE" =~ ^[0-9]+$ ]] || MARKER_AGE=99999
  if (( MARKER_AGE < TTL_SECONDS )); then
    exit 0  # fresh preflight — allow
  fi
fi

# ── Block ────────────────────────────────────────────────────────────────────
# Note: the CLI preflight_guard (FR-7) requires a content-bound attestation; this
# hook still accepts a fresh legacy marker for Bash PreToolUse parity. After the
# auditor review, mint CLI authority with:
#   abstract-data attest command --kind apply-preflight --project <root> \
#     --run "abstract-data apply --dry-run <root>"
cat >&2 <<'MSG'
╔══════════════════════════════════════════════════════════════════════╗
║  APPLY / RETROFIT PREFLIGHT REVIEW REQUIRED                          ║
║                                                                      ║
║  Do not run writing apply/retrofit until you have reviewed what it   ║
║  will do. Invoke the apply-preflight-auditor subagent first.         ║
║                                                                      ║
║  Then mint a content-bound attestation (FR-7), e.g.:                 ║
║    abstract-data attest command --kind apply-preflight \             ║
║      --project <root> --run "abstract-data apply --dry-run <root>"   ║
║  Or: bash write-preflight-confirmed.sh (also mints human_confirmed). ║
║                                                                      ║
║  Bypass in automation: ABSTRACT_DATA_SKIP_APPLY_PREFLIGHT=1          ║
╚══════════════════════════════════════════════════════════════════════╝
MSG
exit 2
