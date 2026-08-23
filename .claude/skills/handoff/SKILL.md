---
name: handoff
description: >
  Session boundary ritual. Run before ending any session where you wrote,
  edited, or created files. Generates HANDOFF.md capturing session state so
  the next session (or agent) can resume without context loss.
trigger: >
  Run at the end of any productive session — before saying you are done.
  Triggers: "end session", "wrapping up", "done for now", "/handoff",
  "create handoff", "update handoff". Always run when you see the
  check-handoff.sh warning in the Stop hook output.
status: Stable
scope: Project-specific
---
<!-- Version: 1.0.0 | Last Updated: 2026-08-22 -->

# handoff

Run this skill before ending any session where you modified files.

## Step 1 — Gather git state

```bash
git branch --show-current
git status --short
git log --oneline -5
git diff --stat HEAD
```

Collect: current branch, list of uncommitted files, last 5 commits,
stat summary of current diff.

## Step 2 — Read TASK.md (if present)

If `TASK.md` exists at the project root, read it. Identify:
- Items checked off this session (recently completed)
- Items still unchecked (in-flight or not started)

If no TASK.md: note "No TASK.md — tasks tracked via Notion plan or ad-hoc."

## Step 3 — Identify half-done patterns

Scan `git diff HEAD` for the Half-Done Pattern Catalog:
- Function or class defined but never imported or called
- Route or endpoint added to a router file but not registered in the app
- Migration file created but `migrate` command not run (check for Alembic/Prisma)
- Import added but the imported symbol never used
- Test file created but no test functions written
- TODO or FIXME comment added this session

List any matches found.

## Step 4 — Write HANDOFF.md

Write `HANDOFF.md` at the project root using the format from
`docs/HANDOFF-FORMAT.md` (or the standard format if that file is absent).

Be honest about In-Flight items — do not mark something Completed if
it has failing tests, uncommitted changes, or half-done patterns.

The Next Session section must have at minimum:
1. "Run /notion-read-confirm to reload Notion context."
2. One concrete next action tied to the In-Flight items.

## Step 5 — Confirm

Tell the user:
> "HANDOFF.md written. [N] items completed, [M] in-flight, [K] half-done
> patterns detected. Next session starts at: [first action from Next Session]."

If there are half-done patterns: flag them explicitly so the user can decide
whether to address them before ending or document them as known in-flight.
