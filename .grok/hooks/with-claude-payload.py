#!/usr/bin/env python3
"""Normalize Grok hook stdin to Claude Code snake_case, then exec argv.

Grok sends camelCase keys (toolName, toolInput, sessionId, hookEventName).
Abstract Data hook scripts under .claude/hooks/ expect Claude snake_case.
This adapter is Grok-only; Claude Code still runs the scripts directly.

Usage:
  python3 .grok/hooks/with-claude-payload.py bash .claude/hooks/block-raw-git.sh
"""
from __future__ import annotations

import json
import os
import subprocess
import sys

TOOL_ALIASES = {
    "run_terminal_command": "Bash",
    "search_replace": "Edit",
    "write": "Write",
    "read_file": "Read",
    "list_dir": "Glob",
    "web_search": "WebSearch",
    "spawn_subagent": "Task",
    "exit_plan_mode": "ExitPlanMode",
}

EVENT_ALIASES = {
    "pre_tool_use": "PreToolUse",
    "post_tool_use": "PostToolUse",
    "post_tool_use_failure": "PostToolUseFailure",
    "stop": "Stop",
    "subagent_stop": "SubagentStop",
    "subagent_end": "SubagentStop",
    "session_start": "SessionStart",
    "session_end": "SessionEnd",
}

KEY_ALIASES = (
    ("toolName", "tool_name"),
    ("toolInput", "tool_input"),
    ("toolResult", "tool_response"),
    ("sessionId", "session_id"),
    ("hookEventName", "hook_event_name"),
    ("stopHookActive", "stop_hook_active"),
    ("lastAssistantMessage", "last_assistant_message"),
)


def normalize(payload: dict) -> dict:
    out = dict(payload)
    for src, dst in KEY_ALIASES:
        if src in out and dst not in out:
            out[dst] = out[src]
    tool = out.get("tool_name") or ""
    if tool in TOOL_ALIASES:
        out["tool_name"] = TOOL_ALIASES[tool]
    event = out.get("hook_event_name") or ""
    if event in EVENT_ALIASES:
        out["hook_event_name"] = EVENT_ALIASES[event]
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
        out["session_id"] = (
            os.environ.get("GROK_SESSION_ID")
            or os.environ.get("CLAUDE_SESSION_ID")
            or "no-session"
        )
    if not out.get("cwd"):
        out["cwd"] = out.get("workspaceRoot") or os.environ.get("GROK_WORKSPACE_ROOT") or os.getcwd()
    return out


def main() -> int:
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    normalized = json.dumps(normalize(payload)).encode()
    cmd = sys.argv[1:]
    if not cmd:
        sys.stdout.buffer.write(normalized)
        return 0
    proc = subprocess.run(cmd, input=normalized)
    return proc.returncode


if __name__ == "__main__":
    raise SystemExit(main())
