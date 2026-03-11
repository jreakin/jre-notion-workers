# Full Notion Workspace Report — John R. Eakin / Abstract Data
Reviewed: March 7, 2026

---

## 1. Workspace Overview & Access Permissions

- **Workspace name:** John R. Eakin's Space
- **Workspace URL slug:** `abstractdata`
- **Owner:** John R. Eakin (`je@abstractdata.io`) — sole Workspace Owner, 1 paid seat
- **Guest access:** 1 active guest — Clay Young (`will.clay.young@gmail.com`) with access to 5 pages
- **Member invite link:** Enabled (toggleable)
- **Default teamspace:** John R. Eakin's Space HQ (all new members auto-join)
- **Teamspace creation:** Restricted to workspace owners only
- **Public pages:** Feature available but no evidence of active public pages

**Integration bots present (not human users):** JRE Workers, Make Integration - Abstract Data, Notion MCP, PortalWith, The Enterprise v0 Site, to.email

---

## 2. Teamspace Structure

There are 4 teamspaces, all owned by John R. Eakin — 3 active, 1 archived:

| Teamspace | Access | Members | Last Updated |
|---|---|---|---|
| The Enterprise | Open | 1 | 3/2/26 |
| Personal Hub | Closed | 1 | 2/24/26 |
| John R. Eakin's Space HQ | Default | 1 | 2/5/26 |
| The Enterprise *(archived)* | — | — | — |

- The Enterprise is Open-access (anyone in workspace can join)
- Personal Hub is Closed (invite only)
- John R. Eakin's Space HQ is the workspace default
- A second "The Enterprise" teamspace exists in an archived state — likely a legacy duplicate

---

## 3. Top-Level Structural Map

```
John R. Eakin's Space (workspace)
├── Private (personal/non-teamspace pages)
│   ├── New page
│   ├── AI Meetings
│   └── Analyst (AI Instructions)
│
├── Teamspace: Personal Hub
│   └── Dashboard
│       ├── Quick Nav links (Work + Lodge + Home & Life sections)
│       ├── Home & Life Projects (embedded database)
│       ├── Side-Projects
│       ├── Findlay Masonic Lodge
│       └── Custom Agents Hub
│
├── Teamspace: The Enterprise
│   └── README: The Enterprise (primary hub page)
│       ├── People database
│       ├── Organizations database
│       ├── Scandals database
│       ├── Financial Transactions database
│       ├── Person-Org Roles (junction table)
│       ├── Scandal-Entity Roles (junction table)
│       ├── Social Media Posts database
│       ├── Scorecard Confessions: Articles
│       └── Case Files
│
└── Teamspace: John R. Eakin's Space HQ
    ├── Abstract Data (main work hub page)
    │   ├── Clients DB
    │   ├── Points of Contact DB
    │   ├── Projects DB
    │   ├── Tasks DB
    │   ├── Docs DB
    │   ├── Time Log DB
    │   ├── GitHub Items DB
    │   ├── Templates Hub
    │   └── Client Hub
    └── AI Agent - Dev Environment Setup
```

---

## 4. The Abstract Data Work Hub (John R. Eakin's Space HQ)

### 4.1 Agent Index Page

The main Abstract Data page functions as a stable text-only agent index (source of truth for AI agents). It explicitly instructs agents that this text index is authoritative even if embedded views change. It contains:

- Direct links to all 7 core databases
- Links to agent governance docs
- Agent output routing rules (where agents write digests)
- Embedded live views of Active Projects, Active Tasks, and Recent Time Entries

---

## 5. Core Databases / Schemas

### 5.1 🏢 Clients
**Purpose:** CRM for active and prospective clients

| Field | Type |
|---|---|
| Client Name | Title |
| State | Select |
| Client Status | Select (Active, Prospective Client) |
| Active Contacts | Relation → Points of Contact |
| Vendors | Relation → Points of Contact |
| Last edited time | System |

**Views:** Active Clients, Points of Contact, All Clients

**Current records (8 clients):**
- Scott Braddock - Personal (Active)
- Go Creative Group (Texas, Active)
- Abstract Data Internal (Texas, Active)
- Zach Maxwell / BallotMate (Texas, Prospective)
- Quorum Report (Texas, Active)
- Texas Voter Engagement Project (Texas, Active)
- JRP Advisory (Texas, Active)
- (Karl Rove referenced in GitHub Items)

---

### 5.2 👤 Points of Contact
**Purpose:** Contact directory linked to clients

| Field | Type |
|---|---|
| Name | Title |
| Client | Relation → Clients |
| Role | Select (Point of Contact, Vendor) |
| Status | Select (Active) |

**Views:** Active Contacts, All Contacts

**Active contacts (11):** Jordan Pichanick, Zach Maxwell, B. Robertson, Calum Hayes, Derek Ryan, Rocky Gage, Geoffrey Tahuahua, Harvey J. Kronberg, Tom Boschwitz, Scott Braddock, and others

---

### 5.3 📊 Projects
**Purpose:** Project management with client, type, and budget tracking

| Field | Type |
|---|---|
| Project Name | Title |
| Client | Relation → Clients |
| Project Type | Select (Internal, Favor, Fixed Bid, Retainer) |
| Status | Select (Active, On Hold, Completed) |
| Start Date | Date |
| Target Completion | Date |
| Budget ($) | Number |
| Open Tasks | Rollup |
| Document Count | Rollup |
| Docs | Relation → Docs |
| Tasks | Relation → Tasks |
| Time Entries | Relation → Time Log |
| GitHub Items | Relation → GitHub Items |
| GitHub Pull Requests | Rollup |
| Github Project ID | Text (e.g. AD-PROJ-1) |
| Description (AI) | AI auto-fill |
| Project Title | Formula |
| Agent Skills | Text |
| Client Name | Rollup |

**Views:** Active, Completed, All Projects, ⚠️ Missing Project Descriptions

**Active projects (11):**
- Voter File Audit Package (Internal, AD-PROJ-15)
- vep-match-fast (Texas VEP, AD-PROJ-14)
- Republicans Against TLR Research (Go Creative, Favor, AD-PROJ-11)
- 🏛️ Texas Election Results Site/API (Internal, AD-PROJ-9, target Mar 9 2026)
- ⚖️ TALA Vibe-Coded Site/Penta (Go Creative, Favor, AD-PROJ-8)
- v0 Website Rebuild (Quorum Report, Fixed Bid, AD-PROJ-6)
- 💵 Campaign Finance Python Project (Internal, On Hold, AD-PROJ-4)
- vep-validation-tools (Texas VEP, Internal, AD-PROJ-3)
- 🗳️ VEP-2026 System Development (Texas VEP, Fixed Bid, AD-PROJ-2)
- 💰 VEP Monthly Retainer - 2025 (Texas VEP, Retainer, $84,000, AD-PROJ-1)
- Notion Workers (Internal, AD-PROJ-16, Feb 28 2026)

---

### 5.4 ✅ Tasks
**Purpose:** Full task management with priority, assignees, and source tracking

| Field | Type |
|---|---|
| Task Name | Title |
| Status | Select |
| Priority | Select (Urgent, High, Medium) |
| Due Date | Date |
| Clients | Relation → Clients |
| Project | Relation → Projects |
| Actual Hours | Number |
| Assignee | Person |
| ClickUp ID | Text |
| Docs | Relation → Docs |
| GitHub Items | Relation → GitHub Items |
| GitHub Pull Requests | Rollup |
| ID | Auto-increment |
| Notes | Text |
| Project Name | Rollup |
| Source | Select |
| Tags | Multi-select |
| Task Title | Formula |
| Time Entries | Relation → Time Log |
| Time Estimate (hrs) | Number |
| Waiting On | Text |
| Created time | System |
| Last edited time | System |

**Views:** Active Tasks, Completed Tasks, All Tasks, ⚠️ Missing Task Notes

Recent active tasks include GitHub sync fixes, Supabase security checks, Vercel deployment issues, Checkly account management, Datadog trial decisions, and County Precinct Scraper

---

### 5.5 📄 Docs
**Purpose:** Document repository for all agent outputs, reports, proposals, and assessments

| Field | Type |
|---|---|
| Name | Title |
| Clients | Relation → Clients |
| Status | Select (Draft, Final) |
| Document Type | Select (Agent Digest, Report, AI Codebase Assessment, Client Report (Draft), Proposal) |
| Project | Relation → Projects |
| Task | Relation → Tasks |
| Summary (AI) | AI auto-fill |
| Last edited time | System |
| Notion Page ID | Text |
| Files & media | File |

**Views:** All Docs, AI Prompts, Reports, Code Assessments, Proposals, ⚠️ Docs Missing Type or Summary

Active doc types visible: Agent Digests (daily email triage, GitHub sync, morning briefings), AI Codebase Assessments (txelections.live, Civix IVIS ENR-UI, TX Election Results Site), Reports (Going After Paxton analysis, vibe-coded site analysis)

---

### 5.6 ⏱️ Time Log
**Purpose:** Time tracking with billability, GitHub item linkage, and rate

| Field | Type |
|---|---|
| Description | Title |
| Hours | Number |
| Amount | Formula (Hours × Rate) |
| Billable | Checkbox |
| Client | Relation → Clients |
| Project | Relation → Projects |
| Task | Relation → Tasks |
| GitHub Item | Relation → GitHub Items |
| Rate | Number |
| Date | Date |

**Views:** Default view (recent entries visible show GitHub-sourced time stubs for February 24, 2026)

---

### 5.7 🔀 GitHub Items
**Purpose:** GitHub sync — tracks repos, issues, and PRs across all client projects

| Field | Type |
|---|---|
| Title | Title |
| Client | Relation → Clients |
| Type (AI) | AI auto-fill (Repo, Issue, PR) |
| Status | Select (Open, Merged, Closed) |
| Project | Relation → Projects |
| Description (AI) | AI auto-fill |
| GitHub Number | Number |
| GitHub URL | URL |
| Labels | Multi-select |
| Repo | Text |
| Updated | Date |

**Views:** Everything, Repos, Issues, PRs

Currently tracking ~36 repos across Abstract-Data org and jreakin personal account. Notable repos: voterfile-audit-pipeline, vep-2026-system, texas-against-lawsuit-abuse, tx-jan2026-quick-results, and 30+ others

---

## 6. The Enterprise (Political Intelligence Workspace)

This is an entirely separate system — a political influence knowledge graph for mapping the Texas conservative political landscape.

**Scale (as of report date):**
- 147 people tracked (politicians, donors, operatives, media figures)
- 145 organizations tracked across 19 org types
- 18 scandals tracked

### Database architecture (knowledge graph model)

**Core entity tables (Nodes):**

| Database | Purpose | Key Fields |
|---|---|---|
| People | Politicians, operatives, donors, media figures | Person Name, Location, X Profile, rollups for Orgs/Roles/Scandals/Transactions |
| Organizations | PACs, think tanks, campaigns, media, shell companies | Org Name, Org Type, Description, Website, rollups for People/Leadership/Scandals/Transactions |
| Scandals | Controversies, investigations, incidents | Scandal Title, Description, Files/media, rollups for People/Orgs involved |
| Financial Transactions | Donations, expenditures, PAC transfers, vendor payments | Amount, Transaction Type, From/To Person, From/To Org, Source File |

**Relationship tables (Edges/Junction tables):**

| Database | Purpose | Key Fields |
|---|---|---|
| Person-Org Roles | Links People ↔ Organizations with role context | Person, Organization, Role, Status, Start/End Date, Notes |
| Scandal-Entity Roles | Links People/Orgs ↔ Scandals with involvement context | Scandal, Person/Org, Involvement Type, Status, Date, Notes |

**Available Role types:** Founder, Co-founder, Chairman, VP, President, CEO, Executive Director, Director, Board Member, Employee, Donor, Investor, Advisor, Legal Counsel, Elected Official, Campaign Manager, Vendor, Content Creator, Show Host, and more

**Org types tracked:** 501(c)(3), 501(c)(4), Church, For-Profit, Government, Media, Movement Network, News Outlet, PAC, Political Campaign, Political Consulting, Political Party, Political Vendor, Polling Vendor, Private Foundation, Shell Company, Social Manipulation Service, State PAC, Think Tank

Notable people tracked include: Ken Paxton, Ted Cruz, Dan Patrick, Matt Rinaldi, Tim Dunn, Leonard Leo, Charlie Kirk, Tucker Carlson, Steve Bannon, and 137+ others

**Additional databases in The Enterprise:**
- Social Media Posts — tracking social media activity
- Scorecard Confessions: Articles — Texas Scorecard article tracking
- Case Files — investigative file organization

---

## 7. Custom Agent Fleet

The workspace runs **15 Notion AI custom agents**, coordinated through the Custom Agents Hub. Three new agents were added March 6, 2026, bringing the fleet from 12 to 15.

### Agent Registry

| Agent | Cadence | Output Destination | Status |
|---|---|---|---|
| 🌅 Morning Briefing | Daily (9am) | Docs (Agent Digest) | Active |
| 📧 Abstract Data - Inbox Manager | Daily | Docs (Agent Digest) | Active |
| 🏠 Personal Ops Manager | Daily | Home Docs (Agent Digest) | Active |
| 🔄 GitHub Insyncerator | Daily | Docs (Agent Digest) | Active |
| 🛰️ Fleet Monitor | Daily (after Morning Briefing) | Docs (heartbeat comment on Control Plane) | Active |
| 📬 Dead Letter Logger | Daily (after Fleet Monitor) | Dead Letters DB + Docs (Agent Digest) | Active |
| ⏱️ Time Log Auditor | Weekly (Fri) | Docs (Agent Digest) | Active |
| 🔍 Client Repo Auditor | Weekly (Mon) | Docs (Agent Digest) | Active |
| 📚 Docs Librarian | Weekly \| Monthly | Docs (Agent Digest) | Active |
| 📊 VEP Weekly Reporter | Weekly (Fri) | Docs (Agent Digest) | Active |
| 🏡 Home & Life Task Watcher | Weekly (Mon) | Home Docs (Agent Digest) | Active |
| 📊 Credit Forecast Tracker | Weekly (Mon) | Docs (Agent Digest) | Active |
| 🌍 Client Health Scorecard | Monthly (1st) | Docs (Agent Digest) | Active |
| 🧩 Drift Watcher | Monthly / On-Demand | Docs (Agent Digest) | Active |
| 📋 Template Freshness Watcher | Monthly (1st) / Quarterly | Docs | Suspended (re-enable after May 2026) |

### New infrastructure added March 6, 2026

**Dead Letters database** — structured failure log. Each record captures: Agent Name, Expected Run Date, Failure Type (Missing Digest / Partial Run / Failed Run / Stale Snapshot), Detected By, Resolution Status, Time to Resolution, Notes, and Linked Task. Fed by the Dead Letter Logger agent. Resolution is human-only.

**Worker Tools Reference** — documented in the Custom Agents Hub. Seven named worker tools across three categories that agents call during their runs:

| Category | Tool | Purpose |
|---|---|---|
| Core | `write-agent-digest` | Creates governance-compliant digest pages in Docs |
| Core | `check-upstream-status` | Reads agent digest status lines for downstream gating |
| Core | `create-handoff-marker` | Creates structured escalation records |
| Fleet Ops | `monitor-fleet-status` | Batch-queries all agents' latest digests; powers Fleet Monitor |
| Fleet Ops | `scan-briefing-failures` | Extracts failure signals from Morning Briefing digest |
| Fleet Ops | `log-dead-letter` | Creates records in the Dead Letters database |
| Forecasting | `calculate-credit-forecast` | Computes monthly credit burn projection with buffer and delta |

**Credit Forecast table** — embedded in the System Control Plane. Per-agent estimates for all 14 active agents (Template Freshness excluded as suspended). Pricing assumption: $10.00 per 1,000 credits, 20% buffer, ±10% delta alert threshold. Maintained by Credit Forecast Tracker (weekly, Mondays). Current estimated monthly fleet burn: ~10,650 credits base (~$127.80 buffered) — to be confirmed by first agent run.

### Coordination architecture

Agents coordinate via database-mediated chaining and machine-readable status lines. Key patterns in use:

- **Status lines** in first 10 lines of every digest: `✅ Complete`, `⚠️ Partial`, `❌ Failed`
- **Heartbeat protocol**: agents write a digest on every scheduled run, even zero-activity runs (`Heartbeat: no actionable items`)
- **Exception routing**: single closure owner per exception via `Escalated To` / `Handoff Complete` markers
- **Upstream data quality gates**: downstream agents check status lines before reading digest content in full
- **Signal-based pre-scan**: Morning Briefing scans page titles and status lines before deciding whether to read each digest in full — reduces credit consumption on quiet days

### Daily run sequence (for sequenced agents)

1. 9:00am — Morning Briefing
2. ~9:30am — Fleet Monitor (reads Morning Briefing output, updates Control Plane)
3. ~9:45am — Dead Letter Logger (reads Morning Briefing for failure signals, logs to Dead Letters DB)

---

*Report last updated: March 7, 2026*
