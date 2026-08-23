---
description: Post-plan task decomposition. Takes an approved Notion plan page ID, decomposes it into atomic verifiable tasks, and writes TASK.md. Run after plan approval, before implementing.
---

Run the tasks skill from `.claude/skills/tasks/SKILL.md`.
Requires: plan_page_id from the approved Notion plan (from /specify output or the Notion URL).
Do not implement anything during this skill — only read the plan and write TASK.md.
