# Agent Fleet Refactor & Action Agents Implementation Prompt

**Date:** 2026-03-07
**Purpose:** Implement agreed-upon consolidations, new action-oriented agents, and supporting infrastructure across the Custom Agents fleet.
**Scope:** This prompt covers three workstreams, in order:

1. **Consolidation** — Merge agents where both independent analyses agree
2. **New Action Agents** — Build three agents that produce work product (not just reports)
3. **Supporting Infrastructure** — New databases, schema changes, automations, and workers that the action agents depend on

**Important context:** This fleet currently has 15 active agents (1 suspended). All agents follow the governance rules in [Custom Agents Governance — Policies & Guardrails](https://www.notion.so/9bfdaf1ffc424662af6b0107676fecd7). All agents use workers from the `jre-notion-workers` repo. The System Control Plane is at [System Control Plane — Custom Agents](https://www.notion.so/60a191147ebf4d7cb8965fc7f5904420). The Custom Agents Hub is at [Custom Agents Hub](https://www.notion.so/3127d7f5629880899c61cb81db6b5cbd).

---

## Workstream 1: Consolidation

### 1.1 Merge Fleet Monitor + Dead Letter Logger → Fleet Ops Agent

**What changes:**
- Retire the standalone **Fleet Monitor** agent and the standalone **Dead Letter Logger** agent
- Create a single **Fleet Ops Agent** that performs both functions in one run

**Current state (Fleet Monitor):**
- Runs daily
- Batch-queries all monitored agents' latest digests via `monitor-fleet-status` worker
- Returns fleet-wide health data (per-agent status, run times, degraded flags)
- Updates System Control Plane fleet table with status and run times
- Workers: `monitor-fleet-status`, `write-agent-digest`

**Current state (Dead Letter Logger):**
- Runs daily (triggered by failure detection)
- Reads Morning Briefing digest and extracts failure signals (missing digests, partial runs, failed runs, stale snapshots)
- Creates structured records in Dead Letters database (Resolution Status = Open)
- Never modifies or deletes existing records
- Workers: `log-dead-letter`, `scan-briefing-failures`

**Merged Fleet Ops Agent specification:**

- **Name:** Fleet Ops Agent
- **Icon:** 🛰️ (inherits from Fleet Monitor)
- **Schedule:** Daily at 9:30 AM CT (runs after Morning Briefing at 9:00 AM)
- **Cadence:** Daily (30 runs/month)
- **Est. Credits/Run:** 70 (combined from 40 + 50, minus overlap savings)

**Run sequence:**
1. Call `monitor-fleet-status` — batch-query all agents' latest digests, get fleet-wide health snapshot
2. Call `scan-briefing-failures` — read today's Morning Briefing, extract any failure signals
3. For each failure signal found: call `log-dead-letter` to create/update Dead Letters DB record
4. Update System Control Plane fleet table with current status, run times, degraded flags
5. Write a single Fleet Ops digest (or heartbeat if no issues) via `write-agent-digest`

**Workers:** `monitor-fleet-status`, `scan-briefing-failures`, `log-dead-letter`, `write-agent-digest`

**Reads:**
- Docs database (all agent digests)
- Home Docs (personal agent digests)
- Morning Briefing digest (today's)
- System Control Plane (expected agent schedule, staleness thresholds)
- Dead Letters database (to avoid duplicate records)

**Writes:**
- System Control Plane — Custom Agents (fleet status table, direct property updates)
- Dead Letters database (new Open records for detected failures)
- Docs database (Fleet Ops digest or heartbeat)

**Output schema:**
- Status line required: `Fleet Status: ✅ All Clear | ⚠️ Issues Detected | ❌ Critical Failures`
- If issues detected: list each failure with agent name, failure type, and Dead Letter record link
- If all clear: heartbeat with agent count and "all agents reported within expected windows"

**Governance rules (carried over):**
- Never modify or delete existing Dead Letters records (append-only)
- Use staleness thresholds from System Control Plane (daily: 36h, weekly: 9d, monthly: 40d)
- Fleet Monitor had no digest heartbeat requirement (special ops agent) — the merged agent DOES write a digest for auditability

**Post-merge cleanup:**
- Remove Fleet Monitor from Custom Agents Hub agent list
- Remove Dead Letter Logger from Custom Agents Hub agent list
- Add Fleet Ops Agent to Custom Agents Hub agent list
- Update System Control Plane fleet table: remove Fleet Monitor and Dead Letter Logger rows, add Fleet Ops Agent row
- Update Morning Briefing's Expected Agent Schedule table: replace both entries with single Fleet Ops Agent entry
- Update any agent instructions that reference "Fleet Monitor" or "Dead Letter Logger" by name

---

### 1.2 Fold Credit Forecast Tracker into Fleet Ops Agent

**What changes:**
- Retire the standalone **Credit Forecast Tracker** agent
- Add credit forecasting as a monthly function of the Fleet Ops Agent

**Current state (Credit Forecast Tracker):**
- Runs weekly (Mondays)
- Reads Credit Forecast table from System Control Plane
- Computes monthly burn projection with buffer, week-over-week delta, dollar estimate
- Writes inline updates to System Control Plane credit section
- Writes Credit Forecast digest to Docs
- Workers: `calculate-credit-forecast`, `write-agent-digest`

**How it folds in:**
- Fleet Ops Agent gains a **monthly credit forecast function** that runs on the 1st of each month (or the first Monday of each month)
- On non-forecast days, Fleet Ops runs its normal fleet health + dead letter flow
- On forecast days, it additionally: calls `calculate-credit-forecast`, updates System Control Plane credit section, includes credit summary in that day's digest

**Why monthly instead of weekly:** Credit assumptions don't change week-to-week. A weekly forecast created noise without actionable signal. Monthly captures real changes (new agents added, agents suspended, cadence changes) with 75% fewer runs.

**Updated Fleet Ops Agent specification (with credit forecast):**

- **Est. Credits/Run:** 70 on normal days, 110 on forecast days (~1/month)
- **Additional worker on forecast days:** `calculate-credit-forecast`
- **Additional reads on forecast days:** System Control Plane Credit Forecast table
- **Additional writes on forecast days:** System Control Plane credit section (inline update), credit summary in digest

**Post-fold cleanup:**
- Remove Credit Forecast Tracker from Custom Agents Hub agent list
- Remove Credit Forecast Tracker from System Control Plane fleet table
- Update Morning Briefing's Expected Agent Schedule: remove Credit Forecast Tracker entry
- Note in Fleet Ops Agent instructions: "On the 1st of each month, also run credit forecast"

---

### 1.3 Change Drift Watcher Cadence to Bi-Weekly

**What changes:**
- Drift Watcher currently runs weekly (Mondays)
- Change to bi-weekly (every other Monday)
- No structural changes to the agent itself

**Rationale:** Governance drift doesn't happen week-to-week. The Custom Agents Hub, System Control Plane, and AGENTS.md files change infrequently. Bi-weekly catches drift before it compounds while halving the run count.

**Implementation:**
- Update Drift Watcher's schedule from "Weekly Monday 9:00 AM" to "Bi-weekly Monday 9:00 AM" (runs on 1st and 3rd Mondays, or alternating weeks — use whichever scheduling mechanism Custom Agents supports)
- Update System Control Plane: change expected cadence from "Weekly (Mon)" to "Bi-weekly (Mon)"
- Update Morning Briefing's Expected Agent Schedule: change Drift Watcher expected cadence to bi-weekly
- Update staleness threshold for Drift Watcher: from 9 days (weekly) to 18 days (bi-weekly)

---

### 1.4 Extract Docs Librarian Archive Function → Worker

**What changes:**
- Docs Librarian currently archives agent digests older than 90 days as part of its bi-weekly/monthly runs
- Extract the archive function into a standalone worker: `archive-old-digests`
- Docs Librarian calls this worker instead of doing the archival inline

**Why:** Archiving is mechanical (query by date, move/archive pages). It doesn't need LLM reasoning. Making it a worker means any agent can call it, and the Docs Librarian's prompt gets shorter and more focused on its core job (classification, data quality, freshness).

**New worker: `archive-old-digests`**

**Input:**
```typescript
interface ArchiveOldDigestsInput {
  retention_days: number;       // default: 90
  dry_run: boolean;             // default: false — if true, return list without archiving
  exclude_doc_types: string[];  // default: ["Client Report"] — never archive these
  exclude_patterns: string[];   // default: ["Heartbeat: no actionable items"] — keep heartbeats for audit trail? or archive them too — configurable
}
```

**Output:**
```typescript
interface ArchiveOldDigestsOutput {
  archived_count: number;
  skipped_count: number;        // excluded by type or pattern
  archived_pages: Array<{ id: string; title: string; age_days: number }>;
  skipped_pages: Array<{ id: string; title: string; reason: string }>;
}
```

**Logic:**
1. Query Docs database for pages where:
   - `Document Type` = "Agent Digest"
   - `Created Time` < (today - retention_days)
   - `Document Type` NOT in exclude_doc_types
2. For each matching page:
   - Check if title matches any exclude_patterns → skip
   - If not dry_run: archive the page (move to archive or set status to Archived)
3. Return structured result

**Docs Librarian update:**
- Remove inline archive logic from Docs Librarian prompt
- Add instruction: "Call `archive-old-digests` worker with retention_days=90, exclude_doc_types=['Client Report']"
- Docs Librarian reports archive results in its digest under a "## Archived Digests" section

---

## Workstream 2: New Action Agents

These three agents transform the fleet from "observe and report" to "observe, report, AND produce work product." They are ordered by implementation priority.

### 2.1 Follow-Up Tracker System (Infrastructure + Detection)

**This is not a standalone agent** — it's an enhancement to Inbox Manager and a new database.

#### 2.1.1 New Database: Follow-Up Tracker

Create this database in the workspace:

| Property | Type | Notes |
|----------|------|-------|
| Title | title | Brief description of the follow-up |
| Source | select | Options: Email, Meeting, Slack, Manual, Agent-Created |
| Client | relation → Clients | |
| Contact | relation → Points of Contact | |
| Project | relation → Projects | |
| Status | status | Groups: Not started (Needs Response), In progress (Draft Ready, Waiting on Them), Complete (Sent, Done) |
| Priority | select | 🔴 Urgent, 🟠 High, 🟡 Medium, 🟢 Low |
| Due Date | date | When you should respond by |
| Original Message | url | Link to email thread or meeting notes |
| Draft Location | url | Link to draft in Notion Mail or Docs |
| Context Summary | text | Agent-generated summary of what's being asked + relevant workspace context |
| Created | created_time | |
| Last Edited | last_edited_time | |

**Automations on this database (zero tokens):**
- Page added with Priority = 🔴 Urgent → Send Notion notification
- Due Date = today AND Status ≠ Sent/Done → Send daily reminder notification
- Status changed to Done → (no auto-action needed; agent sweep handles cleanup)

#### 2.1.2 Enhance Inbox Manager: Follow-Up Detection

**Add to Inbox Manager's existing instructions** (do not replace anything — append this as a new pass):

After completing standard email triage, run a follow-up detection pass:

**Scan for these signals:**
- Emails in your inbox where you are in the "To" field and haven't replied in 24+ hours
- Emails containing direct questions to you (contains "?" near "you" or your name)
- Meeting requests you haven't accepted or declined
- Threads where the last message is from someone else (ball is in your court)
- Emails from clients with SLA tracking enabled (check Client record for SLA fields)

**For each detected follow-up:**
1. Check Follow-Up Tracker for existing entry with matching Original Message URL → if exists, skip (no duplicates)
2. If no existing entry: create a Follow-Up Tracker entry with:
   - Title: "[Sender Name] — [Subject line or key question]"
   - Source: "Email"
   - Client: match sender to Clients database (by email domain or contact name)
   - Priority: 🔴 Urgent if SLA client at risk, 🟠 High if client email > 48h, 🟡 Medium if < 48h, 🟢 Low for non-client
   - Due Date: Based on SLA (24h for At Risk clients, 48h standard for retainer clients, 72h for non-client)
   - Original Message: link to the email thread
   - Context Summary: 1-2 sentence summary of what they're asking

**Add a new section to Email Triage digest:**
After the existing 5 sections, add:
```
## Pending Responses
[X new follow-ups detected, Y existing follow-ups still open]

| Contact | Subject | Age | Priority | Due |
|---------|---------|-----|----------|-----|
| [name] | [subject] | [Xh/Xd] | [emoji] | [date] |
```

**Token cost impact:** ~500 additional tokens per run (marginal — agent already reads these emails). 3 runs/day × 30 days = ~45,000 additional tokens/month.

---

### 2.2 Response Drafter Agent (NEW)

**This is the highest-token agent. Start conservative and expand.**

- **Name:** Response Drafter
- **Icon:** ✍️
- **Schedule:** Daily at 7:45 AM CT (runs after Inbox Manager's 7:00 AM batch, before Morning Briefing at 9:00 AM)
- **Cadence:** Daily, 1x/day to start (30 runs/month). Expand to 3x/day (after 12:00 and 5:00 PM batches) once quality is validated.
- **Est. Credits/Run:** 150-250 depending on pending items count

**Purpose:** For each item in Follow-Up Tracker with Status = "Needs Response", draft a reply using relevant workspace context. Save the draft to Notion Mail. Never send anything — drafts only.

**Run sequence:**

1. **Query Follow-Up Tracker** for items where:
   - Status = "Needs Response"
   - Created > 24 hours ago (skip fresh items — give yourself time to reply naturally)
   - Source = "Email" (start with email only; expand to Meeting follow-ups later)

2. **For each pending follow-up** (process up to 5 per run to cap token spend):

   a. **Read the original email thread** from Original Message URL

   b. **Pull workspace context** based on the Client relation:
      - If Client is set:
        - Recent project status (query Projects where Client = this client, Status = Active)
        - Open tasks (query Tasks where Client = this client, Status ≠ Done, limit 10)
        - Last meeting notes (query AI Meeting Notes where Client = this client, sort by When desc, limit 1)
        - Client health grade (read Health Grade property from Client record)
        - Recent docs (query Docs where Client = this client, last 14 days)
      - If Client is NOT set:
        - Try to match sender email/name to Points of Contact → pull their client's context
        - If no match: draft without client context (generic professional reply)

   c. **Draft the reply:**
      - Tone: professional, warm, matches the sender's formality level
      - Content: directly addresses their question(s) using pulled workspace context
      - Length: concise — aim for 3-5 sentences unless the question requires detailed explanation
      - Include specific data points from workspace (e.g., "Your project is currently at 80% completion with 3 open tasks remaining")
      - If you don't have enough context to answer confidently, say so in the draft and flag what's missing
      - Never fabricate information — if a data point isn't in the workspace, don't invent it

   d. **Save the draft** to Notion Mail as a draft reply to the original thread

   e. **Update the Follow-Up Tracker entry:**
      - Status → "Draft Ready"
      - Draft Location → link to the draft in Notion Mail
      - Context Summary → update with a note about what context was used to draft

3. **Write digest** via `write-agent-digest`:
   - Status line: `Draft Status: ✅ X drafts created | ⚠️ Y items skipped (no context) | ❌ Failed`
   - Section: "## Drafts Created" with links to each draft and the follow-up tracker entry
   - Section: "## Skipped Items" with reason for each skip
   - If no pending items: heartbeat with "No items in Needs Response status older than 24h"

**Workers:** `write-agent-digest`, `check-upstream-status` (to verify Inbox Manager ran)

**Reads:**
- Follow-Up Tracker (pending items)
- Notion Mail (original email threads)
- Clients database (health grade, SLA info)
- Projects database (active projects per client)
- Tasks database (open tasks per client)
- AI Meeting Notes (recent meetings per client)
- Docs database (recent docs per client)
- Points of Contact (for sender matching)

**Writes:**
- Notion Mail (draft replies — NEVER sends, drafts only)
- Follow-Up Tracker (status updates, draft locations)
- Docs database (Response Drafter digest)

**Token optimization rules:**
- Max 5 drafts per run (cap token spend per run)
- Skip follow-ups younger than 24 hours (you might reply yourself)
- Skip follow-ups from senders not in Clients or Points of Contact (configurable — start with clients-only)
- Skip automated/notification emails (newsletters, GitHub notifications, marketing)
- Cache client context within a run (if drafting 3 replies to the same client, pull context once)

**Safety guardrails:**
- NEVER send any email or message. Draft only.
- NEVER fabricate project status, hours, or deliverables
- If health grade is 🔴 At Risk, flag the draft for manual review with a note: "⚠️ Client is At Risk — review carefully before sending"
- Include a "[DRAFT — Review before sending]" prefix in every draft subject line

**Monthly token estimate (conservative, 1x/day):**
- ~3 pending items/day average × ~3,000 tokens per draft (context retrieval + generation) = ~9,000 tokens/run
- 30 runs/month = ~270,000 tokens/month
- (If expanded to 3x/day: ~810,000 tokens/month)

---

### 2.3 Client Briefing Agent (NEW)

- **Name:** Client Briefing Agent
- **Icon:** 📋
- **Schedule:** Daily at 7:00 AM CT (runs first, so briefings are ready before Morning Briefing)
- **Cadence:** Daily, but only produces output when meetings are detected (most days = heartbeat)
- **Est. Credits/Run:** 20 on heartbeat days, 120 on briefing days

**Purpose:** Check for client meetings in the next 24 hours. For each one, produce a one-page briefing document so you walk into meetings prepared.

**Run sequence:**

1. **Check for upcoming meetings:**
   - Query AI Meeting Notes for meetings where `When` is within the next 24 hours
   - Also check Notion Calendar (work calendar) for events with client names in the title
   - If no client meetings found: write heartbeat digest, end run

2. **For each upcoming client meeting:**

   a. **Identify the client:**
      - If AI Meeting Notes entry has Client relation set → use that
      - If calendar event: fuzzy-match event title against Clients database
      - If no match: skip (can't brief without knowing the client)

   b. **Assemble briefing content:**
      - **Client snapshot:** Health Grade, retainer status, last meeting date, current projects
      - **Recent activity (last 14 days):**
        - Tasks completed and in progress
        - GitHub activity (PRs merged, issues opened/closed)
        - Docs created or updated
        - Time logged vs retainer budget
      - **Open items:**
        - Follow-Up Tracker items for this client with Status ≠ Done
        - Tasks assigned to you for this client
        - Pending responses from Response Drafter
      - **Last meeting summary:** Pull notes from the most recent AI Meeting Notes entry for this client
      - **Decisions:** Query Decision Log for recent decisions related to this client's projects
      - **Suggested talking points:** Based on open items and recent activity, suggest 3-5 things to bring up

   c. **Write the briefing page:**
      - Create a page in Docs with:
        - Title: "Client Briefing — [Client Name] — [Meeting Date]"
        - Document Type: "Client Briefing"
        - Client relation: set
        - Meeting Notes relation: link to the upcoming AI Meeting Notes entry
      - Content: structured briefing with sections for each area above
      - Keep it to one page — this is a pre-meeting scan, not a report

3. **Write digest** via `write-agent-digest`:
   - Status line: `Briefing Status: ✅ X briefings created | ⚠️ Y meetings skipped (no client match)`
   - Link to each briefing page
   - If no meetings: heartbeat

**Workers:** `write-agent-digest`, `check-upstream-status`

**Reads:**
- AI Meeting Notes (upcoming meetings)
- Notion Calendar (work calendar events)
- Clients database (health grade, retainer info)
- Projects database (active projects)
- Tasks database (open/recent tasks)
- GitHub Items (recent activity)
- Time Log database (hours vs budget)
- Docs database (recent docs)
- Follow-Up Tracker (open items)
- Decision Log (recent decisions)
- Points of Contact (meeting attendees)

**Writes:**
- Docs database (Client Briefing pages)
- Docs database (Client Briefing Agent digest)

**Token estimate:**
- Heartbeat days (~20 per month): ~20 tokens × 20 = 400 tokens
- Briefing days (~10 per month, assuming 2-3 client meetings/week): ~3,000 tokens per briefing × 10 = 30,000 tokens
- **Monthly total: ~30,400 tokens**

---

### 2.4 Enhance Morning Briefing: "Your Action Items Today"

**Add to Morning Briefing's existing instructions** (prepend this as the FIRST section, before the agent digest rollup):

Before consolidating agent digests, produce a "## Your Action Items Today" section at the TOP of the briefing. Pull from:

1. **Follow-Up Tracker:** Items with Due Date = today or overdue, Status ≠ Done/Sent
2. **Draft reviews:** Follow-Up Tracker items with Status = "Draft Ready" (Response Drafter has prepared something for you)
3. **Tasks due:** Tasks database items assigned to you with Due Date = today or past due
4. **Meeting prep:** Client Briefing pages created today (link them so you can review before meetings)
5. **Calendar today:** Work calendar events for today (meeting times, deadlines)

**Format:**
```
## Your Action Items Today

### 🔴 Overdue (X items)
- [Follow-up: Client Name — Subject] — Due [date], [X days overdue] → [link]
- [Task: Task Name] — Due [date] → [link]

### 📝 Drafts Ready for Review (X drafts)
- [Draft reply to Client Name — Subject] → [link to draft] | [link to follow-up tracker]

### 📋 Meeting Prep (X meetings today)
- [Meeting with Client Name at HH:MM] → [Client Briefing link]

### 📅 Due Today (X items)
- [Follow-up: ...] → [link]
- [Task: ...] → [link]
```

**Then continue with existing Morning Briefing content** (agent digest rollup, signal-based pre-scan, disposition model, etc.)

**Token cost impact:** ~500 additional tokens per run. 30 runs/month = ~15,000 additional tokens/month.

---

## Workstream 3: Supporting Infrastructure

These items must be in place before the action agents can function.

### 3.1 Database Schema Changes

#### AI Meeting Notes — Add Relations

Add these properties to the AI Meeting Notes database (data source: `collection://f1c3bddf-5f76-454d-b739-7451483099b4`):

| New Property | Type | Purpose |
|-------------|------|---------|
| Client | relation → Clients | Link meetings to clients |
| Project | relation → Projects | Link meetings to projects |
| Follow-Ups Created | relation → Follow-Up Tracker | Track action items from meetings |
| Decisions | relation → Decision Log | Track decisions made in meetings |

#### Clients — Add Meeting Rollup

| New Property | Type | Purpose |
|-------------|------|---------|
| Meetings | relation → AI Meeting Notes | Bidirectional from above |
| Last Meeting Date | rollup on Meetings | MAX(When) — used by Client Briefing Agent and Client Health Scorecard |
| Meeting Count | rollup on Meetings | COUNT — engagement metric |

#### Dead Letters — Add Resolution Fields

Add to Dead Letters database (data source: `collection://b59800da-56b5-4316-97c3-98f7a9e37e3b`):

| New Property | Type | Purpose |
|-------------|------|---------|
| Resolved Date | date | Auto-set by automation when Resolution Status → Resolved |
| Resolution Notes | text | What fixed it |

#### Tasks — Add Follow-Up Link

| New Property | Type | Purpose |
|-------------|------|---------|
| Follow-Up | relation → Follow-Up Tracker | Link tasks to the follow-up that spawned them |

### 3.2 New Database: Decision Log

| Property | Type | Notes |
|----------|------|-------|
| Decision | title | What was decided |
| Context | text | Why, alternatives considered |
| Status | select | Proposed, Accepted, Superseded |
| Date | date | When decided |
| Project | relation → Projects | |
| Client | relation → Clients | |
| Meeting Notes | relation → AI Meeting Notes | If decided in a meeting |
| Decided By | person | |
| Superseded By | relation → Decision Log | Self-relation |
| Tags | multi_select | Architecture, Tooling, Process, Pricing, Scope |

**Automation:** Status changed to "Superseded" → Send notification

### 3.3 Automations (Zero Tokens)

Set up these Notion built-in database automations:

1. **Follow-Up Tracker:** Page added with Priority = 🔴 Urgent → Notify
2. **Follow-Up Tracker:** Due Date = today AND Status ≠ Done → Daily reminder notification
3. **Dead Letters:** Resolution Status → Resolved → Set Resolved Date to today
4. **Decision Log:** Status → Superseded → Notify
5. **All databases (Docs, Home Docs, Projects, Tasks, Home Tasks):** Page added → Set Status to default value (Draft, Planning, Not started respectively)
6. **Tasks, Home Tasks:** Page added with Priority = 🔴 Urgent or 🟠 High → Notify
7. **Label Registry:** Next Review Date is before today → Set Status to "Pending Review", check "Flagged for Review"

### 3.4 New Worker: `auto-link-meeting-client`

**Purpose:** After a meeting note arrives in AI Meeting Notes, fuzzy-match against Clients database and set the Client relation.

**Input:**
```typescript
interface AutoLinkMeetingClientInput {
  meeting_page_id?: string;    // specific page to process, or
  scan_unlinked?: boolean;     // true = scan all AI Meeting Notes where Client is empty
  max_pages?: number;          // default: 20
}
```

**Output:**
```typescript
interface AutoLinkMeetingClientOutput {
  linked_count: number;
  unmatched_count: number;
  linked: Array<{ page_id: string; title: string; client_name: string; match_type: string }>;
  unmatched: Array<{ page_id: string; title: string; reason: string }>;
}
```

**Matching logic (in priority order):**
1. Context field contains exact client name → link
2. Context field contains a name from Points of Contact → link via that contact's Client
3. Tags contain a client-related keyword → link
4. Meeting title contains client name → link
5. No match → leave empty, include in unmatched list

**Called by:** Docs Librarian (as part of its bi-weekly scan), or any agent that creates meeting notes.

### 3.5 New Worker: `archive-old-digests`

(Specified in Workstream 1, Section 1.4 above — extracted from Docs Librarian)

---

## Updated Fleet Roster (Post-Implementation)

After all workstreams complete, the fleet changes from 15 active + 1 suspended to **13 active + 1 suspended**:

| # | Agent | Cadence | Change |
|---|-------|---------|--------|
| 1 | 📧 Inbox Manager | 3x daily | Enhanced with follow-up detection |
| 2 | 🏠 Personal Ops Manager | 2x daily | No change |
| 3 | 🔄 GitHub Insyncerator | Daily | No change |
| 4 | 🔍 Client Repo Auditor | Weekly (Mon) | No change |
| 5 | 📚 Docs Librarian | Bi-weekly + Monthly | Archive function extracted to worker, calls `auto-link-meeting-client` |
| 6 | 📊 VEP Weekly Reporter | Weekly (Fri) | No change |
| 7 | 🏡 Home & Life Task Watcher | Weekly (Mon) | No change |
| 8 | ⏱️ Time Log Auditor | Weekly (Fri) | No change |
| 9 | 🌍 Client Health Scorecard | Monthly (1st) | Add meeting recency dimension using Last Meeting Date rollup |
| 10 | 🌅 Morning Briefing | Daily | Enhanced with "Your Action Items Today" top section |
| 11 | 🛰️ Fleet Ops Agent | Daily + Monthly forecast | **NEW** — merged Fleet Monitor + Dead Letter Logger + Credit Forecast |
| 12 | 🧩 Drift Watcher | Bi-weekly (Mon) | Cadence changed from weekly to bi-weekly |
| 13 | ✍️ Response Drafter | Daily (1x, expandable to 3x) | **NEW** — drafts email replies using workspace context |
| 14 | 📋 Client Briefing Agent | Daily (heartbeat unless meetings) | **NEW** — produces pre-meeting briefing docs |
| — | 📋 Template Freshness Watcher | Suspended until May 2026 | No change |

**Retired agents (3):**
- ~~Fleet Monitor~~ → merged into Fleet Ops Agent
- ~~Dead Letter Logger~~ → merged into Fleet Ops Agent
- ~~Credit Forecast Tracker~~ → monthly function of Fleet Ops Agent

**Net change:** 15 → 14 active agents (gained 2 new action agents, retired 3 via consolidation)

---

## Updated Credit Forecast

| Agent | Est. Runs/Month | Est. Credits/Run | Monthly Credits | Change |
|-------|-----------------|------------------|-----------------|--------|
| Inbox Manager | 30 | 85 | 2,550 | +5/run for follow-up detection |
| Personal Ops Manager | 30 | 60 | 1,800 | — |
| GitHub Insyncerator | 30 | 100 | 3,000 | — |
| Client Repo Auditor | 4 | 120 | 480 | — |
| Docs Librarian | 6 | 80 | 480 | -10/run (archive extracted to worker) |
| VEP Weekly Reporter | 4 | 80 | 320 | — |
| Home & Life Task Watcher | 4 | 70 | 280 | — |
| Time Log Auditor | 4 | 60 | 240 | — |
| Client Health Scorecard | 1 | 160 | 160 | +10/run for meeting recency |
| Morning Briefing | 30 | 125 | 3,750 | +5/run for action items section |
| Fleet Ops Agent | 30 | 75 | 2,250 | Replaces Fleet Monitor (1,200) + Dead Letter Logger (1,500) + Credit Forecast (240) = 2,940 saved → 2,250 new = **net save 690** |
| Drift Watcher | 2 | 80 | 160 | Halved from 4 runs to 2 |
| **Response Drafter** | **30** | **150** | **4,500** | **NEW** (conservative 1x/day) |
| **Client Briefing Agent** | **30** | **40 avg** | **1,200** | **NEW** (mostly heartbeats) |
| Template Freshness Watcher | 0 | 0 | 0 | Suspended |
| **TOTAL** | | | **21,170** | Was ~19,570 → +1,600 net |

The two new action agents add ~5,700 credits/month. The consolidation and cadence changes save ~4,100 credits/month. **Net cost of the entire refactor: ~1,600 credits/month** — for agents that now actually produce work product.

---

## Implementation Order

**Phase 1 (Week 1): Infrastructure**
1. Create Follow-Up Tracker database with all properties and automations
2. Create Decision Log database with all properties and automations
3. Add schema changes to AI Meeting Notes, Clients, Dead Letters, Tasks
4. Set up all zero-token automations (Section 3.3)
5. Build `auto-link-meeting-client` worker
6. Build `archive-old-digests` worker
7. Run `auto-link-meeting-client` on existing AI Meeting Notes backlog

**Phase 2 (Week 2): Consolidation**
1. Create Fleet Ops Agent with merged Fleet Monitor + Dead Letter Logger instructions
2. Test Fleet Ops Agent for 2-3 days alongside the originals (run both, compare output)
3. Once validated: retire Fleet Monitor, Dead Letter Logger, and Credit Forecast Tracker
4. Update all references in Custom Agents Hub, System Control Plane, Morning Briefing
5. Change Drift Watcher cadence to bi-weekly
6. Extract Docs Librarian archive function to use `archive-old-digests` worker

**Phase 3 (Week 3): Follow-Up Engine**
1. Enhance Inbox Manager with follow-up detection
2. Test for 3-5 days — verify Follow-Up Tracker entries are accurate, not duplicative
3. Enhance Morning Briefing with "Your Action Items Today" section

**Phase 4 (Week 4): Action Agents**
1. Build Response Drafter agent (start at 1x/day)
2. Test for 5-7 days — verify draft quality, check token spend against estimates
3. Build Client Briefing Agent
4. Test for 3-5 days — verify briefing content is accurate and useful
5. Once both validated: update credit forecast in System Control Plane

**Phase 5 (Week 5+): Tuning**
1. Review Response Drafter output quality — adjust context retrieval, tone, length
2. If draft quality is good and you're reviewing all of them: expand to 2x or 3x/day
3. Review Client Briefing output — adjust talking points, add/remove sections
4. Run full Drift Watcher audit to verify all governance docs reflect the new fleet
5. Enhance Client Health Scorecard with meeting recency dimension

---

## Governance Updates Required

After implementation, update these governance documents:

1. **Custom Agents Hub:** Update agent list table (remove 3 retired, add 2 new, update Drift Watcher cadence)
2. **System Control Plane:** Update fleet table, credit forecast assumptions, staleness thresholds
3. **Custom Agents Governance:** Add Response Drafter and Client Briefing Agent to the output schema requirements. Add Follow-Up Tracker to the list of databases agents may write to.
4. **Morning Briefing Expected Agent Schedule:** Replace Fleet Monitor + Dead Letter Logger + Credit Forecast Tracker with Fleet Ops Agent. Add Response Drafter and Client Briefing Agent entries.
5. **AGENTS.md files:** Create AGENTS.md for Fleet Ops Agent, Response Drafter, Client Briefing Agent. Archive AGENTS.md files for retired agents.
