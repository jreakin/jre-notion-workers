#!/usr/bin/env python3
"""
gate.py — Abstract Data Dev-Env enforcement gate (v1.3.1)

PROVENANCE
  v1.0.0  core: loop-closer, dangerous-ops gate, disposition ledger
  v1.1.0  receipt-bound task-critic (SHA-256 hash of TASK.md); shift-left
          secret scan on Edit/Write content
  v1.2.0  SubagentStop event detection; cross-agent-issues.json escalation
          path; pending-escalation disposition; cross-agent-clear CLI;
          pending-escalation mirrored to cross-agent-issues.json
  v1.3.0  1Password env file declaration gate: undeclared writes to
          .env/.env.local/.env.1password/etc. are denied; a declared
          write (gate.py 1p-declare) is escalated to the human for
          approval; declarations expire after a 10-minute TTL
  v1.3.1  SECURITY FIX: removed the legacy bare `task-critic` command's
          self-certification bypass. It wrote requirements_hash=None,
          which open_items()'s staleness check silently skipped (None is
          falsy), letting the main agent satisfy the Stop gate without
          ever dispatching the task-critic subagent -- the exact failure
          the v1.1.0 receipt-binding was supposed to prevent. The command
          now hard-fails with a redirect to task-critic-receipt, which is
          the only path left and cannot be satisfied without a real
          SHA-256 read of the requirements file. Found 2026-07-04 via
          direct source review, not caught by the v1.1.0 design review.
          Dual-runtime (same version): accepts Grok camelCase hook payloads
          (toolName/toolInput/sessionId) and emits Grok decision/reason
          alongside Claude permissionDecision.

One file, five responsibilities, no third-party dependencies (stdlib only):

  1. Stop / SubagentStop loop-closer   -> gate.py stop-check
  2. Dangerous-ops PreToolUse gate     -> gate.py pretool
  3. Disposition ledger CLI            -> record-failure | dispose |
                                         task-critic-receipt | task-critic |
                                         status
  4. Cross-agent escalation CLI        -> cross-agent-clear
  5. 1Password declaration CLI         -> 1p-declare | 1p-clear
"""
from __future__ import annotations
import hashlib, json, os, re, sys, time
from pathlib import Path

VERSION = "1.3.1"
MAX_STOP_BLOCKS = 3

# Grok sends camelCase; Claude Code sends snake_case. Accept both so the same
# gate works from .claude/settings.json and .grok/hooks/enforcement.json.
_TOOL_ALIASES = {
    "run_terminal_command": "Bash",
    "search_replace": "Edit",
    "write": "Write",
    "exit_plan_mode": "ExitPlanMode",
}
_EVENT_ALIASES = {
    "pre_tool_use": "PreToolUse",
    "post_tool_use": "PostToolUse",
    "stop": "Stop",
    "subagent_stop": "SubagentStop",
    "subagent_end": "SubagentStop",
}
_KEY_ALIASES = (
    ("toolName", "tool_name"),
    ("toolInput", "tool_input"),
    ("toolResult", "tool_response"),
    ("sessionId", "session_id"),
    ("hookEventName", "hook_event_name"),
    ("stopHookActive", "stop_hook_active"),
)

def normalize_payload(payload):
    if not isinstance(payload, dict):
        return {}
    out = dict(payload)
    for src, dst in _KEY_ALIASES:
        if src in out and dst not in out:
            out[dst] = out[src]
    tool = out.get("tool_name") or ""
    if tool in _TOOL_ALIASES:
        out["tool_name"] = _TOOL_ALIASES[tool]
    event = out.get("hook_event_name") or ""
    if event in _EVENT_ALIASES:
        out["hook_event_name"] = _EVENT_ALIASES[event]
    ti = out.get("tool_input")
    if isinstance(ti, dict):
        ti = dict(ti)
        if not ti.get("file_path"):
            for key in ("target_file", "path"):
                if ti.get(key):
                    ti["file_path"] = ti[key]
                    break
        out["tool_input"] = ti
    if not out.get("session_id"):
        out["session_id"] = os.environ.get("GROK_SESSION_ID") or os.environ.get("CLAUDE_SESSION_ID") or "no-session"
    return out

def read_payload():
    try:
        raw = sys.stdin.read()
        data = json.loads(raw) if raw.strip() else {}
    except Exception:
        data = {}
    return normalize_payload(data)

def project_dir(payload=None):
    env = os.environ.get("CLAUDE_PROJECT_DIR")
    if env: return Path(env)
    if payload and payload.get("cwd"): return Path(payload["cwd"])
    return Path.cwd()

def state_dir(proj):
    d = proj / ".claude" / "state"; d.mkdir(parents=True, exist_ok=True); return d

def ledger_path(proj, session_id):
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", session_id or "no-session")
    return state_dir(proj) / f"gate-{safe}.json"

def load_ledger(path):
    if path.exists():
        try: return json.loads(path.read_text())
        except Exception: pass
    return {"session_id": path.stem, "task_critic": None, "checks": {}, "stop_blocks": 0}

def save_ledger(path, data): path.write_text(json.dumps(data, indent=2))
def sha256_file(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def emit_stop_block(reason): print(json.dumps({"decision": "block", "reason": reason})); sys.exit(0)
def emit_allow(): sys.exit(0)
def emit_pretool(decision, reason):
    # Claude Code reads permissionDecision; Grok reads decision/reason.
    grok_decision = "deny" if decision == "deny" else "allow"
    print(json.dumps({
        "decision": grok_decision,
        "reason": reason,
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": reason,
        },
    }))
    sys.exit(0)

# v1.1.0: receipt-bound task-critic
def open_items(ledger, require_task_critic, proj):
    items = []
    if require_task_critic:
        task_md = proj / "TASK.md"
        current_hash = sha256_file(task_md) if task_md.exists() else None
        tc = ledger.get("task_critic")
        if not tc:
            items.append("task-critic receipt missing. Run task-critic subagent, then: python .claude/hooks/gate.py task-critic-receipt --verdict PASS|BLOCK --requirements-file TASK.md")
        elif tc.get("verdict") != "PASS":
            items.append(f"task-critic verdict is {tc.get('verdict', 'unknown')} — resolve all blocking items, then re-run task-critic-receipt.")
        elif current_hash and tc.get("requirements_hash") and tc["requirements_hash"] != current_hash:
            items.append("task-critic receipt is stale — TASK.md changed since receipt was recorded. Re-run task-critic, then: python .claude/hooks/gate.py task-critic-receipt --verdict PASS|BLOCK --requirements-file TASK.md")
    for name, rec in ledger.get("checks", {}).items():
        if rec.get("status") in ("failed", "skipped") and not rec.get("disposition"):
            detail = rec.get("detail") or ""
            items.append(f"check '{name}' is {rec['status']} with no disposition" + (f" ({detail})" if detail else "") + f". Fix and re-run, or: python .claude/hooks/gate.py dispose --check '{name}' --status fixed|deferred|ticket|ignore|pending-escalation --note '...'")
    return items

# v1.2.0: stop-check
def cmd_stop_check():
    payload = read_payload()
    proj = project_dir(payload)
    session_id = payload.get("session_id", "no-session")
    try:
        lpath = ledger_path(proj, session_id)
        ledger = load_ledger(lpath)
        event = payload.get("hook_event_name", "Stop")
        is_subagent = event == "SubagentStop"
        require_tc = not is_subagent and (proj / "TASK.md").exists()
        items = open_items(ledger, require_task_critic=require_tc, proj=proj)
        cross_path = proj / ".claude" / "cross-agent-issues.json"
        if not is_subagent and cross_path.exists():
            try:
                cross = json.loads(cross_path.read_text())
                items.extend(f"[cross-agent] {c['item']}" for c in cross)
            except Exception: pass
        if not items:
            if ledger.get("stop_blocks"): ledger["stop_blocks"] = 0; save_ledger(lpath, ledger)
            emit_allow()
        if is_subagent:
            try: existing = json.loads(cross_path.read_text()) if cross_path.exists() else []
            except Exception: existing = []
            existing.extend({"item": i, "at": int(time.time()), "session_id": session_id} for i in items)
            cross_path.write_text(json.dumps(existing, indent=2))
            sys.stderr.write(f"[gate] SubagentStop: {len(items)} item(s) -> cross-agent-issues.json\n")
            emit_allow()
        ledger["stop_blocks"] = int(ledger.get("stop_blocks", 0)) + 1
        save_ledger(lpath, ledger)
        if ledger["stop_blocks"] > MAX_STOP_BLOCKS:
            sys.stderr.write("[gate] WARNING: released after " + str(ledger['stop_blocks']) + " blocks\n")
            emit_allow()
        emit_stop_block("Do not end the turn yet. Unresolved items (" + str(len(items)) + "):\n\n  - " + "\n  - ".join(items) + "\n\nResolve each, then stop.")
    except SystemExit: raise
    except Exception as exc: sys.stderr.write(f"[gate] internal error in stop-check, allowing: {exc}\n"); emit_allow()

# v1.1.0: shift-left secret scan
CONTENT_SECRET_DENY = [
    (re.compile(r"-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----"), "Private key material."),
    (re.compile(r"(?i)(AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}"), "AWS access key ID."),
    (re.compile(r"(?i)ghp_[A-Za-z0-9]{36}"), "GitHub PAT."),
    (re.compile(r"(?i)xoxb-[A-Za-z0-9-]+"), "Slack bot token."),
    (re.compile(r"(?i)AIza[A-Za-z0-9\-_]{35}"), "Google API key."),
    (re.compile(r"(?i)sk-ant-api[A-Za-z0-9\-_]{32,}"), "Anthropic API key."),
    (re.compile(r"(?i)sk-[A-Za-z0-9]{48,}"), "OpenAI API key."),
    (re.compile(r"(?i)sk_live_[A-Za-z0-9]{24,}"), "Stripe live key."),
]
CONTENT_SECRET_ASK = [
    (re.compile(r"""(?i)(api_key|apikey|api_secret)\s*=\s*['"][^'"\s]{8,}['"]"""), "Possible API key literal."),
    (re.compile(r"""(?i)password\s*=\s*['"][^'"\s]{4,}['"]"""), "Possible hardcoded password."),
    (re.compile(r"""(?i)secret\s*=\s*['"][^'"\s]{8,}['"]"""), "Possible secret literal."),
]
CONTENT_EXEMPT = [
    re.compile(r"op://"), re.compile(r"\$\{[A-Z_][A-Z0-9_]*\}"),
    re.compile(r"""env\(['"][A-Z_][A-Z0-9_]*['"]\)"""), re.compile(r"<[A-Z_][A-Z0-9_]*>"),
    re.compile(r"your[_-]?(api[_-]?key|secret|token)", re.I),
    re.compile(r"example|placeholder|dummy|fake|test|mock", re.I),
]
CONTENT_DOWNGRADE_RE = re.compile(r"(tests?/|spec/|fixtures?/|__tests__/|\.md$|docs?/)", re.I)

def _is_exempt(text, start, end, content):
    ctx = content[max(0, start-80):end+80]
    return any(ep.search(ctx) for ep in CONTENT_EXEMPT)

def scan_content_for_secrets(content, fp):
    low_risk = bool(CONTENT_DOWNGRADE_RE.search(fp))
    for pat, msg in CONTENT_SECRET_DENY:
        m = pat.search(content)
        if m and not _is_exempt(m.group(0), m.start(), m.end(), content):
            return ("ask" if low_risk else "deny", f"[shift-left] {msg}" + (" (test/docs — verify)" if low_risk else ""))
    for pat, msg in CONTENT_SECRET_ASK:
        m = pat.search(content)
        if m and not _is_exempt(m.group(0), m.start(), m.end(), content):
            return ("ask", f"[shift-left] {msg}")
    return None

# Dangerous-ops patterns
BASH_DENY = [(re.compile(r"\bgit\s+config\s+--global\b"), "Global git config blocked."), (re.compile(r"\bchmod\b.*\.claude/hooks/"), "Hook self-edit blocked.")]
BASH_ASK = [(re.compile(r"\bgit\s+push\b.*(--force|-f)\b"), "Force push — confirm."), (re.compile(r"\bgit\s+push\b.*\b(main|master|preview|prod|production|release)\b"), "Protected branch push — confirm."), (re.compile(r"\bgit\s+reset\s+--hard\b"), "Hard reset — confirm."), (re.compile(r"\bgit\s+clean\s+-[a-z]*f"), "git clean -f — confirm."), (re.compile(r"\balembic\s+(upgrade|downgrade)\b"), "Alembic run — confirm not cloud/prod."), (re.compile(r"\bsupabase\s+db\s+(push|reset)\b"), "Supabase remote schema op — confirm."), (re.compile(r"\bpsql\b.*-c\b.*\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER)\b", re.I), "Direct SQL write/DDL — confirm."), (re.compile(r"\bbut\b.*\b(config|reset|undo)\b"), "GitButler state op — confirm."), (re.compile(r"\brm\s+-rf\b"), "rm -rf — confirm path.")]
PATH_DENY = [(re.compile(r"\.claude/hooks/"), "Hook file edit blocked."), (re.compile(r"\.claude/settings(\.local)?\.json$"), "Hook settings edit blocked.")]
PATH_ASK = [(re.compile(r"\.github/workflows/"), "CI workflow edit — confirm."), (re.compile(r"production.*loader|loader.*production", re.I), "Prod loader edit — confirm."), (re.compile(r"(^|/)(pyproject\.toml|requirements[^/]*\.txt|uv\.lock|package\.json|package-lock\.json|bun\.lock(b)?|pnpm-lock\.yaml)$"), "Dep/lockfile change — confirm."), (re.compile(r"(alembic|migrations)/versions/"), "Migration file — confirm."), (re.compile(r"(^|/)(Dockerfile|railway\.(json|toml)|vercel\.json|.*\.tf)$"), "Infra/deploy config — confirm.")]

# v1.3.0: 1Password env file declaration gate
def _is_1p_env_file(fp: str) -> bool:
    name = Path(fp).name
    if not (name == ".env" or name.startswith(".env.")):
        return False
    EXCLUDE_SUFFIXES = ("example", "test", "sample", "template", "dist")
    suffix = name[len(".env."):] if "." in name[4:] else ""
    return suffix not in EXCLUDE_SUFFIXES

def cmd_pretool():
    payload = read_payload()
    try:
        tool = payload.get("tool_name", ""); ti = payload.get("tool_input", {}) or {}
        if tool == "Bash":
            command = ti.get("command", "") or ""
            for pat, msg in BASH_DENY:
                if pat.search(command): emit_pretool("deny", msg)
            for pat, msg in BASH_ASK:
                if pat.search(command): emit_pretool("ask", msg)
            emit_allow()
        if tool in ("Edit", "Write", "MultiEdit"):
            fp = ti.get("file_path", "") or ""
            for pat, msg in PATH_DENY:
                if pat.search(fp): emit_pretool("deny", msg)
            for pat, msg in PATH_ASK:
                if pat.search(fp): emit_pretool("ask", msg)
            if tool in ("Edit", "Write", "MultiEdit") and _is_1p_env_file(fp):
                proj = project_dir(payload)
                pending = state_dir(proj) / "1p-pending.json"
                if not pending.exists():
                    emit_pretool("deny",
                        "Before writing to a 1Password-managed file, declare what you are "
                        "changing and why:\n\n"
                        "  python .claude/hooks/gate.py 1p-declare \\\n"
                        "    --file '" + fp + "' \\\n"
                        "    --action 'add|edit|remove WHAT' \\\n"
                        "    --reason 'WHY'\n\n"
                        "Then proceed with your write. Call gate.py 1p-clear after."
                    )
                try:
                    d = json.loads(pending.read_text())
                    age = time.time() - d.get("declared_at", 0)
                    if age > 600:
                        emit_pretool("deny",
                            "The 1Password change declaration has expired (10-minute TTL). "
                            "Re-declare:\n\n  python .claude/hooks/gate.py 1p-declare ..."
                        )
                    action = d.get("action", "?")
                    reason = d.get("reason", "?")
                    emit_pretool("ask",
                        "\U0001f511 1Password environment file write\n\n"
                        f"File: {fp}\n\n"
                        f"Agent declared:\n"
                        f"  Action: {action}\n"
                        f"  Reason: {reason}\n\n"
                        f"Approve this write?"
                    )
                except SystemExit:
                    raise
                except Exception as exc:
                    emit_pretool("deny", f"1Password declaration malformed ({exc}). Re-declare.")
            content = ti.get("new_content") or ti.get("content") or ti.get("new_str") or ""
            if content:
                result = scan_content_for_secrets(content, fp)
                if result: emit_pretool(*result)
            emit_allow()
        emit_allow()
    except SystemExit: raise
    except Exception as exc: sys.stderr.write(f"[gate] pretool error, allowing: {exc}\n"); emit_allow()

def _arg(flag, default=None):
    a = sys.argv
    return a[a.index(flag)+1] if flag in a and a.index(flag)+1 < len(a) else default

def _session_ledger():
    proj = project_dir()
    session = os.environ.get("CLAUDE_SESSION_ID") or os.environ.get("GROK_SESSION_ID") or _arg("--session") or "no-session"
    lpath = ledger_path(proj, session)
    return lpath, load_ledger(lpath)

def cmd_record_failure():
    name = _arg("--check")
    if not name: sys.exit("record-failure: --check NAME required")
    lpath, ledger = _session_ledger()
    ledger.setdefault("checks", {})[name] = {"status": _arg("--status", "failed"), "detail": _arg("--detail", ""), "disposition": None, "at": int(time.time())}
    save_ledger(lpath, ledger); print(f"recorded {ledger['checks'][name]['status']} check: {name}")

def cmd_dispose():
    name = _arg("--check"); status = _arg("--status")
    if not name or status not in ("fixed", "deferred", "ticket", "ignore", "pending-escalation"):
        sys.exit("dispose: --check NAME and --status fixed|deferred|ticket|ignore|pending-escalation required")
    lpath, ledger = _session_ledger()
    rec = ledger.setdefault("checks", {}).get(name)
    if not rec: rec = {"status": "failed", "detail": "(no prior record)", "at": int(time.time())}; ledger["checks"][name] = rec
    rec["disposition"] = {"status": status, "note": _arg("--note", ""), "at": int(time.time())}
    save_ledger(lpath, ledger)
    if status == "pending-escalation":
        proj = project_dir(); cross_path = proj / ".claude" / "cross-agent-issues.json"
        try: existing = json.loads(cross_path.read_text()) if cross_path.exists() else []
        except Exception: existing = []
        existing.append({"item": f"{name}: {_arg('--note', '(no note)')}", "disposition": "pending-escalation", "at": int(time.time()), "session": os.environ.get("CLAUDE_SESSION_ID", "no-session")})
        cross_path.write_text(json.dumps(existing, indent=2))
        print(f"disposition recorded for '{name}': pending-escalation (mirrored to cross-agent-issues.json)")
    else: print(f"disposition recorded for '{name}': {status}")

def cmd_task_critic_receipt():
    verdict = _arg("--verdict"); req_file = _arg("--requirements-file")
    if verdict not in ("PASS", "BLOCK"): sys.exit("task-critic-receipt: --verdict PASS|BLOCK required")
    req_path = Path(req_file) if req_file else None
    req_hash = sha256_file(req_path) if (req_path and req_path.exists()) else None
    lpath, ledger = _session_ledger()
    ledger["task_critic"] = {"verdict": verdict, "requirements_file": str(req_path) if req_path else None, "requirements_hash": req_hash, "note": _arg("--note", ""), "at": int(time.time())}
    save_ledger(lpath, ledger)
    print(f"task-critic receipt recorded: {verdict} (hash: {req_hash[:12] if req_hash else 'n/a'}...)")

def cmd_task_critic():
    # REMOVED in v1.3.1: this legacy command let the main agent self-certify
    # by writing requirements_hash=None, which open_items()'s staleness check
    # (elif current_hash and tc.get("requirements_hash") and ...) silently
    # skips when requirements_hash is None -- a confirmed bypass of the
    # receipt-bound protection v1.1.0 was supposed to guarantee. There is no
    # safe legacy path; use task-critic-receipt, which hash-binds to the
    # requirements file and cannot be satisfied without actually reading it.
    sys.exit(
        "gate.py task-critic (bare) was removed in v1.3.1 -- it bypassed the "
        "receipt-bound protection. Dispatch the task-critic subagent and use:\n"
        "  python .claude/hooks/gate.py task-critic-receipt --verdict PASS|BLOCK "
        "--requirements-file TASK.md --note '...'"
    )

def cmd_status():
    lpath, ledger = _session_ledger(); proj = project_dir()
    require_tc = (proj / "TASK.md").exists()
    items = open_items(ledger, require_task_critic=require_tc, proj=proj)
    cross_path = proj / ".claude" / "cross-agent-issues.json"
    cross_items = []
    if cross_path.exists():
        try: cross_items = json.loads(cross_path.read_text())
        except Exception: pass
    print(f"gate v{VERSION} — ledger: {lpath}")
    print(f"task_critic: {json.dumps(ledger.get('task_critic'), indent=2)}")
    print(f"checks:\n{json.dumps(ledger.get('checks', {}), indent=2)}")
    print(f"open items: {len(items)}")
    for it in items: print(f"  - {it}")
    if cross_items:
        print(f"cross-agent-issues ({len(cross_items)}):")
        for c in cross_items: print(f"  - [{c.get('session_id','?')}] {c.get('item','?')}")

def cmd_1p_declare() -> None:
    file_arg = _arg("--file")
    action = _arg("--action")
    reason = _arg("--reason")
    if not file_arg or not action or not reason:
        sys.exit("1p-declare: --file FILE --action 'WHAT' --reason 'WHY' required")
    proj = project_dir()
    pending = state_dir(proj) / "1p-pending.json"
    pending.write_text(json.dumps({
        "file": file_arg, "action": action, "reason": reason,
        "declared_at": int(time.time())
    }, indent=2))
    print(f"1Password change declared for '{file_arg}': {action}")
    print(f"Reason: {reason}")
    print("TTL: 10 minutes. Proceed with your write, then: gate.py 1p-clear")

def cmd_1p_clear() -> None:
    proj = project_dir()
    pending = state_dir(proj) / "1p-pending.json"
    if pending.exists():
        pending.unlink()
        print("1Password change declaration cleared.")
    else:
        print("No pending 1Password change declaration found.")

def cmd_cross_agent_clear():
    proj = project_dir(); cross_path = proj / ".claude" / "cross-agent-issues.json"
    if "--all" in sys.argv:
        if cross_path.exists(): cross_path.unlink(); print("cross-agent-issues.json cleared")
        else: print("cross-agent-issues.json does not exist")
    else: sys.exit("cross-agent-clear: use --all")

def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    dispatch = {"stop-check": cmd_stop_check, "pretool": cmd_pretool, "record-failure": cmd_record_failure, "dispose": cmd_dispose, "task-critic-receipt": cmd_task_critic_receipt, "task-critic": cmd_task_critic, "status": cmd_status, "cross-agent-clear": cmd_cross_agent_clear, "1p-declare": cmd_1p_declare, "1p-clear": cmd_1p_clear, "version": lambda: print(VERSION)}
    fn = dispatch.get(cmd)
    if not fn: sys.exit(f"gate.py v{VERSION}\nusage: gate.py {{stop-check|pretool|record-failure|dispose|task-critic-receipt|task-critic|status|cross-agent-clear|1p-declare|1p-clear|version}}")
    fn()

if __name__ == "__main__":
    main()
