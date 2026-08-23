#!/usr/bin/env python3
"""
gate.py — Abstract Data Dev-Env enforcement gate (v1.4.0)

One file, three responsibilities, no third-party dependencies (stdlib only):

  1. Stop / SubagentStop loop-closer   -> `gate.py stop-check`
     Refuses to let a turn end while there are unresolved verification failures
     or an outstanding task-critic verdict. This is the fix for the "open loop
     after a failed check" pattern. A **SubagentStop** takes a different branch
     (v1.4.0): no task-critic receipt is required of a worker, and its open items
     are routed to `.claude/cross-agent-issues.json` instead of blocking it.

  2. Dangerous-ops PreToolUse gate     -> `gate.py pretool`
     DENY for operations that are never appropriate autonomously (global git
     config, hook self-modification) and ASK (escalate to the human) for the
     "meaning-changing" operations the review flagged: CI workflow edits,
     production-loader edits, dependency/lockfile changes, migrations, force
     pushes, direct SQL backfill, cloud-risk alembic runs. Also scans the CONTENT
     of an Edit/Write (v1.3.0): a self-identifying credential is denied, an
     ambiguous `secret = "..."` assignment asks, and neither fires on placeholder
     vocabulary or in test/docs paths.

  3. Disposition ledger CLI            -> `gate.py record-failure | dispose
                                            | task-critic-receipt | status
                                            | cross-agent-clear`
     The escape hatch the Stop gate checks against. A failed check is cleared
     only by a written disposition that names the check. `status --all` widens
     the view to EVERY `.claude/state/gate-*.json` ledger (session id, mtime,
     open-item count, which one is current) plus `.claude/cross-agent-issues.json`,
     so a multi-agent run's blockers are visible without grepping mtimes, and
     `cross-agent-clear --all` is the one command that empties that mirror.

Harness support: works under BOTH Claude Code and Cursor. The two send
different hook payload fields (Claude `session_id` + `tool_name`/`tool_input`;
Cursor `conversation_id` + `beforeShellExecution`/`afterFileEdit` fields) and
expect different output (Claude `hookSpecificOutput.permissionDecision` and
`{"decision":"block"}`; Cursor `{"permission":...}` and `{"followup_message":...}`).
The gate detects the harness from the payload and adapts.

Session keying (v1.1.0 fix): the Stop gate sees the session id in its payload,
but the CLI record path does not (no env var in a tool call), so verdicts used
to land in a `no-session` ledger the Stop gate never read. Now the pretool gate
— which fires on every tool call and *does* have the payload — persists the live
session id to `.claude/state/current-session`, and every path resolves through
`resolve_session()`, so the CLI and Stop gate always agree on the ledger.

Wiring lives in settings.hooks.json (Claude) and ~/.cursor/hooks.json (Cursor).
Agent-facing rules live in AGENTS.enforcement.md.

Philosophy: deterministic, evidence-based, fail-OPEN on internal bugs (a gate
bug must never brick every session) but fail-CLOSED on the conditions it is
designed to catch. The Stop gate has a loop guard so a genuinely stuck session
is released with a loud warning rather than hung forever.

Provenance of THIS file's version number
  v1.1.0  file ledger, session keying, harness detection, `status --all`
  v1.2.0  #337 FR-7 — receipt-bound task-critic. The bare
          `task-critic --verdict PASS` self-certification path is removed:
          the verdict is now hash-bound to a requirements file, and a ledger
          record carrying a null/missing `requirements_hash` can never satisfy
          the Stop gate (it is the shape the removed command wrote, and the
          staleness comparison skipped it because `None` is falsy).
  v1.3.0  #337 FR-7 — convergence on the receipt scheme. Two capabilities are
          adopted FROM the machine-global gate, each as a named row in
          `docs/spec/gate-reconciliation/fr7-convergence-table.md` (constitution
          constraint 2 forbids a wholesale port in either direction): the
          shift-left content secret scan on Edit/Write, and `cross-agent-clear`
          — without which `status --all` can SHOW a cross-agent escalation that
          nothing in this binary can clear.
  v1.4.0  #337 FR-8 — the SubagentStop branch. `evaluate_stop` set `require_tc`
          unconditionally, so registering THIS binary on SubagentStop would have
          blocked every subagent on a receipt it cannot legitimately produce —
          including task-critic itself, the one subagent that can clear the item —
          and burnt the shared `stop_blocks` counter doing it. A subagent stop now
          requires no receipt, never touches that counter, and escalates its items
          to the mirror. Per the owner's 2026-08-18 call the receipt is **friction,
          not a control** (it witnesses that *a* subagent ran, not that task-critic
          did); constitution constraint 1 was re-worded to stop claiming otherwise.

  #343: this number is NOT a conformance signal, and it is a SEPARATE lineage
  from the machine-global `~/.claude/hooks/gate.py` — the two files share
  neither a release history nor a feature set, so "1.2.0" here does not mean
  "1.2.0" there. Two shipped checks used to pin different literals (1.1.0 and
  1.3.1) and no single number could satisfy both. Conformance checks now probe
  the PROPERTY — that bare self-certification is refused — which survives
  every future bump. Do not reintroduce a version-equality pin.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path

VERSION = "1.4.0"
MAX_STOP_BLOCKS = 3  # loop guard: release after this many consecutive blocked EVENTS

# #338: one Stop *event* fans out to several `stop-check` invocations — two registrations
# in .claude/settings.json (shell-string form and args-array form) plus one in
# ~/.claude/settings.json — and every one of them writes the same ledger. Counting
# invocations made `stop_blocks` climb 3 per event, so the release at > MAX_STOP_BLOCKS
# fired around the SECOND Stop: a zero-command bypass, cheaper than any disclosed one.
#
# There is no event id in the payload to key on, so identity is (payload digest, recency):
# the fan-out invocations for one event receive byte-identical payloads microseconds apart,
# while a genuine next Stop is separated by a whole model turn. The window is deliberately
# short — if two real Stops ever land inside it with an identical payload the second is not
# counted, which fails toward blocking (the gate stays shut longer), never toward release.
STOP_EVENT_WINDOW_SECONDS = 5

# #342: the shared ledger key every unresolved identity lands on. A verdict read
# from it witnesses nothing, so it is never trusted (see `is_no_session_ledger`).
NO_SESSION = "no-session"

# `.claude/<name>`: the cross-agent escalation mirror. Worker subagents route their open
# items here instead of blocking (FR-8); `status --all` shows it and `cross-agent-clear`
# is the one command that empties it. Defined up here with the other constants because
# BOTH halves need it — the Stop-side writer below and the CLI-side readers at the end.
CROSS_AGENT_ISSUES = "cross-agent-issues.json"

# FR-8 / FR-A(d): every mirror entry carries this disposition. FR-A(d) filters the
# Stop-time re-raise to exactly this value, so an entry written without it is inert.
PENDING_ESCALATION = "pending-escalation"


# --------------------------------------------------------------------------- #
# I/O helpers
# --------------------------------------------------------------------------- #
def read_payload() -> dict:
    """Read the hook JSON from stdin. Returns {} on any problem."""
    try:
        raw = sys.stdin.read()
        return json.loads(raw) if raw.strip() else {}
    except Exception:
        return {}


def project_dir(payload: dict | None = None) -> Path:
    env = (
        os.environ.get("CLAUDE_PROJECT_DIR")
        or os.environ.get("CURSOR_PROJECT_DIR")
        or os.environ.get("GROK_WORKSPACE_ROOT")
    )
    if env:
        return Path(env)
    p = payload or {}
    roots = p.get("workspace_roots")
    if isinstance(roots, list) and roots:
        return Path(roots[0])
    if p.get("workspaceRoot"):
        return Path(p["workspaceRoot"])
    if p.get("cwd"):
        return Path(p["cwd"])
    return Path.cwd()


def state_dir(proj: Path) -> Path:
    d = proj / ".claude" / "state"
    d.mkdir(parents=True, exist_ok=True)
    return d


def ledger_path(proj: Path, session_id: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", session_id or NO_SESSION)
    return state_dir(proj) / f"gate-{safe}.json"


def _session_file(proj: Path) -> Path:
    """Sentinel holding the active session id, so the CLI and Stop gate agree.

    #342: this is ``current-session.json``, not the old extensionless
    ``current-session``. ``verify-completion.sh`` repairs the GitButler-wiped state dir by
    copying ``*.json`` out and deleting everything else — so the extensionless sentinel was
    destroyed on exactly the turns the repair exists for, dropping the CLI back to the
    shared ``no-session`` ledger.
    """
    return state_dir(proj) / "current-session.json"


def _legacy_session_file(proj: Path) -> Path:
    """The pre-#342 extensionless sentinel, still read so an in-flight session survives."""
    return state_dir(proj) / "current-session"


def _write_session_sentinel(proj: Path, sid: str) -> None:
    try:
        _session_file(proj).write_text(json.dumps({"session_id": sid}, indent=2))
    except Exception:
        pass


def _read_session_sentinel(proj: Path) -> str:
    """Read the sentinel, tolerating the JSON form, a bare id, and the legacy file."""
    for path in (_session_file(proj), _legacy_session_file(proj)):
        if not path.exists():
            continue
        try:
            raw = path.read_text().strip()
        except Exception:
            continue
        if not raw:
            continue
        if raw.startswith("{"):
            try:
                sid = str(json.loads(raw).get("session_id") or "").strip()
            except Exception:
                sid = ""
            if sid:
                return sid
            continue
        return raw
    return ""


RECORD_ERRORS_FILE = "gate-record-errors.json"


def record_errors_path(proj: Path) -> Path:
    """Marker file listing failed ``record-failure`` invocations (#341).

    ``verify-completion.sh`` used to run ``record-failure … >/dev/null 2>&1 || true``, so a
    recorder that failed for any reason recorded nothing, ``open_items`` saw nothing and
    Stop **passed** — fail-open on the one path whose entire job is recording failures.

    The hook now appends here instead. Written by the shell with plain ``printf``, so it
    does not depend on the thing that just failed, and named ``*.json`` so it survives
    ``verify-completion.sh``'s ``*.json``-only state-dir repair.
    """
    return state_dir(proj) / RECORD_ERRORS_FILE


def read_record_errors(proj: Path) -> list:
    path = record_errors_path(proj)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text())
    except Exception:
        # Unparseable marker still means "the recorder failed" — do not silently drop it.
        return [{"check": "(unparseable marker)", "detail": path.name}]
    return data if isinstance(data, list) else []


def load_ledger(path: Path) -> dict:
    if path.exists():
        try:
            return json.loads(path.read_text())
        except Exception:
            pass
    return {"session_id": path.stem, "task_critic": None, "checks": {}, "stop_blocks": 0}


def save_ledger(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, indent=2))


# --------------------------------------------------------------------------- #
# Harness detection + session resolution
# --------------------------------------------------------------------------- #
def _harness(payload: dict | None) -> str:
    """'cursor', 'grok', or 'claude', inferred from payload shape / env (ADR-0062)."""
    p = payload or {}
    if "conversation_id" in p or "cursor_version" in p or "generation_id" in p:
        return "cursor"
    # Grok Build: env is the strongest signal; camelCase envelope is secondary.
    if (
        os.environ.get("GROK_SESSION_ID")
        or os.environ.get("GROK_HOOK_EVENT")
        or "sessionId" in p
        or "workspaceRoot" in p
        or p.get("hookEventName")
        in {
            "pre_tool_use",
            "post_tool_use",
            "stop",
            "session_start",
            "session_end",
            "subagent_stop",
        }
    ):
        return "grok"
    return "claude"


def _sid_from_payload(payload: dict | None) -> str:
    p = payload or {}
    return (
        p.get("session_id")
        or p.get("sessionId")
        or p.get("conversation_id")
        or ""
    )


def resolve_session(proj: Path, payload: dict | None = None, *, persist: bool = False) -> str:
    """Resolve the active session id from every available source, consistently.

    Order: payload (Claude session_id / Cursor conversation_id) -> env -> --session ->
    the persisted sentinel -> 'no-session'. When ``persist`` (hook paths that hold a
    payload), the resolved id is written to the sentinel so the CLI path can find it.
    """
    sid = _sid_from_payload(payload)
    if sid:
        if persist:
            _write_session_sentinel(proj, sid)
        return sid
    sid = (
        # #342: CLAUDE_CODE_SESSION_ID is the variable this harness actually exports.
        # The gate read only CLAUDE_SESSION_ID, which nothing sets — the whole env tier
        # was dead code, and every CLI invocation fell through to `no-session`.
        os.environ.get("CLAUDE_CODE_SESSION_ID")
        or os.environ.get("CLAUDE_SESSION_ID")
        or os.environ.get("CURSOR_CONVERSATION_ID")
        or os.environ.get("GROK_SESSION_ID")
        or _arg("--session")
    )
    if sid:
        return sid
    sid = _read_session_sentinel(proj)
    if sid:
        return sid
    return NO_SESSION


# --------------------------------------------------------------------------- #
# Output emitters (harness-aware)
# --------------------------------------------------------------------------- #
def emit_allow() -> None:
    """Allow the action: exit 0, no output (both harnesses treat this as allow)."""
    sys.exit(0)


def emit_stop_block(reason: str, harness: str = "claude") -> None:
    """Block / re-drive on Stop. Claude/Grok hard-block; Cursor re-drives via followup_message."""
    if harness == "cursor":
        # Cursor's stop hook cannot hard-block; a followup_message auto-continues the
        # agent (bounded by Cursor's loop_limit), achieving loop closure.
        print(json.dumps({"followup_message": reason}))
    else:
        # Claude and Grok share decision/block vocabulary for Stop (ADR-0062).
        print(json.dumps({"decision": "block", "reason": reason}))
    sys.exit(0)


def emit_pretool(decision: str, reason: str, harness: str = "claude") -> None:
    """decision is 'deny' or 'ask'. 'allow'/silent uses emit_allow()."""
    if harness == "cursor":
        # Cursor permission protocol: allow|deny|ask, with messages for the user/agent.
        print(json.dumps({"permission": decision, "user_message": reason, "agent_message": reason}))
    elif harness == "grok":
        # Grok PreToolUse: flat {"decision": "allow"|"deny", "reason": ...}. No documented
        # ask — map ask → deny with an explicit human-confirmation prefix (fail-closed).
        if decision == "ask":
            print(
                json.dumps(
                    {
                        "decision": "deny",
                        "reason": f"Human confirmation required: {reason}",
                    }
                )
            )
        else:
            print(json.dumps({"decision": decision, "reason": reason}))
    else:
        print(
            json.dumps(
                {
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": decision,
                        "permissionDecisionReason": reason,
                    }
                }
            )
        )
    sys.exit(0)


# --------------------------------------------------------------------------- #
# 1. Stop / SubagentStop loop-closer
# --------------------------------------------------------------------------- #
def is_no_session_ledger(ledger: dict) -> bool:
    """True when this ledger is the shared unresolved-identity one (#342).

    Both spellings must match: a ledger already on disk carries
    ``"session_id": "no-session"``, while ``load_ledger``'s default for a *missing* file
    uses the path stem, which is ``"gate-no-session"``. Checking only one form would let
    the other through.
    """
    sid = str(ledger.get("session_id") or "")
    return sid in (NO_SESSION, f"gate-{NO_SESSION}")


def is_subagent_stop(payload: dict | None) -> bool:
    """True when this Stop payload is a **SubagentStop** (#337 FR-8).

    Ported from the machine-global gate, whose one-line ``event == "SubagentStop"`` test is
    Claude-only. This binary also runs under Cursor and Grok Build, which spell the same
    event ``subagent_stop`` in ``hookEventName`` (see :func:`_harness`), so the name is
    normalised (case, separators) and read from every envelope key.

    An absent or unrecognised event name is **not** a subagent stop: falling through to
    ``False`` treats it as a main Stop, which is the fail-toward-blocking direction — the
    gate stays armed rather than silently waiving the receipt for the main agent.
    """
    p = payload or {}
    raw = p.get("hook_event_name") or p.get("hookEventName") or p.get("event") or ""
    return re.sub(r"[^a-z]", "", str(raw).lower()) == "subagentstop"


def escalate_to_mirror(proj: Path, items: list[str], session_id: str, *, now: float) -> int:
    """Write ``items`` to ``.claude/cross-agent-issues.json``; return how many were new.

    #337 FR-8's routing half: a worker that cannot legitimately clear the main task's
    receipt must not be blocked by it, but its open items must not vanish either — they
    land here, where ``status --all`` shows them and ``cross-agent-clear --all`` empties
    them.

    **Deduped on (session_id, item), which is the deviation from the global gate's
    version.** FR-A(d) deletes that binary's bulk append precisely because it re-appended
    every open item on every subagent stop — 34 measured copies of one entry, all from one
    session — turning an operator artifact into an unbounded log. Appending only entries
    not already present preserves the escalation feature without the growth, so this is a
    PORT of the branch and a DECLINE of the bulk append (FR-7 convergence table).

    Entries are stamped ``disposition: "pending-escalation"`` so FR-A(d)'s filtered
    Stop-time re-raise can recognise them. Fails OPEN in both directions: an unreadable
    mirror is replaced rather than allowed to block the write (a file nothing can parse
    escalates nothing), and a failed write returns 0 rather than raising into the Stop path.
    """
    path = Path(proj) / ".claude" / CROSS_AGENT_ISSUES
    try:
        raw = json.loads(path.read_text()) if path.is_file() else []
    except Exception:
        raw = []

    # Both shapes `_cross_agent_issues` accepts: a bare list, or a dict wrapping `items`.
    # The wrapper (and any sibling keys an operator added) is preserved on write-back.
    doc: dict | None = None
    if isinstance(raw, dict):
        doc = raw
        entries = raw.get("items")
        entries = entries if isinstance(entries, list) else []
    elif isinstance(raw, list):
        entries = raw
    else:
        entries = []

    seen = {
        (str(e.get("session_id") or ""), str(e.get("item") or ""))
        for e in entries
        if isinstance(e, dict)
    }
    added = 0
    for item in items:
        key = (str(session_id), str(item))
        if key in seen:
            continue
        seen.add(key)
        entries.append(
            {
                "item": item,
                "at": int(now),
                "session_id": session_id,
                "disposition": PENDING_ESCALATION,
            }
        )
        added += 1
    if not added:
        return 0

    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        if doc is not None:
            doc["items"] = entries
            path.write_text(json.dumps(doc, indent=2))
        else:
            path.write_text(json.dumps(entries, indent=2))
    except Exception:
        return 0
    return added


TASK_CRITIC_REMEDIATION = (
    "`python .claude/hooks/gate.py task-critic-receipt --verdict PASS|BLOCK "
    "--requirements-file TASK.md --note '...'`"
)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def open_items(
    ledger: dict,
    require_task_critic: bool,
    record_errors: list | None = None,
    proj: Path | None = None,
) -> list[str]:
    """Unresolved Stop-gate items for a session, read from its FILE ledger dict.

    Reads the task-critic verdict and the undisposed failed/skipped checks
    directly out of the ``gate-<session>.json`` ledger dict (no DB, no
    ``state.py`` sibling). A missing/garbled ledger arrives here as
    ``load_ledger``'s safe default (``task_critic`` None, empty ``checks``),
    which blocks iff a task is declared.

    ``proj`` is optional only so the read-only inspectors (``status --all``) can
    walk foreign ledgers without a project root; when it is given, the recorded
    ``requirements_hash`` is compared against the live ``TASK.md``.
    """
    items: list[str] = []

    if require_task_critic:
        tc = ledger.get("task_critic")
        # #342: a verdict read out of the shared `no-session` ledger witnesses nothing.
        # That key is predictable and every session that fails to resolve an identity
        # lands on it, so one stale PASS there satisfied the gate for all of them — and
        # one was found live, with a `requirements_hash` that still matched. Checks and
        # dispositions in that ledger stay honoured (refusing them would break the
        # documented remediation, which resolves to `no-session` itself); only the
        # verdict is distrusted.
        if is_no_session_ledger(ledger):
            tc = None
        if not tc or tc.get("verdict") != "PASS":
            items.append(
                "task-critic has not recorded a PASS for this session. Run the "
                "task-critic subagent against TASK.md, then record the receipt: "
                + TASK_CRITIC_REMEDIATION
            )
        # #337 FR-7: a PASS with no `requirements_hash` is the exact shape the retired
        # bare `task-critic` command wrote, and it is unfalsifiable — nothing about it
        # witnesses that the requirements were ever read. It is rejected here as well as
        # at the write site because ledgers outlive the binary: a record left by an older
        # gate.py (or hand-written into `.claude/state/`, which is in no PATH_DENY) would
        # otherwise still satisfy the Stop gate on the new one.
        elif not tc.get("requirements_hash"):
            items.append(
                "task-critic PASS carries no requirements_hash — that is the retired "
                "self-certification shape and is not accepted. Re-run task-critic, then: "
                + TASK_CRITIC_REMEDIATION
            )
        elif proj is not None:
            task_md = Path(proj) / "TASK.md"
            try:
                current = sha256_file(task_md) if task_md.exists() else None
            except OSError:
                # Narrow the blast radius: `cmd_stop_check` fails OPEN on any exception, so
                # an unreadable TASK.md must not turn a staleness comparison it cannot make
                # into a release of the whole gate. Skip only this one item.
                current = None
            if current and tc["requirements_hash"] != current:
                items.append(
                    "task-critic receipt is stale — TASK.md changed since the receipt "
                    "was recorded. Re-run task-critic, then: " + TASK_CRITIC_REMEDIATION
                )

    for name, rec in ledger.get("checks", {}).items():
        if rec.get("status") in ("failed", "skipped") and not rec.get("disposition"):
            detail = rec.get("detail") or ""
            items.append(
                f"check '{name}' is {rec['status']} with no disposition"
                + (f" ({detail})" if detail else "")
                + ". Either fix it and re-run, or record a disposition: "
                f"`python .claude/hooks/gate.py dispose --check '{name}' "
                "--status fixed|deferred|ticket|ignore --note '...'`."
            )

    # #341: the recorder itself failed, so the ledger above is INCOMPLETE and a clean
    # `checks` map proves nothing. Block, and name the command that clears it — an
    # unclearable item would just be a different broken gate (see #343).
    for err in record_errors or []:
        if not isinstance(err, dict):
            err = {"check": str(err)}
        name = err.get("check") or "(unnamed)"
        detail = err.get("detail") or err.get("exit") or ""
        items.append(
            f"the gate could not record check '{name}'"
            + (f" ({detail})" if detail else "")
            + " — the ledger for this session is INCOMPLETE, so a clean checks list is not "
            "evidence. Investigate, then clear the marker: "
            "`python .claude/hooks/gate.py clear-record-errors`."
        )
    return items


class StopDecision:
    """Outcome of the Stop loop-closer core — a test seam over ``cmd_stop_check``.

    ``blocks`` is the gate verdict; ``items`` the unresolved reasons; ``reason``
    the harness-facing message; ``released`` marks a bounded loop-guard release
    (block became allow after ``MAX_STOP_BLOCKS``), which the caller surfaces
    loudly on stderr. ``escalated`` (FR-8) marks the other non-blocking-with-items
    outcome: a SubagentStop whose items were routed to the cross-agent mirror.
    Both flags mean "allowed, but say so on stderr" — they are kept separate
    because a release is a gate FAILURE mode and an escalation is the designed
    path, and a reader must not have to guess which one happened.
    """

    def __init__(
        self,
        *,
        blocks: bool,
        items: list[str],
        reason: str,
        released: bool = False,
        escalated: bool = False,
    ) -> None:
        self.blocks = blocks
        self.items = items
        self.reason = reason
        self.released = released
        self.escalated = escalated


def _stop_event_digest(payload: dict | None) -> str:
    """Stable digest of a Stop payload, used to recognise one event's fan-out (#338).

    The registrations that fire for a single Stop event all receive the same payload, so
    equal digests within :data:`STOP_EVENT_WINDOW_SECONDS` mean "same event, counted
    already". Sorted keys so dict ordering cannot change the digest.
    """
    try:
        blob = json.dumps(payload or {}, sort_keys=True, default=str)
    except Exception:
        blob = repr(payload)
    return hashlib.sha256(blob.encode("utf-8", "replace")).hexdigest()[:16]


def _is_repeat_stop_invocation(ledger: dict, payload: dict | None, *, now: float) -> bool:
    """True when this call is another registration firing for an already-counted event."""
    last = ledger.get("last_stop")
    if not isinstance(last, dict):
        return False
    if last.get("digest") != _stop_event_digest(payload):
        return False
    try:
        age = now - float(last.get("at", 0))
    except (TypeError, ValueError):
        return False
    return 0 <= age <= STOP_EVENT_WINDOW_SECONDS


def _stamp_stop_invocation(ledger: dict, payload: dict | None, *, now: float) -> None:
    ledger["last_stop"] = {"digest": _stop_event_digest(payload), "at": int(now)}


def evaluate_stop(
    proj: Path,
    payload: dict | None = None,
    session_id: str | None = None,
    *,
    now: float | None = None,
) -> StopDecision:
    """Pure core of the Stop loop-closer: decide block vs. allow over the FILE ledger.

    Stop-gate state lives entirely in ``.claude/state/gate-<session>.json`` (task-
    critic verdict, per-check status/disposition, the ``stop_blocks`` counter).
    A missing/garbled ledger is treated as "unresolved" via ``load_ledger``'s
    safe default (``task_critic`` None), which blocks iff ``TASK.md`` exists. The
    ``stop_blocks`` loop-guard counter lives in the ledger dict: it increments on
    each consecutive block and releases once it exceeds ``MAX_STOP_BLOCKS``.

    **SubagentStop takes a different branch (#337 FR-8).** A worker subagent cannot
    legitimately record the main task's task-critic receipt — the SubagentStop payload
    carries no agent identity, so the receipt would witness only that *a* subagent ran —
    and it shares one ledger with the main agent. So on a subagent stop this function
    (a) does not require the receipt, (b) never blocks, (c) never reads or writes the
    shared ``stop_blocks`` counter in EITHER direction (incrementing it would spend the
    main agent's loop-guard budget on workers; resetting it would hand the main agent a
    fresh budget every time it dispatched one), and (d) routes any real open items to the
    escalation mirror so they survive the worker's exit.
    """
    proj = Path(proj)
    if now is None:
        now = time.time()
    if session_id is None:
        session_id = resolve_session(proj, payload)
    lpath = ledger_path(proj, session_id)
    ledger = load_ledger(lpath)
    subagent = is_subagent_stop(payload)
    require_tc = not subagent and (proj / "TASK.md").exists()

    items = open_items(
        ledger,
        require_task_critic=require_tc,
        record_errors=read_record_errors(proj),
        proj=proj,
    )
    if not items:
        # Clean pass: reset the consecutive-block counter and allow. Not on a subagent
        # stop — see (c) above; the counter belongs to the main agent's Stop loop.
        if not subagent and ledger.get("stop_blocks"):
            ledger["stop_blocks"] = 0
            save_ledger(lpath, ledger)
        return StopDecision(blocks=False, items=[], reason="")

    if subagent:
        # FR-8: escalate, never block. The items are real (failed checks, recorder
        # errors) but they are the SESSION's, not this worker's to clear.
        written = escalate_to_mirror(proj, items, session_id, now=now)
        reason = (
            f"[gate] SubagentStop: {len(items)} open item(s) escalated to "
            f".claude/{CROSS_AGENT_ISSUES} ({written} new); the subagent is not blocked.\n"
            "  - " + "\n  - ".join(items) + "\n"
        )
        return StopDecision(blocks=False, items=items, reason=reason, escalated=True)

    # Loop guard: count CONSECUTIVE blocked EVENTS; never hang a session forever.
    # #338: dedupe the fan-out so N registrations for one Stop event count once.
    if _is_repeat_stop_invocation(ledger, payload, now=now):
        counted = int(ledger.get("stop_blocks", 0)) or 1
    else:
        counted = int(ledger.get("stop_blocks", 0)) + 1
        ledger["stop_blocks"] = counted
    _stamp_stop_invocation(ledger, payload, now=now)
    save_ledger(lpath, ledger)
    if counted > MAX_STOP_BLOCKS:
        # #338: re-arm. Leaving the counter above the ceiling left the gate open for the
        # rest of the session — every later Stop released too, with no further warning.
        ledger["stop_blocks"] = 0
        ledger.setdefault("releases", []).append(
            {"at": int(now), "items": list(items), "after_blocks": counted}
        )
        save_ledger(lpath, ledger)
        reason = (
            f"[gate] WARNING: enforcement gate released after {counted} blocked Stop events "
            "with unresolved items:\n  - " + "\n  - ".join(items) + "\n"
            "[gate] The counter has been reset, so the gate re-arms on the next Stop. "
            "This release is recorded in the ledger and shown by `gate.py status`.\n"
        )
        return StopDecision(blocks=False, items=items, reason=reason, released=True)

    reason = (
        "Do not end the turn yet. The enforcement gate found unresolved "
        f"items ({len(items)}):\n\n  - "
        + "\n  - ".join(items)
        + "\n\nResolve each, then stop. This is the loop-closure rule: no "
        "session ends on a failed or skipped check without a written "
        "disposition."
    )
    return StopDecision(blocks=True, items=items, reason=reason)


LEDGER_MAX_AGE_DAYS = 30  # FR-7: prune gate-*.json ledgers older than this


def _prune_aged_ledgers(proj: Path, current_session: str | None = None) -> None:
    """FR-7: self-prune aged ``gate-*.json`` ledgers at every stop-check.

    Deletes ledgers whose mtime is older than 30 days, EXCLUDING: (a) the
    current session's ledger, (b) any ledger with an undisposed ``failed`` or
    ``skipped`` check, (c) any ledger carrying a task-critic ``BLOCK`` verdict.

    Single ``os.scandir`` pass (budget <10ms), stdlib-only, and fails OPEN: any
    error is swallowed and it never blocks or raises.
    """
    try:
        proj = Path(proj)
        sdir = proj / ".claude" / "state"
        cutoff = time.time() - LEDGER_MAX_AGE_DAYS * 86400
        keep = ledger_path(proj, current_session).name if current_session is not None else None
        with os.scandir(sdir) as it:
            for entry in it:
                name = entry.name
                if not (name.startswith("gate-") and name.endswith(".json")):
                    continue
                if name == keep:
                    continue
                try:
                    if entry.stat().st_mtime >= cutoff:
                        continue
                    data = json.loads(Path(entry.path).read_text())
                    checks = data.get("checks") or {}
                    if any(
                        c.get("status") in ("failed", "skipped") and not c.get("disposition")
                        for c in checks.values()
                    ):
                        continue
                    tc = data.get("task_critic")
                    # task_critic is a dict {"verdict": "BLOCK", ...} — a bare
                    # `== "BLOCK"` never matches, so a BLOCK ledger would be wrongly pruned.
                    if isinstance(tc, dict) and tc.get("verdict") == "BLOCK":
                        continue
                    Path(entry.path).unlink()
                except Exception:
                    continue
    except Exception:
        pass


def _tripwire_check(proj: Path) -> None:
    """FR-2.4c: warn-only, schema-aware, harness-general drift tripwire.

    At Stop, hash each hook named in the committed ``.abstract-data/hooks-manifest.json``
    trust anchor and compare it to the recorded ``sha256``. The manifest is read
    schema-aware — the deployed hook must never parse a schema it predates:

    * a **schema-2 envelope** (``{"schema": int, "entries": {"<relpath>": {...}}}``) →
      each entry key is a PROJECT-RELATIVE path resolved as ``proj/<relpath>``, so a
      ``.cursor/hooks/*`` copy is exactly as visible as the ``.claude/hooks/*`` one
      (no hardcoded hooks dir);
    * a **legacy v1** flat basename object (NO ``"schema"`` key) → each basename is
      resolved under ``proj/.claude/hooks/`` AND ONE loud migrate warning naming the
      legacy schema is emitted — never a silent fail-open.

    On any hash mismatch emit ONE warn-only stderr line listing the drifted keys. Never
    blocks (always returns ``None``). Budget <20ms; fails OPEN (any error swallowed).
    SILENT when the manifest is missing or unparseable -- and it short-circuits BEFORE
    hashing on that silent path so the common case is near-zero cost.
    """
    try:
        proj = Path(proj)
        manifest_path = proj / ".abstract-data" / "hooks-manifest.json"
        if not manifest_path.is_file():
            return None
        try:
            manifest = json.loads(manifest_path.read_text())
        except (json.JSONDecodeError, OSError, ValueError):
            return None
        if not isinstance(manifest, dict):
            return None

        # Schema-aware key resolution. schema-2 keys are project-relative paths; a legacy
        # v1 flat object (no "schema") is basename-keyed under .claude/hooks/.
        legacy = "schema" not in manifest
        if legacy:
            hooks_dir = proj / ".claude" / "hooks"
            resolved = [(key, entry, hooks_dir / key) for key, entry in manifest.items()]
        else:
            entries = manifest.get("entries")
            if not isinstance(entries, dict):
                # Corrupt schema envelope: fail OPEN (silent), never crash a deployed hook.
                return None
            resolved = [(key, entry, proj / key) for key, entry in entries.items()]

        if legacy:
            # Loud, exactly-once: a legacy manifest must be migrated (never a silent pass).
            print(
                "[gate] WARNING: legacy schema-1 hooks manifest — run "
                "`hooks upgrade --adopt`",
                file=sys.stderr,
            )

        drifted: list[str] = []
        for key, entry, script_path in resolved:
            if not isinstance(entry, dict):
                continue
            expected = entry.get("sha256")
            if not expected:
                continue
            try:
                actual = hashlib.sha256(script_path.read_bytes()).hexdigest()
            except OSError:
                continue
            if actual != expected:
                drifted.append(key)

        if drifted:
            print(
                "[gate] WARNING: deployed hook drift vs committed manifest: "
                + ", ".join(sorted(drifted)),
                file=sys.stderr,
            )
        return None
    except Exception:
        return None


def cmd_stop_check() -> None:
    payload = read_payload()
    proj = project_dir(payload)
    harness = _harness(payload)

    try:
        session_id = resolve_session(proj, payload, persist=True)

        # FR-7: self-prune aged gate-*.json ledgers (fails open; never blocks).
        _prune_aged_ledgers(proj, current_session=session_id)

        # FR-11: warn-only drift tripwire vs the committed hooks manifest
        # (silent when no/unparseable manifest; fails open; never blocks).
        _tripwire_check(proj)

        # evaluate_stop reads the session's FILE ledger and decides block vs.
        # allow. A missing/garbled ledger is treated as unresolved (blocks iff
        # TASK.md exists); the bounded-release counter lives in the ledger dict.
        decision = evaluate_stop(proj, payload, session_id=session_id)
        if not decision.blocks:
            if decision.released or decision.escalated:
                # Allowed, but never silently: a loop-guard release is a gate failure and
                # an FR-8 escalation is a handoff. Both go to stderr, where the human and
                # the transcript can see what was let through and why.
                sys.stderr.write(decision.reason)
            emit_allow()

        emit_stop_block(decision.reason, harness)

    except SystemExit:
        raise
    except Exception as exc:  # fail OPEN on a gate bug; never brick the session
        sys.stderr.write(f"[gate] internal error in stop-check, allowing: {exc}\n")
        emit_allow()


# --------------------------------------------------------------------------- #
# 2. Dangerous-ops PreToolUse gate
# --------------------------------------------------------------------------- #
# Hard DENY: never appropriate for an agent to do autonomously.
# Any per-harness deployed-hooks directory (Claude / Cursor / Antigravity / Copilot). Since the
# schema-2 tripwire is cross-harness (FR-2.3), the enforcement gate is now a first-class trust
# anchor under EACH tool's hooks dir — so the pre-write protection layer (FR-2.2) must guard them
# all, not just .claude/hooks/. A tampered .cursor/hooks/gate.py must be as protected as the
# Claude one. The leading literal dot keeps `plugins/abstract-data-claude/hooks/` (no dot) out.
_HOOKS_DIR = r"\.(?:claude|cursor|agents|github|grok)/hooks/"

BASH_DENY = [
    (re.compile(r"\bgit\s+config\s+--global\b"),
     "Global git config changes are blocked. Make this change yourself."),
    (re.compile(r"\bchmod\b.*" + _HOOKS_DIR),
     "Modifying enforcement hook files is blocked."),
]

# FR-6.6: the three authoring-repo enforcement SOURCES still uncovered after #188 —
# the hook source tree, the frozenset-bearing catalog-sync test, and the
# selection-narrowing file. Shared alternation so the sed / cp|mv|tee / redirect
# write-form rules below stay DRY. Harmless in deployed target projects (these paths
# do not exist there).
_FR66_TARGETS = (
    r"(?:src/abstract_data/project_tools/hooks/"
    r"|tests/test_hooks_catalog_sync\.py"
    r"|\.abstract-data/selection\.toml)"
)

# ASK (escalate to human): the "meaning-changing" operations from the review.
BASH_ASK = [
    (re.compile(r"\bgit\s+push\b.*(--force|-f)\b"),
     "Force push — confirm target branch and that this is intended."),
    (re.compile(r"\bgit\s+push\b.*\b(main|master|preview|prod|production|release)\b"),
     "Push to a protected branch — confirm before proceeding."),
    (re.compile(r"\bgit\s+reset\s+--hard\b"),
     "Hard reset discards work — confirm."),
    (re.compile(r"\bgit\s+clean\s+-[a-z]*f"),
     "git clean -f deletes untracked files — confirm."),
    (re.compile(r"\balembic\s+(upgrade|downgrade)\b"),
     "Alembic migration run — confirm the target DB is NOT a cloud/production "
     "database (house rule: no cloud alembic upgrades)."),
    (re.compile(r"\bsupabase\s+db\s+(push|reset)\b"),
     "Supabase schema push/reset against a remote project — confirm."),
    (re.compile(r"\bpsql\b.*-c\b.*\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER)\b", re.I),
     "Direct SQL write/DDL — confirm (house rule: prefer migrations / queued "
     "discovery over direct SQL backfill)."),
    # Anchor `but` as the INVOKED command — at command start, after a shell
    # separator (\n ; & |), or behind a command runner (command/sudo/env/exec),
    # optional leading flags, then the state verb. A bare `\bbut\b` matched the
    # English word "but" anywhere before a config/reset/undo token (e.g.
    # `git commit -m "fix undo path but keep config"`), a live FP once gate.py
    # deployed to Cursor. The runner-word branch (FR-6.1, decision A) still
    # requires the state verb IMMEDIATELY after `but` (modulo flags), so a runner
    # word merely appearing earlier in prose does not trip it; a rare residual FP
    # like "run that command but reset it" only costs a human ASK, never a deny.
    (re.compile(r"(?:^|[\n;&|]|\b(?:command|sudo|env|exec)\s+)\s*but\s+(?:-\S+\s+)*(?:config|reset|undo)\b"),
     "GitButler state-changing operation — confirm."),
    (re.compile(r"\brm\s+-rf\b"),
     "Recursive force delete — confirm path."),
    # FR-12: shell write-forms targeting the committed hooks manifest or the
    # .claude/hooks/ dir are trust-anchor tampering — escalate to human. Anchored
    # to a write verb *followed by* the target so a bare mention in an unrelated
    # arg (e.g. a --note) does not trip (memory: gate-bash-deny-false-positive).
    (re.compile(r"\bsed\s+-i\b.*(?:\.abstract-data/hooks-manifest\.json|" + _HOOKS_DIR + ")", re.I),
     "in-place edit of the hooks manifest or a deployed hooks dir — confirm (trust anchor)."),
    (re.compile(r"\b(?:cp|mv|tee)\b\s+.*(?:\.abstract-data/hooks-manifest\.json|" + _HOOKS_DIR + ")", re.I),
     "cp/mv/tee onto the hooks manifest or a deployed hooks dir — confirm (trust anchor)."),
    # ``.*`` (not ``\s*``) after the operator so ``> ./.claude/hooks/x``, an absolute
    # path, or a quoted target is still caught — matching the sibling cp/mv/tee rule.
    (re.compile(r">>?.*(?:\.abstract-data/hooks-manifest\.json|" + _HOOKS_DIR + ")", re.I),
     "redirect onto the hooks manifest or a deployed hooks dir — confirm (trust anchor)."),
    # FR-2.2/1.7: shell write-forms targeting the skill-behavior coverage manifest or an
    # eval baseline are eval trust-anchor tampering — escalate to human. Anchored to a
    # write verb *followed by* the target so a bare mention in an unrelated arg (e.g. a
    # --note) does not trip (memory: gate-bash-deny-false-positive).
    (re.compile(r"\bsed\s+-i\b.*(?:tests/skill-behavior/coverage\.yaml|evals/baselines/)", re.I),
     "in-place edit of the coverage manifest or evals/baselines/ — confirm (eval trust anchor)."),
    (re.compile(r"\b(?:cp|mv|tee)\b\s+.*(?:tests/skill-behavior/coverage\.yaml|evals/baselines/)", re.I),
     "cp/mv/tee onto the coverage manifest or evals/baselines/ — confirm (eval trust anchor)."),
    (re.compile(r">>?.*(?:tests/skill-behavior/coverage\.yaml|evals/baselines/)", re.I),
     "redirect onto the coverage manifest or evals/baselines/ — confirm (eval trust anchor)."),
    # FR-6.6: shell write-forms onto the authoring repo's enforcement sources — the hook
    # source tree, the frozenset-bearing catalog-sync test, and the selection-narrowing
    # file — get ASK friction backing human PR review (the enforcement pin is a
    # diff-visibility aid, not a mechanical control; FR-2.2). Anchored to a write verb
    # *followed by* the target so a bare mention in a --note does not trip.
    (re.compile(r"\bsed\s+-i\b.*" + _FR66_TARGETS, re.I),
     "in-place edit of an enforcement source (hook sources / catalog-sync test / "
     "selection.toml) — confirm (FR-6.6 authoring-repo trust anchor)."),
    (re.compile(r"\b(?:cp|mv|tee)\b\s+.*" + _FR66_TARGETS, re.I),
     "cp/mv/tee onto an enforcement source (hook sources / catalog-sync test / "
     "selection.toml) — confirm (FR-6.6 authoring-repo trust anchor)."),
    (re.compile(r">>?.*" + _FR66_TARGETS, re.I),
     "redirect onto an enforcement source (hook sources / catalog-sync test / "
     "selection.toml) — confirm (FR-6.6 authoring-repo trust anchor)."),
    # FR-3.4: `hooks provision` writes into EVERY root it is handed — one confirmation
    # covering a whole fleet, with the apply-preflight escape set for its children.
    # Anchored on the BINARY (`abstract[-_]data … hooks provision`) rather than on the
    # words, so prose mentioning "hooks provision" in a commit message or a --note
    # cannot trip it (memory: gate-bash-deny-false-positive).
    (re.compile(r"\babstract[-_]data\b(?:\s+\S+)*\s+hooks\s+provision\b"),
     "Fleet provisioning: `hooks provision` runs apply/retrofit across every root given "
     "— confirm the root list and that a fleet-wide write is intended."),
]

# Edit/Write DENY by path: hook self-modification + the state store.
#
# Patterns are case-INSENSITIVE: on a case-insensitive filesystem (macOS APFS,
# Windows) a case-varied path (``.Claude/hooks/gate.py``) resolves to the same
# protected file, so a case-sensitive rule would be a trivial Edit/Write bypass.
PATH_DENY = [
    (re.compile(_HOOKS_DIR, re.I),
     "Editing enforcement hook files is blocked. Change them via a reviewed PR."),
    (re.compile(r"\.claude/settings(\.local)?\.json$", re.I),
     "Editing hook settings is blocked. Change them via a reviewed PR."),
    # FR-12: the committed manifest is a trust anchor with the same Edit/Write
    # protection as .claude/hooks/. (Also covered by the .abstract-data/ rule
    # below; kept explicit so the trust-anchor intent is legible.)
    (re.compile(r"\.abstract-data/hooks-manifest\.json$", re.I),
     "Editing the hooks manifest is blocked. It is a trust anchor; reconcile via "
     "the state CLI / a reviewed PR."),
    # Defense-in-depth (spec §9 step 3): block a raw Edit/Write into the state
    # store dir (state.db, attestations/*.json, ledgers). This closes the
    # raw-file forge path only; it does NOT claim to close the sqlite3/`python -c`
    # bypass (per the honest FR-7 threat model). Writes go through the state CLI.
    (re.compile(r"\.abstract-data/", re.I),
     "Direct writes to the .abstract-data/ state store are blocked. Use the "
     "`abstract-data state` CLI / attestation API."),
    # FR-2.2/1.7: the skill-behavior coverage manifest and the eval baselines are
    # trust anchors on the same footing as the hooks manifest — a raw Edit/Write
    # silently changes what "passing" means. Regenerate via the sanctioned
    # eval-compile path / a reviewed PR, never a direct edit.
    (re.compile(r"tests/skill-behavior/coverage\.yaml$", re.I),
     "Editing the skill-behavior coverage manifest is blocked. It is an eval trust "
     "anchor; regenerate it via the eval-compile path / a reviewed PR."),
    (re.compile(r"evals/baselines/", re.I),
     "Editing eval baselines is blocked. They are trust anchors; regenerate them via "
     "the eval-compile path / a reviewed PR."),
]


def path_denied(file_path: str) -> bool:
    """True when a raw Edit/Write to ``file_path`` is blocked by :data:`PATH_DENY`."""
    return any(pat.search(file_path) for pat, _ in PATH_DENY)


# FR-6.2: a narrow subset of the PATH_DENY trust anchors, scanned across ANY field
# of an UNRECOGNIZED event payload. Kept deliberately narrower than the full
# PATH_DENY eval-anchor set — this is a backstop for novel event shapes, not a
# second write-gate. Matched case-insensitively against `/`-normalized values.
_PROTECTED_PAYLOAD_SUBSTR = (".claude/hooks/", ".abstract-data/", ".claude/settings")


def _protected_path_in_payload(payload: object, _depth: int = 0) -> str | None:
    """First string value anywhere in ``payload`` referencing a protected path, else None.

    FR-6.2: for events ``_extract_tool`` does NOT recognize (``kind == ""``), a novel
    event name could carry a protected-path operation under an arbitrary field name and
    slip past ``PATH_DENY`` (which only sees the ``file_path``/``command`` keys). This
    recursively walks every string value (bounded depth) and returns the first one that
    contains a protected fragment (``.claude/hooks/``, ``.abstract-data/``,
    ``.claude/settings``). Deny-ONLY — never consulted for ASK. Fails OPEN (returns
    ``None``) on any error, so a scan bug can never brick a session.
    """
    try:
        if _depth > 6:
            return None
        if isinstance(payload, str):
            low = payload.replace("\\", "/").lower()
            return payload if any(frag in low for frag in _PROTECTED_PAYLOAD_SUBSTR) else None
        if isinstance(payload, dict):
            for value in payload.values():
                hit = _protected_path_in_payload(value, _depth + 1)
                if hit is not None:
                    return hit
            return None
        if isinstance(payload, (list, tuple)):
            for value in payload:
                hit = _protected_path_in_payload(value, _depth + 1)
                if hit is not None:
                    return hit
            return None
        return None
    except Exception:
        return None


def _bash_match(cmd: str) -> tuple[str, str] | None:
    """First matching bash rule as ``(decision, message)``, else ``None``.

    DENY rules win over ASK; within a tier the first pattern wins.
    """
    for pat, msg in BASH_DENY:
        if pat.search(cmd):
            return "deny", msg
    for pat, msg in BASH_ASK:
        if pat.search(cmd):
            return "ask", msg
    return None


def bash_decision(cmd: str) -> str:
    """Pure decision seam for a shell command: ``"deny" | "ask" | "allow"``."""
    match = _bash_match(cmd)
    return match[0] if match else "allow"

# Edit/Write ASK by path: meaning-changing files.
PATH_ASK = [
    (re.compile(r"\.github/workflows/"),
     "CI workflow edit — confirm. CI changes alter what 'passing' means."),
    (re.compile(r"production.*loader|loader.*production", re.I),
     "Production loader edit — confirm. This changes production behavior."),
    (re.compile(r"(^|/)(pyproject\.toml|requirements[^/]*\.txt|uv\.lock|"
                r"package\.json|package-lock\.json|bun\.lock(b)?|pnpm-lock\.yaml)$"),
     "Dependency / lockfile change — confirm. New or changed dependencies."),
    (re.compile(r"(alembic|migrations)/versions/"),
     "Database migration file — confirm."),
    (re.compile(r"(^|/)(Dockerfile|railway\.(json|toml)|vercel\.json|.*\.tf)$"),
     "Infrastructure / deploy config edit — confirm."),
    # FR-6.6: editing an enforcement hook SOURCE (not a deployed .claude/hooks/ copy,
    # which PATH_DENY blocks outright) escalates to a human. These scripts deploy into
    # every project; the enforcement set changes via a reviewed PR. Harmless in target
    # projects, where this source path does not exist.
    (re.compile(r"src/abstract_data/project_tools/hooks/"),
     "Edit to an enforcement hook SOURCE — confirm. These deploy into every project; "
     "change the enforcement set via a reviewed PR (FR-6.6)."),
]


# --------------------------------------------------------------------------- #
# Shift-left content secret scan (#337 FR-7 — adopted from the machine-global gate)
# --------------------------------------------------------------------------- #
# PATH_DENY/PATH_ASK judge WHERE a write lands; this judges WHAT it contains. It was
# the one PreToolUse capability the vendored gate lacked outright (zero occurrences of
# CONTENT_SECRET_*), and it is adopted rather than left global-only for one reason: it
# has no machine-specific dependency, so it is correct in every project this bundle
# deploys into, and FR-6 retires duplicate PreToolUse registrations — the copy that
# survives in a given project has to be the one that catches a live key.
#
# Tiering is deliberate. DENY only the shapes that are self-identifying credentials
# (a key header, a provider-prefixed token); ASK the assignment shapes, which are
# ambiguous by construction. Neither tier fires inside the placeholder vocabulary real
# code is full of (`op://`, `${VAR}`, `<TOKEN>`, "example"), and a hit in a test or docs
# path is DOWNGRADED to ask, because fixtures are where fake credentials legitimately
# live and a deny there would be unclearable by any command the gate could print.
CONTENT_SECRET_DENY = [
    (re.compile(r"-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----"),
     "Private key material in the written content."),
    (re.compile(r"(?i)(AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}"),
     "AWS access key ID in the written content."),
    (re.compile(r"(?i)ghp_[A-Za-z0-9]{36}"), "GitHub PAT in the written content."),
    (re.compile(r"(?i)xoxb-[A-Za-z0-9-]+"), "Slack bot token in the written content."),
    (re.compile(r"(?i)AIza[A-Za-z0-9\-_]{35}"), "Google API key in the written content."),
    (re.compile(r"(?i)sk-ant-api[A-Za-z0-9\-_]{32,}"),
     "Anthropic API key in the written content."),
    (re.compile(r"(?i)sk-[A-Za-z0-9]{48,}"), "OpenAI API key in the written content."),
    (re.compile(r"(?i)sk_live_[A-Za-z0-9]{24,}"), "Stripe live key in the written content."),
]

CONTENT_SECRET_ASK = [
    (re.compile(r"""(?i)(api_key|apikey|api_secret)\s*=\s*['"][^'"\s]{8,}['"]"""),
     "Possible API key literal — confirm it is not a real credential."),
    (re.compile(r"""(?i)password\s*=\s*['"][^'"\s]{4,}['"]"""),
     "Possible hardcoded password — confirm it is not a real credential."),
    (re.compile(r"""(?i)secret\s*=\s*['"][^'"\s]{8,}['"]"""),
     "Possible secret literal — confirm it is not a real credential."),
]

# Placeholder vocabulary: if any of these appears NEAR a hit, the hit is a template,
# a doc example, or a 1Password reference — not a credential.
CONTENT_EXEMPT = [
    re.compile(r"op://"),
    re.compile(r"\$\{[A-Z_][A-Z0-9_]*\}"),
    re.compile(r"""env\(['"][A-Z_][A-Z0-9_]*['"]\)"""),
    re.compile(r"<[A-Z_][A-Z0-9_]*>"),
    re.compile(r"your[_-]?(api[_-]?key|secret|token)", re.I),
    re.compile(r"example|placeholder|dummy|fake|test|mock", re.I),
]

# Paths where a credential-shaped string is expected to be fake: deny -> ask.
CONTENT_DOWNGRADE_RE = re.compile(r"(tests?/|spec/|fixtures?/|__tests__/|\.md$|docs?/)", re.I)

# How far either side of a hit the exemption vocabulary is looked for. Wide enough to
# catch `# example key:` on the line above, narrow enough that the word "test" halfway
# down a 2000-line file does not exempt a real key.
CONTENT_EXEMPT_WINDOW = 80


def _is_exempt(start: int, end: int, content: str) -> bool:
    """True when the neighbourhood of a hit reads as a placeholder rather than a secret.

    Signature note: the machine-global gate passes the matched text as a first argument
    and never uses it. Dropped here rather than carried, so nothing suggests the match
    text participates in the decision — only its NEIGHBOURHOOD does.
    """
    ctx = content[max(0, start - CONTENT_EXEMPT_WINDOW) : end + CONTENT_EXEMPT_WINDOW]
    return any(pat.search(ctx) for pat in CONTENT_EXEMPT)


def scan_content_for_secrets(content: str, file_path: str) -> tuple[str, str] | None:
    """``('deny'|'ask', message)`` for the first non-exempt credential shape, else ``None``.

    Pure decision seam, like :func:`bash_decision` and :func:`path_denied` — the caller
    does the emitting, so the rule set is unit-testable without stdin or process exit.
    """
    low_risk = bool(CONTENT_DOWNGRADE_RE.search(file_path or ""))
    for pat, msg in CONTENT_SECRET_DENY:
        m = pat.search(content)
        if m and not _is_exempt(m.start(), m.end(), content):
            note = " (test/docs path — downgraded to confirm)" if low_risk else ""
            return ("ask" if low_risk else "deny", f"[shift-left] {msg}{note}")
    for pat, msg in CONTENT_SECRET_ASK:
        m = pat.search(content)
        if m and not _is_exempt(m.start(), m.end(), content):
            return ("ask", f"[shift-left] {msg}")
    return None


# Cursor read events: permission-capable but default-allow (the gate guards writes,
# never reads). Named once so _extract_tool's classification and cmd_pretool's
# FR-6.2 payload scan agree on which events are reads to be left alone.
_CURSOR_READ_EVENTS = ("beforeReadFile", "beforeTabFileRead")


def _extract_tool(payload: dict) -> tuple[str, str, str]:
    """Return (kind, command, file_path) across Claude, Cursor, and Grok payload shapes.

    kind is 'bash', 'edit', or '' (nothing actionable).
    """
    p = payload or {}
    tool = p.get("tool_name") or p.get("toolName") or ""
    ti = p.get("tool_input") or p.get("toolInput") or {}
    if not isinstance(ti, dict):
        ti = {}

    # Claude shapes (+ Grok native tool names aliased from Claude matchers).
    if tool in ("Bash", "run_terminal_command"):
        return "bash", (ti.get("command") or ""), ""
    if tool in ("Edit", "Write", "MultiEdit", "search_replace", "write"):
        return "edit", "", (ti.get("file_path") or ti.get("path") or "")

    # Cursor shapes (granular events put fields at the top level).
    ev = p.get("hook_event_name") or p.get("hookEventName") or ""
    command = p.get("command") or ti.get("command") or ""
    if ev in ("beforeShellExecution", "afterShellExecution") or (
        command and not tool and not p.get("toolName")
    ):
        return "bash", command, ""
    # Read events (beforeReadFile / beforeTabFileRead) carry a file_path but are NOT
    # writes — the gate guards edits only. Routing a read through the edit path would
    # run PATH_DENY against it and DENY Cursor reads of .claude/hooks/, .abstract-data/,
    # and settings as if they were writes. Short-circuit to nothing-actionable (allow)
    # BEFORE the file_path fallback. Only afterFileEdit is a Cursor file WRITE.
    if ev in _CURSOR_READ_EVENTS:
        return "", "", ""
    file_path = p.get("file_path") or ti.get("file_path") or ti.get("path") or ""
    if ev == "afterFileEdit" or file_path:
        return "edit", "", file_path
    return "", "", ""


# Field names carrying the NEW text of a write, across the harnesses `_extract_tool`
# already normalises: Claude `Write.content` / `Edit.new_string`, Cursor `afterFileEdit`
# edit entries, Grok `write`/`search_replace`. The machine-global gate reads three Claude
# keys only; widening the set here is what makes the ported scan fire under Cursor and
# Grok instead of silently passing.
_CONTENT_KEYS = ("content", "new_content", "new_string", "new_str", "newText", "text")

# Bound on how many entries of an `edits` array are inspected — a malformed payload must
# not turn the pretool gate into an unbounded loop.
_MAX_EDIT_ENTRIES = 100


def _edit_content(payload: dict) -> str:
    """Best-effort NEW file text an edit/write event would put on disk, else ``""``.

    Returns the candidate strings joined, because the scan only needs *some* text
    containing the credential, not a faithful reconstruction of the file. Fails OPEN
    (empty string) on any error: a scan that cannot read the payload must allow, never
    block — the same posture as :func:`_protected_path_in_payload`.
    """
    try:
        p = payload or {}
        ti = p.get("tool_input") or p.get("toolInput") or {}
        if not isinstance(ti, dict):
            ti = {}
        chunks: list[str] = []

        def collect(src: dict) -> None:
            for key in _CONTENT_KEYS:
                val = src.get(key)
                if isinstance(val, str) and val:
                    chunks.append(val)

        for src in (ti, p):
            collect(src)
            edits = src.get("edits")
            if isinstance(edits, list):
                for entry in edits[:_MAX_EDIT_ENTRIES]:
                    if isinstance(entry, dict):
                        collect(entry)
        return "\n".join(chunks)
    except Exception:
        return ""


def cmd_pretool() -> None:
    payload = read_payload()
    harness = _harness(payload)
    try:
        # Persist the live session id so the CLI record path agrees with the Stop gate.
        resolve_session(project_dir(payload), payload, persist=True)

        kind, command, file_path = _extract_tool(payload)

        if kind == "bash":
            match = _bash_match(command)
            if match:
                emit_pretool(match[0], match[1], harness)
            emit_allow()

        if kind == "edit":
            for pat, msg in PATH_DENY:
                if pat.search(file_path):
                    emit_pretool("deny", msg, harness)
            # WHAT it contains (#337 FR-7): content deny runs before PATH_ASK so a
            # live credential is never softened into a path-only confirmation.
            content = _edit_content(payload)
            content_verdict = (
                scan_content_for_secrets(content, file_path) if content else None
            )
            if content_verdict and content_verdict[0] == "deny":
                emit_pretool(content_verdict[0], content_verdict[1], harness)
            for pat, msg in PATH_ASK:
                if pat.search(file_path):
                    emit_pretool("ask", msg, harness)
            if content_verdict and content_verdict[0] == "ask":
                emit_pretool(content_verdict[0], content_verdict[1], harness)
            emit_allow()

        # FR-6.2: unrecognized event (kind == ""). _extract_tool only inspects the
        # known file_path/command keys, so a NOVEL event carrying a protected path
        # under any other field name would fall through to allow. Scan the whole
        # payload and DENY a protected-path reference. The enumerated Cursor read
        # events also classify as "" — they are EXCLUDED here (reads default-allow,
        # per the Cursor contract), so the scan fires only for genuinely novel events.
        event_name = (payload or {}).get("hook_event_name", "")
        hit = None if event_name in _CURSOR_READ_EVENTS else _protected_path_in_payload(payload)
        if hit:
            emit_pretool(
                "deny",
                "Unrecognized event references a protected trust-anchor path "
                f"({hit!r}). Protected-path operations must go through a reviewed PR.",
                harness,
            )
        emit_allow()

    except SystemExit:
        raise
    except Exception as exc:  # fail OPEN; a pretool bug must not block all work
        sys.stderr.write(f"[gate] internal error in pretool, allowing: {exc}\n")
        emit_allow()


# --------------------------------------------------------------------------- #
# 3. Disposition ledger CLI (called by verify-completion.sh, scripts, or agent)
# --------------------------------------------------------------------------- #
def _arg(flag: str, default: str | None = None) -> str | None:
    a = sys.argv
    return a[a.index(flag) + 1] if flag in a and a.index(flag) + 1 < len(a) else default


def _session_ledger() -> tuple[Path, dict]:
    proj = project_dir()
    session = resolve_session(proj, None)
    lpath = ledger_path(proj, session)
    return lpath, load_ledger(lpath)


def cmd_record_failure() -> None:
    """gate.py record-failure --check NAME [--status failed|skipped] [--detail ...]"""
    name = _arg("--check")
    if not name:
        sys.exit("record-failure: --check NAME is required")
    lpath, ledger = _session_ledger()
    ledger.setdefault("checks", {})[name] = {
        "status": _arg("--status", "failed"),
        "detail": _arg("--detail", ""),
        "disposition": None,
        "at": int(time.time()),
    }
    save_ledger(lpath, ledger)
    print(f"recorded {ledger['checks'][name]['status']} check: {name}")


def cmd_dispose() -> None:
    """gate.py dispose --check NAME --status fixed|deferred|ticket|ignore --note ..."""
    name = _arg("--check")
    status = _arg("--status")
    if not name or status not in ("fixed", "deferred", "ticket", "ignore"):
        sys.exit("dispose: --check NAME and --status fixed|deferred|ticket|ignore required")
    lpath, ledger = _session_ledger()
    rec: dict[str, object] | None = ledger.setdefault("checks", {}).get(name)
    if not rec:
        # allow disposing a check that wasn't formally recorded as failing
        rec = {"status": "failed", "detail": "(no prior record)", "at": int(time.time())}
        ledger["checks"][name] = rec
    rec["disposition"] = {"status": status, "note": _arg("--note", ""), "at": int(time.time())}
    save_ledger(lpath, ledger)
    print(f"disposition recorded for '{name}': {status}")


def cmd_clear_record_errors() -> None:
    """gate.py clear-record-errors — clear the #341 recorder-failure marker.

    Deliberately a *named* command rather than an auto-expiring flag: the Stop item it
    clears must be clearable by the command the gate prints, or it is an unsatisfiable gate.
    """
    proj = project_dir()
    path = record_errors_path(proj)
    errors = read_record_errors(proj)
    if not errors:
        print("no recorder failures were marked")
        return
    try:
        path.unlink()
    except OSError as exc:
        sys.exit(f"clear-record-errors: could not remove {path}: {exc}")
    print(f"cleared {len(errors)} marked recorder failure(s)")


def cmd_task_critic_receipt() -> None:
    """gate.py task-critic-receipt --verdict PASS|BLOCK --requirements-file PATH [--note ...]

    #337 FR-7: the only way to record a verdict. ``--requirements-file`` is required and
    must exist, so the recorded hash cannot be produced without actually reading the
    requirements — which is the whole difference between a receipt and a claim.
    """
    verdict = _arg("--verdict")
    if verdict not in ("PASS", "BLOCK"):
        sys.exit("task-critic-receipt: --verdict PASS|BLOCK required")
    req_file = _arg("--requirements-file")
    if not req_file:
        sys.exit(
            "task-critic-receipt: --requirements-file PATH is required (normally TASK.md). "
            "A verdict with no requirements hash is self-certification, not a receipt."
        )
    req_path = Path(req_file)
    if not req_path.is_file():
        sys.exit(f"task-critic-receipt: requirements file not found: {req_path}")
    req_hash = sha256_file(req_path)
    lpath, ledger = _session_ledger()
    ledger["task_critic"] = {
        "verdict": verdict,
        "requirements_file": str(req_path),
        "requirements_hash": req_hash,
        "note": _arg("--note", ""),
        "at": int(time.time()),
    }
    save_ledger(lpath, ledger)
    print(f"task-critic receipt recorded: {verdict} (hash: {req_hash[:12]}...)")


def cmd_task_critic() -> None:
    """RETIRED (#337 FR-7). Kept in dispatch only so it fails LOUDLY, never silently.

    The bare form wrote no ``requirements_hash``, and the staleness comparison skipped a
    falsy hash — so `--verdict PASS` alone closed the Stop gate without the task-critic
    subagent ever being dispatched. Deleting the subcommand outright would have made the
    old command print a generic usage blob; naming the replacement is what keeps the gate
    satisfiable. This mirrors the machine-global gate's v1.3.1 removal.
    """
    sys.exit(
        "gate.py task-critic (bare) was retired — it bypassed the receipt-bound "
        "protection by recording a verdict with no requirements hash. Dispatch the "
        "task-critic subagent, then record its real verdict:\n"
        "  python .claude/hooks/gate.py task-critic-receipt --verdict PASS|BLOCK "
        "--requirements-file TASK.md --note '...'"
    )


def _fmt_mtime(ts: float) -> str:
    """Local timestamp plus a coarse relative age. Stdlib ``time`` only."""
    if not ts:
        return "unknown"
    stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts))
    delta = max(0, int(time.time() - ts))
    if delta < 3600:
        age = f"{delta // 60}m ago"
    elif delta < 86400:
        age = f"{delta // 3600}h ago"
    else:
        age = f"{delta // 86400}d ago"
    return f"{stamp} ({age})"


def _scan_ledgers(proj: Path, current_session: str) -> list[dict]:
    """Every ``.claude/state/gate-*.json``, with session id, mtime and open-item count.

    Read-only twin of the FR-7 prune walk (``_prune_aged_ledgers``): same directory,
    same ``gate-*.json`` glob, same single ``os.scandir`` pass — it just reports
    instead of deleting. Open items come from ``open_items`` (the one implementation
    the Stop gate uses), so the count shown is the count that would block.

    Purely diagnostic, so it NEVER raises: an unreadable or malformed ledger comes
    back as ``readable=False`` / ``open=None`` and the walk continues.
    """
    rows: list[dict] = []
    sdir = proj / ".claude" / "state"
    current_name = ledger_path(proj, current_session).name
    require_tc = (proj / "TASK.md").exists()
    try:
        entries = list(os.scandir(sdir))
    except Exception:
        return rows
    for entry in entries:
        name = entry.name
        if not (name.startswith("gate-") and name.endswith(".json")):
            continue
        row: dict = {
            "file": name,
            "session": name[len("gate-") : -len(".json")],
            "current": name == current_name,
            "mtime": 0.0,
            "open": None,
            "readable": False,
            "parsed": False,
            "items": [],
        }
        try:
            row["mtime"] = entry.stat().st_mtime
        except Exception:
            pass
        try:
            data = json.loads(Path(entry.path).read_text())
            if not isinstance(data, dict):
                raise ValueError("ledger is not a JSON object")
            row["parsed"] = True
        except Exception:
            rows.append(row)
            continue  # not JSON at all — reported as unreadable, never fatal
        try:
            items = open_items(data, require_task_critic=require_tc, proj=proj)
            row["items"] = items
            row["open"] = len(items)
            row["readable"] = True
        except Exception:
            # Valid JSON whose SHAPE open_items cannot walk (e.g. `checks` holding a
            # string). Saying "unreadable" here sends the reader hunting for a corrupt
            # file that reads fine — name the real problem instead.
            pass
        rows.append(row)
    rows.sort(key=lambda r: (-float(r["mtime"]), str(r["file"])))
    return rows


def _cross_agent_issues(proj: Path) -> tuple[Path, str, list]:
    """``.claude/cross-agent-issues.json`` contents: ('absent'|'ok'|'unreadable', items).

    Worker subagents escalate here instead of recording a per-worker task-critic verdict
    (:func:`escalate_to_mirror`, FR-8). Per FR-A(d) the mirror is **not** an independent
    source of open items in this binary — nothing in ``evaluate_stop`` reads it — so what
    it holds is a handoff record for the human and for ``status --all``, cleared by
    ``cross-agent-clear --all``. Anything that later re-raises it at Stop must filter to
    entries carrying ``disposition == "pending-escalation"``.
    """
    path = proj / ".claude" / CROSS_AGENT_ISSUES
    try:
        if not path.is_file():
            return path, "absent", []
        data = json.loads(path.read_text())
    except Exception:
        return path, "unreadable", []
    if isinstance(data, list):
        return path, "ok", data
    if isinstance(data, dict):
        items = data.get("items")
        if isinstance(items, list):
            return path, "ok", items
    return path, "unreadable", []


def _item_head(item: object, width: int = 120) -> str:
    """First line of an open item, truncated — enough to spot duplicates at a glance."""
    text = str(item).strip().splitlines()[0] if str(item).strip() else str(item)
    return text if len(text) <= width else text[: width - 1] + "…"


def cmd_status_all() -> None:
    """gate.py status --all — inspect EVERY ledger, not just this session's.

    Answers "which ledger did that Stop event actually read?" without hand-grepping
    mtimes across ``.claude/state/``. Diagnostic only: it writes nothing and swallows
    every per-file error.
    """
    proj = project_dir()
    session = resolve_session(proj, None)
    rows = _scan_ledgers(proj, session)

    print(f"gate v{VERSION} — all ledgers under {proj / '.claude' / 'state'}")
    current_file = ledger_path(proj, session).name
    suffix = "" if any(r["current"] for r in rows) else " — no ledger file on disk"
    print(f"current session: {session} ({current_file}){suffix}")
    print("")

    if not rows:
        print("  (no gate-*.json ledgers)")
    else:
        fwidth = max(len(str(r["file"])) for r in rows)
        swidth = max(len(str(r["session"])) for r in rows)
        for r in rows:
            count = "?" if r["open"] is None else str(r["open"])
            line = (
                f"  {str(r['file']).ljust(fwidth)}  "
                f"session={str(r['session']).ljust(swidth)}  "
                f"mtime={_fmt_mtime(float(r['mtime']))}  "
                f"open={count}"
            )
            if not r["readable"]:
                line += "  (unexpected shape)" if r["parsed"] else "  (unreadable)"
            if r["current"]:
                line += "  <- CURRENT"
            print(line)

    total_open = sum(int(r["open"]) for r in rows if r["open"])
    unreadable = sum(1 for r in rows if not r["readable"] and not r["parsed"])
    malformed = sum(1 for r in rows if not r["readable"] and r["parsed"])
    print("")
    tail = f"  |  unexpected shape: {malformed}" if malformed else ""
    print(f"ledgers: {len(rows)}  |  open items: {total_open}  |  unreadable: {unreadable}{tail}")

    # Duplicate open items across ledgers are the signal that a multi-agent run
    # escalated the same blocker N times — collapse them into one counted list.
    heads: dict[str, int] = {}
    for r in rows:
        for it in r["items"]:
            head = _item_head(it)
            heads[head] = heads.get(head, 0) + 1
    if heads:
        print("")
        print(f"distinct open items ({len(heads)}):")
        for head, n in sorted(heads.items(), key=lambda kv: (-kv[1], kv[0])):
            print(f"  [{n}x] {head}")

    cpath, cstatus, citems = _cross_agent_issues(proj)
    print("")
    if cstatus == "absent":
        print(f"cross-agent issues: none ({cpath} absent)")
    elif cstatus == "unreadable":
        print(f"cross-agent issues: unreadable ({cpath})")
    else:
        print(f"cross-agent issues: {len(citems)} ({cpath})")
        # Same collapsing as the ledger list above: a multi-agent run escalates the
        # SAME blocker once per worker, so printing every entry raw reproduces exactly
        # the duplicate wall this inspector exists to cut down.
        seen: dict[str, int] = {}
        for entry in citems:
            if isinstance(entry, dict):
                sid = str(entry.get("session_id") or "?")
                line = f"[{sid}] {_item_head(entry.get('item', entry))}"
            else:
                line = _item_head(entry)
            seen[line] = seen.get(line, 0) + 1
        for line, n in sorted(seen.items(), key=lambda kv: (-kv[1], kv[0])):
            print(f"  - {line}" if n == 1 else f"  - [{n}x] {line}")


def cmd_status() -> None:
    # `status --all` is a superset inspector; bare `status` is unchanged.
    if "--all" in sys.argv:
        try:
            cmd_status_all()
        except Exception as exc:  # a diagnostic must never blow up in the user's face
            print(f"gate v{VERSION} — status --all failed: {exc}", file=sys.stderr)
        return
    lpath, ledger = _session_ledger()
    proj = project_dir()
    require_tc = (proj / "TASK.md").exists()
    items = open_items(ledger, require_task_critic=require_tc, proj=proj)
    print(f"gate v{VERSION} — ledger: {lpath}")
    print(f"task_critic: {ledger.get('task_critic')}")
    print(f"checks: {json.dumps(ledger.get('checks', {}), indent=2)}")
    print(f"open items: {len(items)}")
    for it in items:
        print(f"  - {it}")


def cmd_cross_agent_clear() -> None:
    """gate.py cross-agent-clear --all — remove ``.claude/cross-agent-issues.json``.

    #337 FR-7 port, and the one the issue names as required. ``status --all`` already
    READS the escalation mirror (:func:`_cross_agent_issues`), so this binary could show
    a worker's escalation while carrying no command that removes it — and an item a
    reader can see but cannot clear is just a different broken gate (#343). It also had
    to exist BEFORE FR-8 gave this binary a mirror WRITER
    (:func:`escalate_to_mirror`) — otherwise subagent stops could fill a file with no
    command able to empty it again.

    ``--all`` is mandatory rather than defaulted because the file is shared: it holds
    entries from OTHER agents' sessions, and there is no per-entry key to clear one
    safely. Requiring the flag makes the blunt scope of the operation explicit at the
    call site instead of hiding it behind a bare verb.
    """
    proj = project_dir()
    path = proj / ".claude" / CROSS_AGENT_ISSUES
    if "--all" not in sys.argv:
        sys.exit(
            "cross-agent-clear: --all is required. This removes EVERY escalation in "
            f"{path}, including entries recorded by other agents' sessions."
        )
    _path, status, items = _cross_agent_issues(proj)
    if status == "absent":
        print(f"no cross-agent issues to clear ({path} absent)")
        return
    try:
        path.unlink()
    except OSError as exc:
        sys.exit(f"cross-agent-clear: could not remove {path}: {exc}")
    if status == "unreadable":
        # Unparseable is still cleared: it blocks a reader exactly as much as a valid
        # list would, and leaving it behind would be the unclearable state above.
        print(f"cleared unreadable cross-agent issue file {path}")
    else:
        print(f"cleared {len(items)} cross-agent issue(s) from {path}")


# --------------------------------------------------------------------------- #
# dispatch
# --------------------------------------------------------------------------- #
def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    dispatch = {
        "stop-check": cmd_stop_check,
        "pretool": cmd_pretool,
        "record-failure": cmd_record_failure,
        "dispose": cmd_dispose,
        "task-critic-receipt": cmd_task_critic_receipt,
        "task-critic": cmd_task_critic,  # retired (#337 FR-7) — exits non-zero with a redirect
        "clear-record-errors": cmd_clear_record_errors,
        "cross-agent-clear": cmd_cross_agent_clear,
        "status": cmd_status,
        "version": lambda: print(VERSION),
    }
    fn = dispatch.get(cmd)
    if not fn:
        sys.exit(
            f"gate.py v{VERSION}\nusage: gate.py "
            "{stop-check|pretool|record-failure|dispose|task-critic-receipt|"
            "clear-record-errors|cross-agent-clear --all|status [--all]|version}"
        )
    fn()


if __name__ == "__main__":
    main()
