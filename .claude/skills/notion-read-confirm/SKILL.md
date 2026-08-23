---
name: notion-read-confirm
description: >
  Mandatory session initializer. Reads every piece of Notion dev environment
  content deployed to this project and produces a per-item summary before any
  code is written. Required before first Edit/Write of any session. Run this
  if you see the NOTION READING CONFIRMATION REQUIRED block message.
trigger: >
  Required: ALWAYS run at the start of any new session in this project BEFORE
  writing, editing, or creating any file. Also run when you see the hook block
  message. Triggers: "confirm notion read", "session init", "notion preflight",
  "/notion-read-confirm".
status: Stable
scope: Project-specific
---
<!-- Version: 1.0.0 | Last Updated: 2026-08-22 -->

# notion-read-confirm

You must complete this skill fully before writing any files in this project.
Every step is required. Do not skip items. Do not summarize by category —
read and confirm each item individually.

## Step 0 — Locate the lockfile

Read `.abstract-data/lockfile.toml` in the project root. Extract every `[[items]]`
entry. Build a reading list from these fields per item:

- `name` — human label
- `type` — skill / prompt / agent / command / hook / template
- `target` — path of the deployed file on disk
- `notion_page_id` — the source Notion page

If the lockfile does not exist:
- Tell the user: "`.abstract-data/lockfile.toml` not found. Run `abstract-data apply`
  first to deploy Notion content to this project, then re-run this skill."
- Stop.

## Step 0.5 — Check cache staleness

Before building the reading list, check whether the deployed files reflect
the latest Notion content. Run:

```bash
abstract-data status --json 2>/dev/null
```

Parse the output and check `stale_items`:

- **`stale_items` is 0 or command unavailable** → proceed to Step 1. The
  deployed files are current.
- **`stale_items` > 0** → tell the user:

  > "⚠ Notion cache is stale — N item(s) have changed in Notion since this
  > project was last applied. Reading confirmation will cover the currently-
  > deployed versions, not the latest Notion content.
  >
  > Options:
  > 1. Run `abstract-data pull && abstract-data apply` first (recommended)
  >    so your confirmation covers up-to-date content.
  > 2. Proceed anyway and re-confirm after the next apply.
  >
  > Which would you prefer?"

  Wait for the user's response:
  - **User says pull first** → run `abstract-data pull && abstract-data apply`,
    then re-read the lockfile (it may have new items) and continue to Step 1.
  - **User says proceed anyway** → note in the confirmation summary that the
    reading was performed against a stale cache, then continue to Step 1.
  - **Autonomous / non-interactive run** → default to proceeding anyway and
    note the staleness in the session marker's `cache_stale_at_confirm` field
    (pass `1` as the 3rd arg to write-session-confirmed.sh).

## Step 1 — Build the reading checklist

From the lockfile items, produce a checklist table in this exact format.
Print it so the user can see what will be confirmed:

```
NOTION READING CHECKLIST — <project name> — <timestamp>
─────────────────────────────────────────────────────────
TYPE       NAME                        TARGET PATH
────       ────                        ───────────
skill      python-design-patterns      .claude/skills/python-design-patterns/SKILL.md
hook       block-dangerous-commands    .claude/hooks/block-dangerous-commands.sh
template   AGENTS.md                   AGENTS.md
prompt     plans-agent-prompt          .claude/prompts/plans-agent-prompt.md
...
─────────────────────────────────────────────────────────
Total: N items to confirm
```

## Step 2 — Read and confirm each item

For each item in the checklist, in order:

1. Read the file at `target` from disk using the Read tool.
2. Write a **single sentence** (max 25 words) confirming what the item governs.
   Format: `[TYPE] name — <your one-sentence summary>`

Examples of good confirmations:
- `[skill] python-design-patterns — Teaches async client patterns, Pydantic v2 strict mode, and idempotent sync operations for this stack.`
- `[hook] block-dangerous-commands — Blocks rm -rf, forced push, DROP TABLE, and curl-pipe-sh at the Bash PreToolUse gate.`
- `[template] AGENTS.md — Sets agent scope, risk classification rules, conflict hierarchy, and definition of done for this project.`
- `[prompt] plans-agent-prompt — Requires publishing a Notion plan and pausing for approval before writing code on any non-trivial change.`

Do NOT:
- Copy the file content verbatim.
- Write more than one sentence.
- Skip an item.
- Group multiple items into one summary.

## Step 3 — Human review gate (optional but recommended)

After all items are confirmed, present the full summary to the user and ask:

> "Reading confirmation complete — N items confirmed. Does this look correct?
> Reply 'confirmed' to proceed, or point out any item I may have misread."

If the user says "confirmed" (or any affirmative), continue to Step 4.
If the user identifies a misread item, re-read that file and revise the summary,
then re-present and ask again.

In autonomous / non-interactive runs: skip this gate and proceed directly to Step 4.

## Step 4 — Write the session-confirmed marker

Run:

```bash
bash .claude/hooks/write-session-confirmed.sh . <N> <cache_stale>
```

Where `<N>` is the number of items confirmed and `<cache_stale>` is `1` if you
proceeded against a stale cache (Step 0.5), otherwise `0`.

Expected output: `Session confirmed: N items, expires in 8h (<timestamp>)`

If the script is not present at `.claude/hooks/write-session-confirmed.sh`,
write the marker manually using the Python snippet below (fallback only):

```python
import json, time, datetime, pathlib
marker = pathlib.Path(".abstract-data/session-confirmed.json")
marker.parent.mkdir(exist_ok=True)
now = time.time()
marker.write_text(json.dumps({
    "confirmed_at_unix": int(now),
    "confirmed_at_iso": datetime.datetime.fromtimestamp(now, tz=datetime.timezone.utc).isoformat(),
    "confirmed_by": "agent",
    "items_confirmed": N,  # replace N
    "ttl_hours": 8,
    "cache_stale_at_confirm": False,
}, indent=2) + "\n")
```

## Step 5 — Confirm and proceed

Tell the user:

> "Session confirmed. N items read. The write-guard hook will allow file
> operations for the next 8 hours. Proceeding with [task]."

You may now use Edit and Write tools freely for this session.
