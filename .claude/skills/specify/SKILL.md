---
name: specify
description: >
  Pre-plan specification skill. Interviews the user to fully understand a
  feature or problem before writing a plan. Generates a durable spec under
  docs/specs/{slug}/, then calls abstract_data_create_plan using the spec
  fields. Run before any non-trivial implementation work. The output feeds
  directly into the Notion plan review loop.
trigger: >
  Run at the start of any new feature, bug fix, or refactor that would require
  a plan. Triggers: "let's spec this out", "start a new feature", "/specify",
  "write a spec", "before we plan this". Always run /specify BEFORE /plan if
  the work is non-trivial.
status: Stable
scope: Project-specific
---
<!-- Version: 1.0.0 | Last Updated: 2026-08-22 -->

# specify

You are acting as a senior architect conducting a requirements interview.
Your job is to understand the problem completely before writing anything.
Do not suggest solutions during the interview — only ask clarifying questions.

## Step 1 — Read existing context

Before asking any questions, read:
- `HANDOFF.md` (if present) — understand what session context exists
- `AGENTS.md` — understand the project's risk classification and constraints
- Any existing `docs/specs/<slug>/` for this area (and `docs/README.md` index)
- Any related Notion plan links the user mentions

Do **not** treat root `SPEC.md` as durable SoT (ADR-0060). If a legacy root
`SPEC.md` exists, migrate its content into `docs/specs/<slug>/spec.md` when
you write.

## Step 2 — Interview the user

Ask the following questions, one at a time. Wait for a real answer before moving on.
Do not bundle questions. Do not assume answers.

1. **What are you trying to accomplish?** (The outcome, not the implementation.)
2. **Why does this matter now?** (What is the cost of not doing this?)
3. **What does success look like?** (How will you know it's done and working?)
4. **What is explicitly out of scope?** (What should this NOT do?)
5. **What are the constraints?** (Time, dependencies, technical limits, things
   that must not change.)
6. **What are the risks?** (What could go wrong? What are you uncertain about?)
7. **Are there open questions that need resolution before you can start?**
   (Mark each blocking or non-blocking.)

If the user's answer to any question reveals ambiguity, ask one follow-up
before moving to the next question.

## Step 3 — Synthesize and present the spec draft

Once you have answers to all 7 questions, synthesize them into a spec draft
following the format in `docs/SPEC-TEMPLATE.md` (or the standard format
if that file is absent). Choose a kebab-case `{slug}` for the initiative.
Present the draft to the user.

Ask:
> "Does this capture what you're trying to do? Reply 'approved' to write
> `docs/specs/<slug>/spec.md` and create the Notion plan, or tell me what to change."

Revise and re-present until the user approves.

## Step 4 — Write the durable spec

Write the approved spec to `docs/specs/<slug>/spec.md` (create the directory).
Do **not** write durable specs to the project root as `SPEC.md`.
Update `docs/README.md` so this initiative appears in the active table if the
index exists (create a minimal index if plans/specs already exist elsewhere).

## Step 4.5 — Run the spec-eval panel

Before creating the plan, run the `spec-eval` skill against the written spec. It fans
out a four-lens adversarial panel and hard-gates the plan: a spec cannot become a plan
until the panel has run against that exact spec content and returned a non-BLOCK verdict.
If the panel returns REVISE or BLOCK, revise `docs/specs/<slug>/spec.md` and re-run the
panel before continuing.

## Step 5 — Create the Notion plan

Call `abstract_data_create_plan` using the spec fields:

```
title: <Problem headline, ≤ 60 chars>
source_agent: "Claude Code"  (or whichever agent you are)
goal: <Goals section, joined>
approach: <Approach section>
constraints: <Constraints as list>
risks: <Risks as list>
open_questions: <Open Questions as list>
verification: <Success Criteria, joined>
source_repo: <current git remote if available>
source_branch: <current branch>
```

Do NOT include Steps in create_plan — those are written by /tasks after
the plan is approved.

Store the returned `page_id`, `page_url`, `plan_body_hash`, `content_hash`.

## Step 6 — Hand off to review

Tell the user:
> "`docs/specs/<slug>/spec.md` written and plan created in Notion: <page_url>
>
> Review the plan, leave comments on any section, and flip Status to
> Approved when ready. Then run /tasks with the plan page ID to decompose
> it into executable tasks."

STOP. Do not write any code.
