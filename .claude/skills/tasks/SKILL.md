---
name: tasks
description: >
  Post-plan task decomposition skill. Takes an approved Notion plan and breaks
  each Step into atomic, machine-verifiable tasks. Writes TASK.md that the
  verify-completion.sh Stop hook checks automatically. Run after the Notion plan
  is approved, before beginning implementation.
trigger: >
  Run after a Notion plan is approved and before writing any code.
  Triggers: "/tasks", "decompose the plan", "break this into tasks",
  "write TASK.md", "create task list". Always run /tasks BEFORE implementing.
status: Stable
scope: Project-specific
---
<!-- Version: 1.0.0 | Last Updated: 2026-08-22 -->

# tasks

You are decomposing an approved Notion plan into atomic, machine-verifiable
tasks. Each task must be completable independently, have a clear verification
command, and map to exactly one piece of the plan.

## Step 1 — Read the approved plan

Call `abstract_data_read_plan_feedback` with the `page_id` of the approved plan.

Verify:
- `content_hash` matches the hash stored from create_plan or /specify.
  If it differs, stop: "Plan body has changed since approval. Re-read the plan
  before decomposing."
- Status should be `Approved`. If it is not, stop: "Plan is not yet approved.
  Ask the user to approve the plan in Notion before running /tasks."

Read each Step in the plan body.

## Step 2 — Decompose each Step into atomic tasks

For each numbered Step in the plan:
1. Break it into 1–5 atomic sub-tasks.
2. An atomic task is: one action verb + one object + one verification.
3. Every task must have a bash verification command that exits 0 on success.
4. Classify each task as LOW / MEDIUM / HIGH risk (per AGENTS.md definitions).

Atomic task examples:
- ✅ "Create `src/abstract_data/plan_tools.py` with five async functions"
  - Verify: `python -c "from abstract_data.plan_tools import create_plan; print('OK')"`
  - Risk: MEDIUM
- ✅ "Register tools in serve.py"
  - Verify: `grep -q "create_plan" src/abstract_data/serve.py`
  - Risk: MEDIUM
- ❌ "Implement the plan tools and wire them" — too broad, not atomic

## Step 3 — Write TASK.md

Write `TASK.md` at the project root. Format:

```markdown
# TASK.md — <plan title>
# Plan: <page_url>
# Decomposed: <timestamp>

## Phase 1 — <Step 1 title from plan>

- [ ] <Task description>
  - Verify: `<bash command that exits 0 on success>`
  - Risk: LOW | MEDIUM | HIGH

- [ ] <Task description>
  - Verify: `<bash command>`
  - Risk: LOW

## Phase 2 — <Step 2 title from plan>

- [ ] <Task description>
  - Verify: `<bash command>`
  - Risk: HIGH
```

Rules for TASK.md:
- Every task has exactly one `- [ ]` checkbox (verify-completion.sh counts these)
- Every task has exactly one `Verify:` line with a runnable bash command
- No task spans multiple phases
- Tasks are ordered: all LOW before MEDIUM before HIGH within a phase
- Estimated total: print the task count at the end

## Step 4 — Confirm

Tell the user:
> "TASK.md written: N tasks across M phases. Highest-risk tasks:
> [list HIGH risk tasks by name].
>
> Begin implementation by working through TASK.md top to bottom.
> Check off each task AFTER running its verification command successfully.
> The verify-completion.sh Stop hook will confirm all tasks are checked
> before the session ends."

Remind the user: LOW risk tasks can proceed autonomously. MEDIUM: show planned
diffs before applying. HIGH: ask clarifying questions, get explicit approval.

You may now begin implementing the first LOW risk task.

## Step 5 — Completion: the coordinator dispatches task-critic (multi-worker sessions)

When implementation is driven by **worker subagents** (subagent-driven-development or any
multitask/coordinator flow), the workers **intentionally skip task-critic**: `gate.py` uses
`require_tc = not is_subagent`, so `SubagentStop` emits `allow` and escalates to
`cross-agent-issues.json` rather than demanding a per-worker verdict. That means **no worker records
the task-critic verdict** — and the parent Stop gate still requires one when `TASK.md` exists.

Therefore the **parent coordinator MUST, after all workers complete and before declaring the session
done**, dispatch `task-critic` once against `TASK.md`, then record the verdict:

- Dispatch the `task-critic` subagent (it checks every `- [ ]` in `TASK.md` is truly implemented, not
  just that tests pass).
- Record it via the CLI, **passing `--session` explicitly** so the verdict lands in the ledger the
  Stop hook reads (in Cursor especially — see issues #12/#23; without `--session` the CLI can fall
  back to `gate-no-session.json` while the Stop hook reads `gate-<session-id>.json`):

  ```
  python3 .claude/hooks/gate.py task-critic --verdict PASS|BLOCK --session "$SESSION_ID" --note '<why>'
  ```

Never declare a multi-worker session done on a `BLOCK` verdict, and never let the workers' skipped
task-critic be mistaken for a recorded PASS.
