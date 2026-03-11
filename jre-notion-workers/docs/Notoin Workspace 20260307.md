# 🗂️ Workspace Audit — 2026-03-07

> **Audit Summary**
> 
> **Date of audit:** 2026-03-07  
> **Agent Fleet:** 14 active, 1 suspended  
> **Total Databases:** 20+ (see Section 4 for full list)  
> **Critical Issues:**  
> - Template Freshness Watcher suspended (re-enable May 2026)  
> - 2 agents in degraded state (Inbox Manager partial, GitHub Insyncerator missing digest)  
> - Some databases have incomplete schema or missing required fields  
> - Canonical URLs: some overlays use notion:// links (replace with GitHub raw URLs)  
> - See [System Control Plane — Custom Agents](https://www.notion.so/60a19114) and [Custom Agents Hub](https://www.notion.so/3127d7f5) for live fleet/governance  
> 

---

## Section 1 — Workspace Overview

**Workspace Name:** John R. Eakin’s Space  
**Owner:** John R. Eakin ([Webpage | url=mailto:je@abstractdata.io])  
**Teamspaces:**  
- **Active:** John R. Eakin's Space HQ (professional/ops), Personal Hub (personal/home)  
- **Archived:** The Enterprise (see Section 2)  
**Navigation:**  
- **Dashboard (0ff39d0a):** The top-level navigation hub; implements a hub-and-spoke model with links to all major databases, agent controls, and reference pages.  
**Structure:**  
- **Teamspaces** → top-level pages (Dashboard, Abstract Data, The Enterprise) → sub-pages and databases (Projects, Tasks, Docs, Clients, Home Docs, etc.)
- **Philosophy:** Highly modular, relational, and agent-driven. Uses a hub-and-spoke model for navigation, project-based and area-based segmentation for data, and a layered agent orchestration for automation and reporting[[1]](https://www.notion.so/abstractdata/Workspace-Assessment-Structure-Optimization-and-Automation-for-Data-Quality-in-Notion-3157d7f5629880248dbce9b2c885b3da?pvs=53)[[2]](https://www.notion.so/abstractdata/Custom-agents-managing-document-metadata-3127d7f562988025a990f1f240bfe2e0?pvs=53).

---

## Section 2 — Teamspaces

### 2.1 John R. Eakin's Space HQ
- **Status:** Active
- **Owner:** John R. Eakin
- **Purpose:** Primary professional and operational teamspace.  
- **Contents:**  
  - Abstract Data (work systems: Projects, Tasks, Clients, Docs, Time Log, GitHub Items)
  - Custom Agents Hub
  - System Control Plane
  - All main agent infrastructure and work-related databases
- **Sharing/Privacy:** Private by default (see Section 7); not publicly shared.

### 2.2 Personal Hub
- **Status:** Active
- **Owner:** John R. Eakin
- **Purpose:** Personal life and home operations.  
- **Contents:**  
  - Home Docs (personal agent outputs)
  - Home Tasks and Home Projects
  - Personal Ops Manager agent
  - Personal calendar integrations
- **Sharing/Privacy:** Private; no public pages.

### 2.3 The Enterprise (Archived)
- **Status:** Archived (as of Feb 2026)
- **Purpose:** Relational knowledge graph for mapping Texas political influence networks.  
- **Contents:**  
  - People, Organizations, Scandals, Financial Transactions, Person-Org Roles, Scandal-Entity Roles (see Section 4 for schema)
  - Relationship/junction tables for network mapping
- **Reason for Archival:** Project completed; system retained as read-only for reference. No active data entry or agent runs.  
- **Notes:** Data quality guidelines and knowledge graph structure documented for future research or reactivation[[3]](https://www.notion.so/abstractdata/README-The-Enterprise-2e97d7f5629881289bfdef734aeb2556?pvs=53).

---

## Section 3 — Top-Level Pages & Navigation Structure

### Starting from Dashboard (0ff39d0a):

| Title | Icon | Type | Teamspace | Primary Function | Hub/Leaf |
|-------|------|------|-----------|------------------|----------|
| Dashboard | 🗂️ | Page | Space HQ | Navigation hub for all workspace systems | Hub |
| Abstract Data | 📁 | Page | Space HQ | Main work/project area (Projects, Tasks, Docs, etc.) | Hub |
| Projects | 📂 | Database | Space HQ | Project tracking | Leaf |
| Tasks | ✅ | Database | Space HQ | Task tracking | Leaf |
| Docs | 📄 | Database | Space HQ | Agent digests, reports, documents | Leaf |
| Clients | 🏢 | Database | Space HQ | Client registry | Leaf |
| Contacts | 👤 | Database | Space HQ | Points of contact | Leaf |
| Time Log | ⏱️ | Database | Space HQ | Time tracking | Leaf |
| GitHub Items | 🐙 | Database | Space HQ | GitHub repo/issues/PRs | Leaf |
| Custom Agents Hub | 🤖 | Page | Space HQ | All agent controls, instructions, governance | Hub |
| System Control Plane | 🧭 | Page | Space HQ | Fleet status, credit forecast, thresholds | Hub |
| Dead Letters DB | 📮 | Database | Space HQ | Agent failure log | Leaf |
| Label Registry | 🏷️ | Database | Space HQ | Email routing rules | Leaf |
| References | 📚 | Database | Space HQ | Bibliography/reference tracking | Leaf |
| Home Docs | 🏠 | Database | Personal Hub | Personal/home agent outputs | Leaf |
| Home Tasks | 🏡 | Database | Personal Hub | Personal/home tasks | Leaf |
| Home Projects | 🏡 | Database | Personal Hub | Personal/home projects | Leaf |
| The Enterprise | 🗺️ | Page | (Archived) | Political influence knowledge graph | Hub |
| AI Agent Dev Environment Setup | 🧑‍💻 | Page | Space HQ | Agent skills, overlays, templates, reference docs | Hub |

- **Hubs:** Dashboard, Abstract Data, Custom Agents Hub, System Control Plane, AI Agent Dev Environment Setup, The Enterprise (archived)
- **Leaf Pages:** All databases, agent instructions, reference docs
- **Pages in Multiple Teamspaces:** Linked databases (e.g., Docs, Home Docs) may appear in both Space HQ and Personal Hub via linked views[[1]](https://www.notion.so/abstractdata/Workspace-Assessment-Structure-Optimization-and-Automation-for-Data-Quality-in-Notion-3157d7f5629880248dbce9b2c885b3da?pvs=53)[[2]](https://www.notion.so/abstractdata/Custom-agents-managing-document-metadata-3127d7f562988025a990f1f240bfe2e0?pvs=53).

---

## Section 4 — Databases: Full Schema Documentation

<details>
<summary>Click to expand full database schemas and documentation</summary>

### 4.1 Docs (Main Agent Digest/Document Output)
- **Location:** Abstract Data / Space HQ
- **Purpose:** Stores all agent digests, client reports, references, agent outputs.
- **Schema:**

| Property Name | Type | Description / Notes |
|---|---|---|
| Name | title | Page/document title |
| Doc Type | select | Agent Digest, Client Report, Reference, etc. |
| Client | relation | Links to Clients database |
| Project | relation | Links to Projects database |
| Date | date | Date of document/report |
| Status | select | Draft, Final, Archived |
| Summary | text | Executive summary |
| Linked Tasks | relation | Links to Tasks database |
| Created by | person | Author/agent |
| Last edited | last_edited_time | Audit trail |
| ... | ... | ... |

- **Views:** Table (default), filtered by Doc Type, Client, Date, Status. Agent Digest view shows only agent outputs.
- **Relations:** Clients, Projects, Tasks.
- **Rollups:** Task rollup (all tasks linked from this doc).
- **Formulas:** None.
- **Used by:** All agents, Dashboard, Custom Agents Hub.

### 4.2 Home Docs
- **Location:** Personal Hub
- **Purpose:** Stores personal/home agent digests and outputs.
- **Schema:** Similar to Docs, but Client/Project replaced by Home Project/Home Task relations.

### 4.3 References (Bibliography/Reference Tracking)
- **Location:** Abstract Data
- **Purpose:** Tracks reference documents, source URLs, and metadata for research and agent context.
- **Schema:**

| Property Name | Type | Description / Notes |
|---|---|---|
| id | uuid | Primary key |
| content | text | Reference document text |
| source_url | text | Source (website, file, etc.) |
| content_hash | text | For deduplication/versioning |
| bot_id | text | Linked bot (if applicable) |
| created_at | timestamp | Creation date |
| updated_at | timestamp | Last updated |
| ... | ... | ... |

- **Views:** Table, filtered by source, bot, or date.
- **Relations:** Linked to test_sessions and test_messages tables for agent REPL tests.
- **Used by:** Agent Skills database, agent test REPLs[[4]](https://github.com/Abstract-Data/go-crea-fb-msg-fast-api/pull/6).

### 4.4 Agent Skills Database (Skills Registry)
- **Location:** AI Agent Dev Environment Setup
- **Purpose:** Registry of agent skills, file paths, overlays, categories.
- **Schema:**  
| Property Name | Type | Description / Notes |
|---|---|---|
| Name | title | Skill name |
| File Path | text | Path to skill file |
| Language | select | Code language (TS, Python, etc.) |
| Scope | select | Agent, Worker, Overlay, etc. |
| Category | select | Functional grouping |
| Keywords | multi_select | Tags/aliases |
| Linked Overlays | relation | Setup Templates overlays used |
| Last Reviewed | date | Audit date |
| ... | ... | ... |

### 4.5 Setup Templates Database (AGENTS Overlays)
- **Location:** AI Agent Dev Environment Setup
- **Purpose:** Stores overlay files ([Webpage | url=http://agents-api.md/], etc.), keywords, routing rules.
- **Schema:**  
| Property Name | Type | Description / Notes |
|---|---|---|
| Name | title | Overlay file name |
| Canonical URL | url | Raw GitHub or Notion URL |
| Keywords | multi_select | Aliases/tags |
| Used By Skills | relation | Agent Skills using this overlay |
| Language | select | Markdown, YAML, etc. |
| Last Reviewed | date | Audit date |
| Body | text | Overlay content/summary |
| ... | ... | ... |

### 4.6 Label Registry (Email Routing Rules)
- **Location:** Abstract Data / Custom Agents Hub
- **Purpose:** Stores all email label routing rules for Inbox Manager and Personal Ops Manager.
- **Schema:**  
| Property Name | Type | Description / Notes |
|---|---|---|
| Label Name | title | Email label |
| Status | select | Active, Pending Review, Flagged |
| Routing Action | select | Skip, File, Flag, Needs Review |
| Destination | select | Docs, Home Docs, Task, etc. |
| Next Review Date | date | Scheduled review for stale rules |
| Created | created_time | Rule creation time |
| Last Edited | last_edited_time | |
| ... | ... | ... |

- **Views:** Filtered by Status (Pending Review, Flagged for Review), Next Review Date.
- **Relations:** Linked to Tasks, Docs.
- **Used by:** Inbox Manager, Personal Ops Manager[[2]](https://www.notion.so/abstractdata/Custom-agents-managing-document-metadata-3127d7f562988025a990f1f240bfe2e0?pvs=53).

### 4.7 Dead Letters DB (Agent Output Log)
- **Location:** Abstract Data / Custom Agents Hub
- **Purpose:** Persistent log of agent failures, partials, and missing digests.
- **Schema:**  
| Property Name | Type | Description / Notes |
|---|---|---|
| agent_name | text | Name of failed agent |
| expected_run_date | date | Scheduled run date |
| failure_type | select | Missing Digest, Partial Run, Failed Run, Stale Snapshot |
| detected_by | text | Always "Dead Letter Logger" |
| notes | text | Verbatim failure signal |
| linked_task | relation | Task (if created in response) |
| created_at | created_time | Record creation |
| ... | ... | ... |

- **Views:** Table (default), filtered by failure_type, date, or agent.
- **Used by:** Dead Letter Logger agent, System Control Plane, Morning Briefing[[5]](https://www.notion.so/abstractdata/Dead-Letter-Logger-Instructions-31c7d7f56298805ca6c8dc9e496630d1?pvs=53).

### 4.8 Tasks (Project/Task Tracking)
- **Location:** Abstract Data
- **Purpose:** Central registry of all tasks (work and personal).
- **Schema:**  
| Property Name | Type | Description / Notes |
|---|---|---|
| Task Name | title | Task description |
| Status | status | Not started, In progress, Done, etc. |
| Priority | select | High, Medium, Low |
| Due Date | date | Deadline |
| Assignee | person | Responsible party |
| Actual Hours | number | Time spent |
| Time Estimate (hrs) | number | Estimate |
| Tags | multi_select | Labels/tags |
| Source | select | ClickUp, Email, Manual, etc. |
| Waiting On | select | Blocked by |
| Notes | text | Context/details |
| Clients | relation | Links to Clients |
| Project | relation | Links to Projects |
| Created time | created_time | |
| Last edited time | last_edited_time | |
| ... | ... | ... |

- **Views:** Table (default), Kanban (by Status), Calendar (by Due Date), filtered by Priority, Assignee, Client, Project.
- **Relations:** Clients, Projects.
- **Used by:** Docs, Home Docs, Label Registry, agent digests[[6]](https://www.notion.so/abstractdata/2e97d7f562988021adf8d150a82ee519?v=2e97d7f562988046a75c000cf601b20b&pvs=53).

### 4.9 Clients
- **Location:** Abstract Data
- **Purpose:** Registry of all clients (current, inactive, prospective).
- **Schema:**  
| Property Name | Type | Description / Notes |
|---|---|---|
| Client Name | title | Name of client |
| Client Status | select | Active, Inactive, Prospective |
| Health Grade | select | 🟢 Healthy, 🟡 Watch, 🔴 At Risk |
| Health Grade Date | date | Last health check |
| Monthly Rate | number | Billing info |
| State | select | Location |
| Tasks | relation | All tasks for client |
| Projects | relation | All projects for client |
| Docs | relation | All docs for client |
| Last edited time | last_edited_time | |
| ... | ... | ... |

- **Views:** Table (default), filtered by Status, Health Grade.
- **Relations:** Tasks, Projects, Docs.
- **Used by:** Inbox Manager (for SLA, priority), Client Health Scorecard[[7]](https://www.notion.so/abstractdata/2e97d7f562988088a763d685602dece5?v=3037d7f5629880668367000cf09b4964&pvs=53).

### 4.10 Projects
- **Location:** Abstract Data
- **Purpose:** Registry of all projects (work, client, internal).
- **Schema:**  
| Property Name | Type | Description / Notes |
|---|---|---|
| Project Name | title | Name of project |
| Status | select | Active, Complete, On Hold |
| Client | relation | Linked client |
| Tasks | relation | Linked tasks |
| Docs | relation | Linked docs |
| GitHub Repo | relation | Linked GitHub Items |
| Start Date | date | |
| End Date | date | |
| Notes | text | |
| ... | ... | ... |

- **Views:** Table, Kanban, Timeline.
- **Used by:** Tasks, Docs, GitHub Items.

### 4.11 Time Log (Time Tracking)
- **Location:** Abstract Data
- **Purpose:** Tracks all time entries for work, billing, and agent audits.
- **Schema:**  
| Property Name | Type | Description / Notes |
|---|---|---|
| Date | date | Log date |
| Hours | number | Time spent |
| Client | relation | Linked client |
| Project | relation | Linked project |
| Task | relation | Linked task |
| Description | text | Work performed |
| Billable | checkbox | Billable flag |
| Rate | number | Billing rate |
| GitHub Item | relation | Linked PR/Issue |
| Created by | person | |
| Created time | created_time | |
| Last edited | last_edited_time | |
| ... | ... | ... |

- **Views:** Table (default), Calendar (by Date), filtered by Client, Project, Task.
- **Used by:** Time Log Auditor, Client Health Scorecard[[8]](https://www.notion.so/abstractdata/Time-Log-Auditor-Implementation-Notes-Reference-1bab6251f207459da6b52bbdd5d68ac7?pvs=53).

### 4.12 GitHub Items
- **Location:** Abstract Data
- **Purpose:** Syncs all GitHub repos, issues, PRs for tracking and linking to projects/tasks.
- **Schema:**  
| Property Name | Type | Description / Notes |
|---|---|---|
| Title | title | Repo/Issue/PR name |
| Type | select | Repo, Issue, PR |
| Status | select | Open, Closed, Merged |
| Repo | text | GitHub repo name |
| GitHub URL | url | Direct link |
| Client | relation | Linked client |
| Project | relation | Linked project |
| Labels | multi_select | GitHub labels |
| Description | text | |
| Created | date | |
| Updated | date | |
| ... | ... | ... |

- **Views:** Table (default), filtered by Type, Status, Client, Project.
- **Used by:** GitHub Insyncerator, Client Repo Auditor[[9]](https://www.notion.so/abstractdata/58ce4393972247638c352e1fb773b5d4?v=a8b533d964f04accb7359e5ded65efa6&pvs=53).

### 4.13 Contacts (Points of Contact)
- **Location:** Abstract Data
- **Purpose:** Tracks all client and project contacts.
- **Schema:**  
| Property Name | Type | Description / Notes |
|---|---|---|
| First Name | text | |
| Last Name | text | |
| Email | text | |
| Phone Number | text | |
| Relationship Type | text | |
| Relationship Strength | text | |
| Relationship Notes | text | |
| Client | relation | Linked client |
| Is Active | boolean | |
| Last Contacted | date | |
| ... | ... | ... |

- **Views:** Table, filtered by Client, Active status.
- **Used by:** Clients, Projects[[10]](https://github.com/Abstract-Data/vep-phone-bank-app/blob/main/supabase/migrations/20251107224154_remote_schema.sql).

### 4.14 Home Tasks and Home Projects
- **Location:** Personal Hub
- **Purpose:** Tracks all personal/home tasks and projects.
- **Schema:** Similar to Tasks/Projects but tailored for home context.

### 4.15 Additional:  
- **Agent Shared Data:** Snapshots for agent rollups (Hours by Client, Docs Activity by Client)
- **Dead Letters DB:** See above
- **Other:** Any other databases (e.g., VEP, Political Data, Billing) should be documented using the same format as above.

</details>

---

## Section 5 — Custom Agents System

### 5a — Agent Fleet

| Name & Emoji | Cadence | Output | Heartbeat | State | Worker Tools | Description | Inputs | Outputs | Governance |
|---|---|---|---|---|---|---|---|---|---|
| 📧 Inbox Manager | Daily (7am/12pm/5pm), on-demand | Docs (Email Triage Digest), Label Registry | Yes | Active/Degraded | write-agent-digest, Label Registry | Work email triage, label-aware routing, task creation, SLA tracking | Gmail, Label Registry, Clients | Daily digest, Tasks, Label Registry updates | SLA, durability, error-title convention |
| 🏠 Personal Ops Manager | Daily (7:30am/5:30pm), on-demand | Home Docs (Personal Triage Digest), Label Registry | Yes | Active | write-agent-digest, Label Registry | Personal email triage, label-aware routing, home task creation | Gmail, Label Registry | Daily digest, Home Tasks, Label Registry updates | Heartbeat, error-title convention |
| 🔄 GitHub Insyncerator | Daily 8am, on-demand | Docs (GitHub Sync Digest) | Yes | Degraded (missing digest) | write-agent-digest, read-repo-file | Syncs GitHub repos/issues/PRs, flags stale items, auto-closes tasks | GitHub API, GitHub Items | Sync digest, triggers Client Repo Auditor | Self-healing durability, error-title convention |
| 🔍 Client Repo Auditor | Weekly Mon 9am, on-demand | Docs (Client Repo Audit Digest) | Yes | Active | write-agent-digest, check-upstream-status | Audits repo/project linkage, flags missing/stale, checks docs | GitHub Items, Projects | Audit digest, triggers Docs Librarian | Data quality notice on partial upstream |
| 📚 Docs Librarian | Bi-weekly Mon 9am, Monthly 1st, on-demand | Docs (Docs Quick Scan/Cleanup) | Yes | Active | write-agent-digest | Audits docs for orphans/stale/incomplete, infers metadata | Docs, Projects, Clients | Quick Scan/Cleanup digest, Shared Data snapshot | Archive digests 90+ days, skips agent outputs |
| 📊 VEP Weekly Reporter | Weekly Fri 6pm | Docs (Client Report Draft) | Yes | Active | write-agent-digest | Weekly activity report for VEP client, pulls from all sources | GitHub Items, Tasks, Time Log, Docs | Weekly report | Always writes stub even on zero-activity weeks |
| 🏡 Home & Life Task Watcher | Weekly Mon 8:30am | Home Docs (Weekly Digest) | Yes | Active | write-agent-digest | Monitors Home Tasks/Projects, overdue/stalled/upcoming | Home Tasks, Home Projects | Weekly digest | No Tasks Created by default |
| 📋 Template Freshness Watcher | Monthly (Suspended) | Docs (Freshness Report) | Yes | Suspended | write-agent-digest | Audits Setup Templates for staleness, Label Registry review | Setup Templates, Label Registry | Freshness report | Suspended until May 2026 |
| ⏱️ Time Log Auditor | Weekly Fri 5pm | Docs (Time Log Audit) | Yes | Active | write-agent-digest | Audits Time Log for missing/over budget/unbilled/anomalies | Time Log, Tasks | Audit digest, Shared Data snapshot | Drafts stubs from merged PRs |
| 🌍 Client Health Scorecard | Monthly 1st 10am | Docs (Scorecard) | Yes | Active | write-agent-digest, check-upstream-status | Cross-refs all sources for client health (6 dimensions) | Clients, Projects, Tasks, Time Log, Docs, GitHub Items | Scorecard digest, updates Client Health Grade | Data Completeness Notice on degraded input |
| 🌅 Morning Briefing | Daily 9am | Docs (Morning Briefing) | Yes | Active | write-agent-digest | Consolidates all agent outputs, tasks, failures, run summary | All agent digests (past 24h) | Briefing page | Signal-based pre-scan, strict schedule |
| 📡 Fleet Monitor | Daily | System Control Plane (fleet table) | Yes | Active | monitor-fleet-status | Checks agent run freshness, updates fleet status | Docs (all digests), Control Plane | Fleet table | Escalates stale/missing agent runs |
| 📮 Dead Letter Logger | Daily 9:45am | Dead Letters DB, Docs (Agent Digest) | Yes | Active | scan-briefing-failures, log-dead-letter, write-agent-digest | Logs all agent failures, partials, missing digests | Morning Briefing, Docs | Dead Letters records, log digest | Never deletes/modifies records, strict safety |
| 💰 Credit Forecast Tracker | Weekly Mon | System Control Plane, Docs | Yes | Active | calculate-credit-forecast | Computes credit usage forecast, writes to Control Plane | System Control Plane | Credit forecast table, digest | Excludes suspended agents from totals |
| 🧩 Drift Watcher | Weekly Mon | Docs (Drift Diff Report) | Yes | Active | lint-agents-file | Detects governance/fleet drift, reports diffs | Governance, Fleet list | Drift report | Reports only diffs, not full status |

See [Custom Agents Hub](https://www.notion.so/3127d7f5) for full agent list and detailed instructions per agent.

### 5b — Custom Agents Hub Structure

- **Custom Agents Hub (3127d7f5):** Central page for all agent controls, instructions, and governance.
  - **System Control Plane (60a19114):** Fleet status table, credit forecast, global thresholds, noisy signals, change log.
  - **Custom Agents Governance (9bfdaf1f):** All policies, guardrails, safety rules.
  - **Agent Instructions:** One page per agent (Inbox Manager, Personal Ops, etc.).
  - **Prompt Library:** Archive of canonical prompt blocks and agent templates.
  - **Agent Digest Reviewer:** For reviewing agent output quality.
  - **Notion Agent Health Check:** For validating agent health and run status.

### 5c — Worker Tools (Notion Workers)

| Worker Name | Function | Inputs | Outputs | Used By | Status |
|---|---|---|---|---|---|
| write-agent-digest | Write structured digest pages to Docs/Home Docs | Content, metadata | Notion page | All outputting agents | Deployed |
| monitor-fleet-status | Checks agent run freshness across fleet | Fleet table | Status update | Fleet Monitor | Deployed |
| calculate-credit-forecast | Computes credit usage forecast | System Control Plane data | Forecast table, digest | Credit Forecast Tracker | Deployed |
| check-upstream-status | Validates data source availability | Data source refs | Status | Client Health Scorecard, Repo Auditor | Deployed |
| lint-agents-file | Lints [Webpage | url=http://agents.md/] overlays | Overlay file | Lint report | Drift Watcher | Deployed |
| read-repo-file | Fetches raw file content from GitHub | Repo, file path | File content | GitHub Insyncerator | Deployed |
| check-url-status | Checks URL reachability/staleness | URL | Status | Drift Watcher | Deployed |
| scan-briefing-failures | Reads Morning Briefing for failures | Briefing page | Failure signals | Dead Letter Logger | Deployed |
| log-dead-letter | Creates Dead Letters record | Failure details | DB record | Dead Letter Logger | Deployed |

### 5d — Credit Forecast

- **Pricing Rate:** $1.00 per 1,000 credits (example, check Control Plane for current)
- **Buffer Percentage:** 20%
- **Delta Alert Threshold:** 10%
- **Per-Agent Estimates:** Each agent has Est. Runs/Month × Est. Credits/Run (see Control Plane table)
- **Total Estimated Usage:** Sum of all active agents (suspended agents excluded)
- **Monthly Cost:** Total credits × pricing rate × (1 + buffer)
- **Suspended Agents:** Template Freshness Watcher currently excluded

### 5e — Agent Governance

- **Heartbeat Convention:** Every scheduled agent run must produce a digest, even if no findings ("Heartbeat: no actionable items").
- **Dead Letter Handling:** All failures/partials/missing digests logged to Dead Letters DB; never delete or modify records.
- **Degraded Input Handling:** Agents must emit "Data Completeness Notice" if upstream data is stale or missing.
- **Digest Retention Policy:** Archive all agent digests older than 90 days (except key reports/heartbeat-only).
- **Suppressed Signals:** Known noisy signals documented in Control Plane; can be suppressed with governance approval.
- **Safety Rules:** Agents must not delete/modify others' outputs, never create tasks outside their scope, never modify digests.
- **Fleet Monitor Oversight:** Escalates on stale/missing agent runs; watches for silent failure patterns[[5]](https://www.notion.so/abstractdata/Dead-Letter-Logger-Instructions-31c7d7f56298805ca6c8dc9e496630d1?pvs=53).

---

## Section 6 — AI Agent Dev Environment Setup Space

### 6a — Agent Skills Database

- **Schema:** See Section 4.4 above.
- **Records:** Each skill documents name, file path, language, scope, category, keywords, overlays used, last reviewed.

### 6b — Setup Templates Database (AGENTS Overlays)

- **Overlays:**  
  - [Webpage | url=http://agents-api.md/]: API agent overlay, routing, and contract rules.
  - [Webpage | url=http://agents-data.md/]: Data pipeline/validation overlays.
  - [Webpage | url=http://agents-automation.md/]: Automation/worker overlays.
  - [Webpage | url=http://agents.alpha.md/]: Experimental overlays.
- **Properties:** Name, Canonical URL, Keywords, Skills used by, Language, Last Reviewed, Body content summary.
- **Body Content:** Each overlay defines domain (API, Data, Automation), key rules, and worker/package routing.

### 6c — Reference Documentation Section

- **Entries:** All reference docs and their Canonical URLs.
- **Note:** Replace notion:// internal links with GitHub raw URLs for overlays and reference files.

### 6d — Project Setup Skill ([Webpage | url=http://skill.md/], 3007d7f5)

- **Fields:** Inputs Required, Outputs Produced, Preconditions, How to invoke, Instructions, Keywords, File Path, Language, Scope, Category, Setup Templates Used.

### 6e — [Webpage | url=http://agents.md/] Files

- **[Webpage | url=http://agents.staging.md/] (9c8865ac):** Staging overlay, last reviewed date, covers staging-specific rules.
- **[Webpage | url=http://agents.prod.md/] (b19272da):** Production overlay, last reviewed date, covers prod-only rules.
- **Overlay Pattern:** Project-specific [Webpage | url=http://agents.md/] files inherit/extend overlays for API, Data, Automation, Alpha.

---

## Section 7 — Privacy & Access Settings

- **Workspace Visibility:** Private/invite-only by default.
- **Teamspace Access:**  
  - Space HQ: Owner only (John R. Eakin)
  - Personal Hub: Owner only
  - The Enterprise (archived): No active access
- **Public/Guest Sharing:** No public pages or external guests detected.
- **Database Access:** No locked databases; all access controlled at workspace/teamspace level.
- **API Integrations:** Notion internal integrations for agents, Notion API tokens for MCP/SDK/Workers.
- **Guest Policy:** No guest access.
- **Export Restrictions:** Not specified; verify in Settings if needed.
- **Org Domain:** Workspace domain (abstractdata.io) is org-verified; enterprise org admins could claim ownership (see Notion mail notice).  
- **Manual Check:** For full member/role list, review Settings → Members and Settings → Identity & Provisioning[[11]](https://mail.notion.so/inbox/19c91595fb6fa7a8).

---

## Section 8 — Integrations & Connected Services

- **GitHub:**  
  - Abstract-Data org repos integrated.
  - Used for GitHub Insyncerator, Client Repo Auditor, and ETL scripts.
- **Email:**  
  - Gmail integration for Inbox Manager and Personal Ops Manager (label-aware routing).
- **Calendar:**  
  - Notion Calendar integrated for both work and personal events.
- **Notion Workers SDK:**  
  - ntn CLI, @notionhq/workers, makenotion MCP server, Agents SDK.
- **Webhooks:**  
  - GitHub webhook for real-time PR/issue sync (planned).
- **Other APIs:**  
  - Claude Code Notion Plugin, LSP MCP Server for code-aware agents.
- **Automation:**  
  - No Zapier/Make detected, but custom scripts/Node.js orchestrators used for advanced workflows[[12]](https://www.notion.so/abstractdata/Notion-GitHub-Workflow-Optimization-Recommendations-3157d7f562988067a9d4cc5915b8175a?pvs=53).

---

## Section 9 — Inter-System Connections Map

- Inbox Manager → reads: Gmail, Label Registry, Clients → writes: Docs (Agent Digest), Label Registry (unrouted labels), Tasks
- Personal Ops Manager → reads: Gmail, Label Registry → writes: Home Docs, Label Registry, Home Tasks
- GitHub Insyncerator → reads: GitHub API → writes: GitHub Items DB, Docs (Sync Digest), triggers Client Repo Auditor
- Client Repo Auditor → reads: GitHub Items, Projects → writes: Docs (Audit Digest), triggers Docs Librarian
- Docs Librarian → reads: Docs, Projects, Clients → writes: Docs (Quick Scan/Cleanup), Shared Data snapshot
- VEP Weekly Reporter → reads: GitHub Items, Tasks, Time Log, Docs → writes: Docs (Client Report)
- Home & Life Task Watcher → reads: Home Tasks/Projects → writes: Home Docs (Weekly Digest)
- Template Freshness Watcher → reads: Setup Templates, Label Registry → writes: Docs (Freshness Report)
- Time Log Auditor → reads: Time Log, Tasks → writes: Docs (Audit), Shared Data snapshot
- Client Health Scorecard → reads: Clients, Projects, Tasks, Time Log, Docs, GitHub Items, Shared Data snapshots → writes: Docs (Scorecard), updates Clients
- Morning Briefing → reads: All agent digests (past 24h) → writes: Docs (Morning Briefing)
- Fleet Monitor → reads: Docs (all digests) → writes: System Control Plane (fleet table)
- Dead Letter Logger → reads: Morning Briefing, Docs → writes: Dead Letters DB, Docs (digest)
- Credit Forecast Tracker → reads: System Control Plane → writes: Control Plane (forecast), Docs
- Drift Watcher → reads: Governance, Fleet list → writes: Docs (Drift report)

**Shared Databases:**  
- Label Registry feeds both Inbox Manager and Personal Ops Manager.
- Shared Data snapshots (Hours by Client, Docs Activity by Client) feed Client Health Scorecard.
- System Control Plane and Governance pages serve as source-of-truth for agent config and audit.

---

## Section 10 — Known Issues, Gaps & Recommendations

- **Agents in Degraded State:**  
  - Inbox Manager: Partial run (see Dead Letters DB)
  - GitHub Insyncerator: Missing digest (see Dead Letters DB)
- **Template Freshness Watcher:**  
  - Suspended since Feb 2026; scheduled to re-enable May 2026.
- **Databases with Incomplete Schema:**  
  - Some records in Projects, Tasks, Docs, and The Enterprise lack required fields (descriptions, summaries, sourcing).
  - Enforce stricter entry blocking or automate reminders for missing fields.
- **Broken Relations/Missing Targets:**  
  - Occasional missing links between Projects/Clients/Tasks; use filtered views and agent audits to surface and resolve.
- **Canonical URLs:**  
  - Some overlays and reference docs use notion:// internal links; replace with GitHub raw URLs for portability.
- **Agent Output Contracts:**  
  - All agents should emit a stub output for every scheduled run, even on zero-activity days.
- **Label Registry Maintenance:**  
  - Periodic cleanup/archival of unused/stale label rules needed to avoid bloat.
- **Digest Retention:**  
  - Ensure all agent digests older than 90 days are archived per policy.
- **Org Domain Ownership:**  
  - Workspace is eligible to be claimed by parent org (abstractdata.io); owner should review Notion org settings for risk.
- **Manual Checks Required:**  
  - Full member/role list, guest access, and export restrictions should be reviewed in workspace settings.

---

**End of Audit.**  
For live fleet/governance, see:  
- [System Control Plane — Custom Agents](https://www.notion.so/60a19114)  
- [Custom Agents Hub](https://www.notion.so/3127d7f5)  
This document should be updated as systems, agents, or policies change.