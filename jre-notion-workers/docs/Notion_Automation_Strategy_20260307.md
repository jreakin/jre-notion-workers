# Notion Automation Strategy: Keep Everything Tagged, Organized & Current

**Date:** 2026-03-07
**Goal:** Maximize organization and data quality across all databases while minimizing Notion token spend.
**Priority order:** Automations (0 tokens) → Workers (minimal tokens) → Custom Agents (most tokens)

---

## How to Read This Document

Each recommendation is tagged with its tier and the database(s) it affects. Estimated token impact is noted where relevant.

- **🟢 AUTOMATION** = Notion built-in database automation (zero tokens, runs instantly)
- **🔵 WORKER** = Notion Worker tool (minimal tokens — called by agents only when needed)
- **🟣 AGENT** = Custom Agent run (uses tokens — scheduled or triggered)

---

## Section 1: Automations (Zero Tokens)

These are things you should be doing with Notion's built-in database automations right now. They cost nothing, run instantly, and handle the mechanical bookkeeping that currently either isn't happening or is burning agent tokens.

### 1.1 Auto-Set Document Type on Digest Creation

**Database:** Docs, Home Docs
**Trigger:** Page added
**Condition:** Name contains any of your digest title patterns ("Email Triage", "Personal Triage", "GitHub Sync", "Morning Briefing", etc.)
**Action:** Set `Document Type` → "Agent Digest"

**Why:** Your `write-agent-digest` worker already sets `doc_type` via the API, but if any digest is created manually or via a different path, this catches it. Belt and suspenders — zero cost.

### 1.2 Auto-Set Status on New Pages

**Databases:** Docs, Home Docs, Projects, Tasks, Home Tasks
**Trigger:** Page added
**Action:** Set `Status` → the appropriate default:
- Docs/Home Docs → "Draft"
- Projects → "Planning"
- Tasks/Home Tasks → "Not started"

**Why:** Several of your databases have pages with no status set. This guarantees every new page starts in the right state without anyone thinking about it.

### 1.3 Auto-Archive Completed Projects After 30 Days

**Database:** Projects
**Trigger:** Property edited → `Status` changed to "Completed"
**Action:** Set `Target Completion` → today's date (if empty)

Then a second automation:
**Trigger:** Property edited → `Status` is "Completed" AND `Last edited time` > 30 days ago
**Action:** (Notion automations can't do time-delayed actions natively — flag this for the `archive-old-digests` worker pattern instead, or use a Notion reminder)

**Workaround:** Create a "Completed Date" date property, auto-set it when status → Completed. Then your agents or a worker can query for "Completed Date older than X."

### 1.4 Auto-Notify on High-Priority Task Creation

**Database:** Tasks, Home Tasks
**Trigger:** Page added with `Priority` = "🔴 Urgent" or "🟠 High"
**Action:** Send Notion notification to you

**Why:** Right now high-priority tasks created by agents (e.g., from Inbox Manager flagging something) don't ping you. You discover them when you look at the database. A native notification costs zero tokens and gets your attention immediately.

### 1.5 Auto-Link Meeting Notes to Client

**Database:** AI Meeting Notes
**Current gap:** Your AI Meeting Notes schema has `Context` (text) and `Tags` but no `Client` relation.
**Prerequisite:** Add a `Client` relation property to AI Meeting Notes.
**Trigger:** Property edited → `Context` is edited
**Action:** (Notion automations can't do fuzzy matching, so this becomes a Worker — see 2.3)

### 1.6 Auto-Set Dead Letter Resolution Date

**Database:** Dead Letters
**Trigger:** Property edited → `Resolution Status` changed to "Resolved"
**Action:** Create a new date property `Resolved Date`, auto-set to today when status → Resolved.

**Why:** You currently have no way to track mean-time-to-resolution for agent failures. This is a free field that enables future reporting.

### 1.7 Auto-Flag Stale Label Registry Entries

**Database:** Label Registry
**Trigger:** Property edited → `Next Review Date` is before today
**Action:** Set `Status` → "Pending Review", set `Flagged for Review` → checked

**Why:** Label routing rules go stale silently. This surfaces them without an agent run.

### 1.8 Gmail Send on Task Status Change (Client-Facing)

**Database:** Tasks
**Trigger:** Property edited → `Status` changed to "Done" AND `Clients` is not empty
**Action:** Send mail to (client contact — requires the "Send mail" automation action)

**Caveat:** This is powerful but risky. You'd probably want this as an opt-in per task (add a "Notify Client on Completion" checkbox). Only automate the send if that checkbox is checked. Otherwise, use this as a notification to *you* to follow up.

---

## Section 2: Workers (Minimal Tokens)

Workers are called by agents as tools. They run a focused operation and return structured data. They cost tokens only when invoked, and each invocation is small (typically 1-2K tokens for input/output).

### 2.1 `tag-untagged-docs` (NEW WORKER)

**Problem:** Your Docs database has a view called "⚠️ Docs Missing Type or Summary" — meaning docs exist without a `Document Type` or `Summary`. These are data quality gaps that make search and filtering unreliable.

**What it does:** Queries Docs (and Home Docs) for pages where `Document Type` is empty. For each, reads the page title and first few blocks, then infers the correct Document Type from the content patterns. Sets the property.

**Token cost:** ~500 tokens per page (title + first 5 blocks + property update). Run it weekly on the backlog, then as a post-write validation step.

**Rules for inference:**
- Title contains any `AGENT_DIGEST_PATTERNS` value → "Agent Digest"
- Title contains "Proposal" → "Proposal"
- Title contains "Report" or "Audit" → "Report"
- Title contains "Spec" or "Technical" → "Technical Spec"
- Default → flag as "Needs Review" (don't guess)

### 2.2 `ensure-bidirectional-relations` (NEW WORKER)

**Problem:** Your databases have rich relational structure (Docs ↔ Tasks ↔ Projects ↔ Clients ↔ GitHub Items), but relations can become one-sided. If someone links a Task to a Project but doesn't link the Project back to the Task, the Project's task rollup is incomplete.

**What it does:** For a given database pair (e.g., Tasks ↔ Projects), scans for orphaned one-way relations and completes the bidirectional link.

**Token cost:** Negligible — pure API reads and writes, no LLM reasoning needed. This is a data integrity tool.

**Note:** Notion's two-way relations should handle this automatically. But if relations were created via API without setting both sides, or if pages were duplicated, gaps appear. This worker audits and fixes them.

### 2.3 `auto-link-meeting-client` (NEW WORKER)

**Problem:** AI Meeting Notes has no `Client` relation. Even if you add one, Plaud/Zapier won't set it — they don't know your client list.

**What it does:** After a new meeting note arrives (triggered by an agent or scheduled scan), reads the `Context` field and `Tags`, fuzzy-matches against your Clients database (client names, contact names, email domains), and sets the `Client` relation. Also sets `Project` if it can match.

**Token cost:** ~300 tokens per meeting note. Runs after each meeting import or as a daily sweep.

**Matching logic:**
- Exact match: Context contains client name → link
- Contact match: Context contains a name from Points of Contact → link via that contact's client
- Tag match: Tags contain a client-related keyword → link
- No match → leave empty, add to a "Needs Client Tag" view

### 2.4 `backfill-task-source` (NEW WORKER)

**Problem:** Your Tasks DB has a `Source` field (ClickUp, Manual, GitHub) but many tasks created by agents don't set it. Tasks created from email triage, dead letters, or handoff markers should be tagged with their origin.

**What it does:** Queries Tasks where `Source` is empty. Checks if the task was created by an automation/API (via `Created by` being a bot user) and infers the source from the task name patterns or linked docs.

**Token cost:** Minimal — pattern matching on titles, no LLM needed.

### 2.5 `validate-project-completeness` (NEW WORKER)

**Problem:** Your Projects DB has a "⚠️ Missing Project Descriptions" view, meaning active projects exist without descriptions. But there are other completeness gaps: projects without a client link, projects with no tasks, active projects past their target completion date.

**What it does:** Scans Projects for configurable completeness rules and returns a structured report. Rules:
- Active project with empty Description → FAIL
- Active project with empty Client → WARN
- Active project with 0 tasks → WARN
- Active project past Target Completion → FAIL
- Active project with no Docs linked → WARN

**Token cost:** ~200 tokens total (pure API queries, structured output). Run weekly.

---

## Section 3: Agent Enhancements (Token-Conscious)

These are changes to existing agents or new agents that require LLM reasoning but are designed to be token-efficient.

### 3.1 Enhance Inbox Manager: Follow-Up Detection

**Current behavior:** Scans email, triages by label, creates tasks/docs as needed.
**Enhancement:** Add a "follow-up detection" pass. After triaging, scan for:
- Emails where you are in the "To" field and haven't replied in 48+ hours
- Emails with questions directed at you (contains "?" + your name or "you")
- Meeting requests you haven't accepted/declined
- Threads where the last message is from someone else (ball is in your court)

**Output:** A new section in the Email Triage digest: "## Pending Responses" with items listed by age and priority. Each item includes: sender, subject, age, and a one-line summary of what they're asking.

**Token cost:** Marginal increase — the agent is already reading these emails. Adding a filter pass is ~500 extra tokens per run.

### 3.2 New Agent: Response Drafter

**Cadence:** Runs after Inbox Manager (e.g., 07:30, 12:30, 17:30 CT)
**Purpose:** For each item in the "Pending Responses" list, drafts a reply in Notion Mail.

**How it works:**
1. Reads the pending response item (sender, subject, thread context)
2. Pulls relevant workspace context:
   - If sender maps to a Client → pull recent project status, open tasks, last meeting notes from AI Meeting Notes
   - If sender maps to a Contact → pull their client's health score, recent docs
   - If thread mentions a project/repo → pull GitHub Items status, recent commits
3. Drafts a reply that addresses their question using the pulled context
4. Saves draft to Notion Mail (or a "Drafts" section in Docs linked to the client)
5. Adds a "Draft Ready" item to the Follow-Up Tracker

**Token cost:** This is the most token-expensive item on this list. Estimate ~2-3K tokens per draft (context retrieval + generation). If you have 5 pending responses per day across 3 runs = ~15 drafts/day = ~35-45K tokens/day.

**Token optimization strategies:**
- Only draft for emails older than a configurable threshold (e.g., 24h — skip fresh ones you might reply to yourself)
- Only draft for known clients/contacts (skip newsletters, automated notifications)
- Use the Label Registry routing rules: only draft for labels with `Routing Action` = "Full Reasoning" or "Flag + Task"
- Cache client context across the 3 daily runs (if the client data hasn't changed, reuse the context block)

### 3.3 Enhance Morning Briefing: "Your Action Items" Section

**Current behavior:** Consolidates upstream agent digests into a daily summary.
**Enhancement:** Add a section at the top: "## Your Action Items Today" that pulls from:
- Follow-Up Tracker items due today or overdue
- Tasks assigned to you with due dates today or past due
- Meeting prep needed (meetings in AI Meeting Notes for today that have no prep doc)
- Draft responses ready for review (from Response Drafter)

**Token cost:** ~500 extra tokens per run (queries + formatting). High value because it turns Morning Briefing from "here's what your agents did" into "here's what YOU need to do."

### 3.4 Enhance Docs Librarian: Auto-Tagging Pass

**Current behavior:** Weekly scan of Docs database (currently producing stubs/partial output).
**Enhancement:** When scanning, also check for:
- Docs with empty `Document Type` → call `tag-untagged-docs` worker
- Docs with empty `Summary` → generate a 1-2 sentence summary from the page content and set it
- Docs with no `Client` or `Project` relation → attempt to infer from content and title, flag if unsure

**Token cost:** ~500 tokens per untagged doc (content read + summary generation). If you have 10 untagged docs per week = ~5K extra tokens/week. Very efficient for the data quality improvement.

### 3.5 Enhance Client Health Scorecard: Meeting Recency

**Current behavior:** Scores clients on activity signals.
**Enhancement:** Add "last meeting date" as a scoring dimension. Query AI Meeting Notes for the most recent meeting with each client. If last meeting > 14 days ago for an active client → factor into health score. If > 30 days → flag as "engagement risk."

**Prerequisite:** The `auto-link-meeting-client` worker (2.3) must be running so AI Meeting Notes has Client relations.

**Token cost:** ~200 extra tokens per client (one DB query per client for meeting recency).

### 3.6 New Agent: Weekly Data Quality Report

**Cadence:** Weekly (e.g., Sunday evening)
**Purpose:** Runs all the validation workers and produces a single digest summarizing workspace health.

**Calls these workers:**
- `validate-project-completeness` → project gaps
- `tag-untagged-docs` (dry_run=true) → untagged doc count
- `check-agent-staleness` → overdue agents
- `validate-digest-quality` (on last 7 days of digests) → governance compliance
- `ensure-bidirectional-relations` (dry_run=true) → broken relations count

**Output:** A digest in Docs with type "Report" summarizing:
- X projects with gaps (list them)
- X docs needing tags (list them)
- X stale agents (list them)
- X digests with quality issues
- X broken relations found

**Token cost:** ~3-5K tokens total (mostly worker calls + formatting). Runs once a week. High ROI because it catches data rot before it accumulates.

---

## Section 4: New Database Additions

### 4.1 Follow-Up Tracker

**Purpose:** Tracks items where you need to take action — reply to an email, follow up with a client, deliver something promised in a meeting.

| Property | Type | Notes |
|----------|------|-------|
| Title | title | Brief description of the follow-up |
| Source | select | Email, Meeting, Slack, Manual, Agent-Created |
| Client | relation | Links to Clients |
| Contact | relation | Links to Points of Contact |
| Project | relation | Links to Projects |
| Status | status | Needs Response, Draft Ready, Sent, Waiting on Them, Done |
| Priority | select | 🔴 Urgent, 🟠 High, 🟡 Medium, 🟢 Low |
| Due Date | date | When you should respond by |
| Original Message | url | Link to email thread, Notion Mail, or meeting notes |
| Draft Location | url | Link to the draft in Notion Mail or Docs |
| Context Summary | text | Agent-generated summary of what they're asking + relevant workspace context |
| Created | created_time | |
| Last Edited | last_edited_time | |

**Automations on this database:**
- 🟢 Page added with Priority = Urgent → Send Notion notification
- 🟢 Status changed to "Done" → auto-archive after 7 days (via agent sweep)
- 🟢 Due Date is today or past due AND Status ≠ Done → Send Notion notification (daily reminder)

### 4.2 Decision Log

**Purpose:** Institutional memory for project decisions.

| Property | Type | Notes |
|----------|------|-------|
| Decision | title | What was decided |
| Context | text | Why this decision was made, alternatives considered |
| Status | select | Proposed, Accepted, Superseded |
| Date | date | When decided |
| Project | relation | Links to Projects |
| Client | relation | Links to Clients |
| Meeting Notes | relation | Links to AI Meeting Notes (if decided in a meeting) |
| Decided By | person | Who made the call |
| Superseded By | relation | Self-relation to the new decision that replaced this one |
| Tags | multi_select | Architecture, Tooling, Process, Pricing, Scope |

**Automations:**
- 🟢 Status changed to "Superseded" → notification to review the new decision

---

## Section 5: Schema Changes to Existing Databases

### 5.1 AI Meeting Notes — Add Relations

| New Property | Type | Purpose |
|-------------|------|---------|
| Client | relation → Clients | Link meetings to clients (set by `auto-link-meeting-client` worker) |
| Project | relation → Projects | Link meetings to projects |
| Follow-Ups Created | relation → Follow-Up Tracker | Track action items spawned from this meeting |
| Decisions | relation → Decision Log | Track decisions made in this meeting |

### 5.2 Clients — Add Meeting Rollup

| New Property | Type | Purpose |
|-------------|------|---------|
| Meetings | relation → AI Meeting Notes | Bidirectional link from Client addition above |
| Last Meeting Date | rollup | MAX(AI Meeting Notes.When) — for health scoring |
| Meeting Count | rollup | COUNT(AI Meeting Notes) — engagement metric |

### 5.3 Dead Letters — Add Resolution Fields

| New Property | Type | Purpose |
|-------------|------|---------|
| Resolved Date | date | Auto-set by automation when Resolution Status → Resolved |
| Resolution Notes | text | What fixed it |
| Assigned To | person | Who's responsible for resolving |

### 5.4 Tasks — Add Follow-Up Link

| New Property | Type | Purpose |
|-------------|------|---------|
| Follow-Up | relation → Follow-Up Tracker | Link tasks to the follow-up that created them |

---

## Section 6: Token Budget Estimate

| Item | Frequency | Est. Tokens/Run | Monthly Total |
|------|-----------|----------------|---------------|
| Automations (Section 1) | Continuous | 0 | 0 |
| tag-untagged-docs | Weekly | ~5,000 | ~20,000 |
| ensure-bidirectional-relations | Weekly | ~1,000 | ~4,000 |
| auto-link-meeting-client | Daily | ~1,500 | ~45,000 |
| backfill-task-source | Weekly | ~500 | ~2,000 |
| validate-project-completeness | Weekly | ~200 | ~800 |
| Inbox Manager enhancement | 3x daily | ~1,500 | ~135,000 |
| Response Drafter (new agent) | 3x daily | ~15,000 | ~1,350,000 |
| Morning Briefing enhancement | Daily | ~500 | ~15,000 |
| Docs Librarian enhancement | Weekly | ~5,000 | ~20,000 |
| Client Health enhancement | Daily | ~1,000 | ~30,000 |
| Weekly Data Quality Report | Weekly | ~4,000 | ~16,000 |
| **Total new monthly token spend** | | | **~1,637,800** |

The Response Drafter dominates the budget. If you want to be conservative, start it at once daily instead of 3x, or only for emails older than 48h. That drops it to ~450K tokens/month for that agent alone, bringing the total to ~740K.

---

## Recommended Implementation Order

**Week 1: Free wins (Automations)**
1. Set up all Section 1 automations — zero tokens, immediate value
2. Add the schema changes from Section 5 (new properties/relations)
3. Create the Follow-Up Tracker and Decision Log databases (Section 4)

**Week 2: Data quality foundation (Workers)**
1. Build `tag-untagged-docs` worker
2. Build `auto-link-meeting-client` worker
3. Build `validate-project-completeness` worker
4. Enhance Docs Librarian to call these workers

**Week 3: Action-oriented agents**
1. Enhance Inbox Manager with follow-up detection
2. Enhance Morning Briefing with "Your Action Items"
3. Build the Weekly Data Quality Report agent

**Week 4: The big one**
1. Build Response Drafter agent
2. Connect it to Notion Mail
3. Tune the token budget based on actual usage from weeks 1-3
