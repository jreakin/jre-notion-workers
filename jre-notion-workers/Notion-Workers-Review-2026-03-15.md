# Notion Workers + Custom Agent Instructions — Revised Review & Recommendations

**Date:** 2026-03-15
**Scope:** Full cross-reference of Notion workspace audit, Custom Agent Instructions, and the `jre-notion-workers` codebase
**Sources:** Codebase analysis (`src/index.ts`, `src/shared/agent-config.ts`, all 21 worker source files, `dist/` artifacts) + Notion workspace audit (March 15, 2026) + Governance doc + Workers Details page + Control Plane

---

## Executive Summary

The architecture is strong. The 21-worker fleet, governance enforcement, dead letter tracking, and self-healing infrastructure are production-grade. What needs attention is **layer drift** — the code, the Notion docs, the agent instructions, and the agent settings panels have gotten out of sync during the rapid March build-out, and there are a few structural issues in Notion itself (naming collisions, trashed instruction pages, an undeployed agent burning credits) that compound the problem.

This document covers three categories:

1. **Workers Functionality Changes** — code changes, config fixes, redeployment
2. **Notion Configuration & Structural Fixes** — workspace reorganization, permission cleanup
3. **Custom Agent Instruction Adjustments** — edits to individual agent instruction pages and settings

---

## 1. Workers Functionality Changes

### 1A. CRITICAL — Agent Name Mismatch: "Home & Life Watcher" vs "Home & Life Task Watcher"

In `src/shared/agent-config.ts`, the agent is registered as `"Home & Life Watcher"`. Everywhere in Notion — the Hub table, Control Plane fleet table, and agent instructions — it's called **"Home & Life Task Watcher"**.

Any agent calling `check-upstream-status` or `write-agent-digest` with the Notion name will fail `isValidAgentName()` validation silently. This is likely compounding the Home Docs access issue — even if the database were fixed, the name mismatch would still cause failures.

**Fix (Option A — change code to match Notion, recommended):** Update `agent-config.ts` to use `"Home & Life Task Watcher"` in all four maps (`AGENT_DIGEST_PATTERNS`, `AGENT_TARGET_DB`, `AGENT_CADENCE`, and the key used by `MONITORED_AGENTS`). Then `npm run check && npm run build && ntn workers deploy`.

### 1B. Meeting Prep Agent — Not Registered in Workers at All

The workspace audit found a **Meeting Prep Agent** with an active Weekly Monday 9AM trigger that's firing — but it has zero pages in its access list, no calendar connected, and has never produced output.

The Workers codebase has **no registration** for this agent. It's not in `agent-config.ts` (no digest patterns, no target DB, no cadence, no staleness threshold). It's not in `MONITORED_AGENTS` or `SUSPENDED_AGENTS`. The only mention in the repo is a planning doc (`Agent_Fleet_Refactor_Prompt.md`).

This means:

- `monitor-fleet-status` doesn't track it
- `check-agent-staleness` doesn't check it
- `write-agent-digest` can't create digests for it (name validation fails)
- It's burning credits every Monday for zero output

**Fix (choose one):**

**If deploying:** Add to `agent-config.ts`:
```typescript
// In AGENT_DIGEST_PATTERNS:
"Meeting Prep Agent": ["Meeting Prep"],

// In AGENT_TARGET_DB:
"Meeting Prep Agent": "docs",

// In AGENT_CADENCE:
"Meeting Prep Agent": "daily",  // or "weekly" if truly weekly
```
Then wire up its Notion access (AI Meetings, Clients, Projects databases + calendar), write proper instructions, and redeploy workers.

**If suspending (recommended until ready):** Add to `SUSPENDED_AGENTS` in `agent-config.ts`:
```typescript
export const SUSPENDED_AGENTS: string[] = ["Template Freshness Watcher", "Meeting Prep Agent"];
```
And disable its trigger in Notion immediately. This stops the credit burn while preserving the option to activate it later.

### 1C. Zombie Build Artifact: `reconcile-github-items.js` in dist/

The `dist/` folder contains `reconcile-github-items.js` — a compiled worker from an earlier iteration. The source file no longer exists (it was replaced by `sync-github-items.ts`), and it's not registered in `index.ts`. It's dead code.

**Fix:** Delete `dist/workers/reconcile-github-items.js` to prevent confusion, then rebuild: `npm run build`. The Notion Workers Details page also still references this old name and needs updating (see §2F).

### 1D. Drift Watcher Cadence — Code Says Biweekly, Reality Says Weekly

The workspace audit confirms Drift Watcher fires "Every Monday (weekly)" per Morning Briefing instructions. But `agent-config.ts` sets it to `"biweekly"` with a 432-hour staleness threshold.

If the agent actually runs weekly, the staleness check is too lenient — it won't flag a missing Drift Watcher run until 18 days have passed. This defeats the purpose of staleness detection.

**Fix:** Update `agent-config.ts`:
```typescript
// Change from:
"Drift Watcher": "biweekly",
// To:
"Drift Watcher": "weekly",
```
This changes the staleness threshold from 432h to 216h (~9 days), which is appropriate for a weekly agent.

### 1E. No Other Code Logic Changes Needed

The actual worker implementations are solid. Governance rules (status formatting, heartbeat detection, circuit breakers, escalation caps), input validation, error handling, and the shared utilities are all correctly implemented. The 21 registered tools work as designed.

---

## 2. Notion Configuration & Structural Fixes

### 2A. P0 — Home Docs Database Inaccessible

Both Personal Ops Manager and Home & Life Task Watcher are blocked from writing digests. Personal Ops is failing its 5:30PM run daily; Home & Life Task Watcher hasn't run since March 9.

**Action:** Reconnect or recreate the Home Docs database. Grant both agents `Can edit content`. Update the `HOME_DOCS_DATABASE_ID` secret via `ntn workers secrets set` if the DB ID changed. Remove the suppression entry from Known Noisy Signals after 3 clean runs.

### 2B. P0 — Database Naming Collision (Dev vs Agent Infrastructure)

This is the structural finding from the audit that has the most downstream impact. Three database names are used by both the dev environment and the agent infrastructure:

| Database | Lives In | Purpose |
|----------|----------|---------|
| `Setup Templates` (46 items) | AI Agent - Dev Environment Setup | Software project scaffolding |
| `Agent Skills` (28 items) | AI Agent - Dev Environment Setup | Repeatable dev workflows |
| `Prompt Library` (15 items) | AI Agent - Dev Environment Setup | Dev/code prompts |
| `Prompt Library` (in Hub) | Custom Agents Hub | Notion agent prompt blocks |
| `Agent Skills` (linked view) | Custom Agents Hub sidebar | Points to dev-side DB |

Anyone navigating Custom Agents Hub → Prompt Library lands in coding prompts, not Notion agent prompts. The sidebar conflates both systems.

**Workers impact:** Currently minimal — workers reference databases by ID, not name. But any agent instruction that says "check the Prompt Library" is ambiguous, and human operators navigating the Hub will be confused.

**Fix (pick one):**

- **Option A (rename dev-side):** Rename to `Dev: Setup Templates`, `Dev: Agent Skills`, `Dev: Prompt Library`. Clean separation.
- **Option B (remove linked views):** Remove the three linked views from the Abstract Data sidebar. They belong to the dev environment hub.
- **Either way:** Rename the Notion agent Prompt Library to `Agent Prompt Library` or `Notion Agent Prompts` for clarity.

### 2C. P1 — VEP Weekly Reporter + GitHub Insyncerator Instructions in Trash

The Custom Agents Hub agent list shows both instruction pages are **in Trash**. Both agents are running on cached/embedded instruction copies only — instruction editing is impossible until restored.

**Workers impact:** No direct worker code impact, but if you need to update these agents' instructions (e.g., to fix the GitHub PAT issue or adjust VEP outputs), you can't until you restore the pages.

**Action:** Go to Trash in Notion, restore both pages immediately. Verify agent instruction panels match the restored pages.

### 2D. P1 — GitHub Insyncerator PAT Issue

`❌ Failed` on March 13, suppressed as "known PAT scope/rate-limit" in Known Noisy Signals. The suppression is masking a real infrastructure issue — GitHub Items database isn't being synced, which cascades to Client Repo Auditor (stale data) and Time Log Auditor (no PR-based time stubs via `sync-time-log`).

**Action:** Rotate the GitHub PAT (`GITHUB_TOKEN` secret). Verify scopes: `repo`, `read:org`. Run `sync-github-items` manually via worker test. Un-suppress in Known Noisy Signals after 3 consecutive clean runs.

### 2E. P1 — Fleet Ops Agent Failed Today

Scheduled 9:30AM trigger — failed. The Control Plane fleet table isn't being updated, dead letters aren't being auto-resolved, and the daily health check isn't happening. This cascades to Morning Briefing (no fleet status to consolidate).

**Action:** @mention Fleet Ops Agent for manual re-run. If it fails again, check its worker tool access — specifically verify it can call `monitor-fleet-status`, `check-agent-staleness`, `resolve-stale-dead-letters`, and `validate-database-references`.

### 2F. P2 — Workers Details Page: Three Stale Entries

The Notion Workers Details page has three documentation errors:

1. Lists `reconcile-github-items` — should be `sync-github-items` (renamed during development)
2. Missing `sync-time-log` entirely — a deployed, registered worker used by Time Log Auditor
3. Says `archive-old-digests` enforces "90-day retention" — code and Control Plane updated to **30 days** on March 13

**Action:** Update all three entries on the Workers Details page.

### 2G. P2 — Client Briefing Agent: Trigger Contradiction

Instructions say "Trigger mode: Mention-only (daily poll disabled)" but the Daily at 7AM toggle is enabled in agent settings. Recent activity shows it firing daily at 7AM.

**Workers impact:** No code issue — workers don't care about triggers. But if mention-only is the intended behavior, you're burning credits on daily runs that may produce only heartbeats.

**Action:** Decide: if daily is correct (seems likely given it's in `AGENT_CADENCE` as `"daily"`), update the instruction page status note. If mention-only was intentional, disable the 7AM trigger.

### 2H. P2 — Client Briefing Agent: GitHub Write Tools Enabled

Has GitHub MCP connected with 19 write tools set to "Always ask." A briefing agent has zero reason to write to GitHub.

**Action:** Remove all GitHub write tools from Client Briefing Agent. Keep only Notion database read access to GitHub Items.

### 2I. P2 — Personal Ops Manager: Over-Broad Calendar Access

Has 3 calendar accounts, 9 calendars, all at Read+Write. A triage agent reading Deliveries, 9009 N FM 620, and Unfiled calendars adds no value and broadens the blast radius.

**Action:** Downgrade all calendars to Read-only except Personal (if you want it to create reminders). Remove Deliveries, Unfiled, and 9009 N FM 620 entirely.

### 2J. P2 — Response Drafter: Mail Permission Over-Scope

Has "Read, modify inbox, draft and send" for je@abstractdata.io. Instructions explicitly say "Never send. Draft only." This is a platform constraint (Notion doesn't offer a draft-only mail scope), not a config error.

**Action:** Document this explicitly in the Governance doc as a known over-permission with the compensating control being the instruction guardrail and the `[DRAFT — Review before sending]` subject prefix. This way Drift Watcher and human audits know it's intentional.

### 2K. P3 — Dual Instruction Storage (Settings Panel + Separate Pages)

Every agent has instructions embedded inline in agent settings AND a separate "— Instructions" page linked in the Custom Agents Hub. The Drift Watcher exists specifically to detect when these drift apart — a workaround for an underlying structural problem.

**Workers impact:** Workers don't care which copy is "real" — they operate on the executed instructions (the settings panel). But human maintenance costs double, and the Drift Watcher generates noise when they diverge.

**Recommendation:** The inline agent instructions panel is the executed source of truth. Add a banner to each separate page: "This is a reference snapshot — edit the live agent settings panel, not this page." Alternatively, turn the separate pages into auto-generated exports (a future worker could do this).

### 2L. P3 — Private Sidebar Clutter

Four system notification pages, `Random Docs`, and `Agent Skills and Setup Templates Review` are cluttering the Private sidebar. No agents access them.

**Action:** For actionable notifications, create Tasks and delete the pages. Move the review document into Docs database with proper metadata. Delete everything else.

---

## 3. Custom Agent Instruction Adjustments

### 3A. Morning Briefing — Missing Response Layer Digest Patterns

The "What to consolidate" section lists digest title prefixes but doesn't include:

- `Response Drafter —` / `Draft Status —` (code patterns: `["Response Drafter", "Draft Status"]`)
- `Client Briefing —` (code pattern: `["Client Briefing"]`)

The system map shows both feeding into Morning Briefing (`RD --> MB`, `CBA --> MB`), but the briefing can't find their digests without the title patterns.

**Fix:** Add to Morning Briefing's discovery list:
```
Response Drafter — / Response Drafter ERROR —
Draft Status — / Draft Status ERROR —
Client Briefing — / Client Briefing ERROR —
```

Also add both to the "Expected schedule" section as daily agents so missing runs get flagged.

### 3B. Governance Doc — Missing Worker Tools

Section 2 lists worker tools but is missing three that agents actively use:

- `sync-time-log` (Time & billing) — used by Time Log Auditor
- `check-agent-staleness` (Fleet / ops) — used by Fleet Ops Agent
- `sync-github-items` (Data reconciliation) — used by GitHub Insyncerator

**Action:** Add all three to the Governance doc's worker tools section.

### 3C. Governance Doc — Document Mail Over-Permission

Per §2J above, add a "Known over-permissions" subsection to Section 7 (Approved write targets):

> **Response Drafter — Notion Mail:** Has full send permission because Notion does not offer a draft-only mail scope. Compensating control: instruction guardrail ("Never send. Draft only.") + required `[DRAFT — Review before sending]` subject prefix. Any violation should be treated as a P0 incident.

### 3D. Stale "Last Human Review" Dates

Two instruction pages show `Last Human Review: 2025-02-26` (should be 2026):

- Fleet Ops Agent — Instructions
- Response Drafter — Instructions

**Fix:** Update to `2026-02-26` or to today's date.

### 3E. Cadence Labels: Docs Librarian

Hub table says "Weekly | Monthly." Control Plane says "Bi-weekly + Monthly." `agent-config.ts` says `"biweekly"`.

**Fix:** Update the Hub table to "Bi-weekly + Monthly" to match the code and Control Plane.

### 3F. Drift Watcher Cadence Labels

Hub table says "Bi-weekly." Hub optional index says "Weekly." Control Plane says "Weekly (Mon)." Morning Briefing says "Every Monday (weekly)." `agent-config.ts` says `"biweekly"`.

**Fix (two-sided):** If the real cadence is weekly (which 3 of 4 sources say), update `agent-config.ts` to `"weekly"` (see §1D) AND update the Hub table from "Bi-weekly" to "Weekly."

### 3G. Project Descriptions — Silent Quality Degradation

11 of 14 active projects have no Description. Client Briefing Agent, VEP Weekly Reporter, and Client Health Scorecard all reference project descriptions for context. Empty descriptions silently degrade output quality with no error signal.

**Action:** This isn't an instruction change, but it's worth noting: `validate-project-completeness` (worker #14) already catches this. Consider having Fleet Ops call it on a weekly basis and surface the results in its digest. The missing descriptions should be filled for: vep-match-fast, Voter File Audit Package, v0 Website Rebuild, QR Podcast Splash Site, VEP Phone Bank App.

Also: vep-validation-tools has a Start Date of February 5, 2022 — almost certainly wrong and will affect any time-based agent logic.

### 3H. Tasks Workflow — Not Being Used

Every task shows "Not started" status. Agents create tasks correctly (Inbox Manager, Response Drafter), but status never transitions. This isn't an instruction change, but it means agent-created tasks sit indefinitely without follow-through, which undermines the value of the whole task-creation workflow.

**Recommendation:** Add a Notion automation: if Due Date arrives and Status is still "Not started," transition to "In Progress" (as a nudge). Or make this part of Morning Briefing's scope — it already surfaces items for decision.

---

## Consolidated Priority Table

| Priority | Item | Category | Effort | Impact |
|----------|------|----------|--------|--------|
| **P0** | Home Docs database inaccessible | Notion Config | 10 min | Unblocks 2 agents |
| **P0** | Agent name mismatch in code ("Home & Life Watcher") | Workers Code | 5 min + deploy | Prevents silent worker failures |
| **P0** | Database naming collision (Dev vs Agent) | Notion Config | 15 min | Eliminates navigation confusion |
| **P1** | Restore VEP + GitHub Insyncerator instructions from Trash | Notion Config | 2 min | Enables instruction editing |
| **P1** | GitHub PAT rotation | Notion Config | 15 min | Unblocks 3 downstream agents |
| **P1** | Fleet Ops Agent re-run | Notion Config | 5 min | Restores daily visibility |
| **P1** | Meeting Prep Agent: suspend + disable trigger | Workers Code + Notion | 5 min + deploy | Stops credit waste |
| **P1** | Morning Briefing: add Response Layer digest patterns | Agent Instructions | 10 min | Prevents blind spots |
| **P1** | Drift Watcher cadence: code + Hub alignment | Workers Code + Notion | 5 min + deploy | Correct staleness detection |
| **P2** | Workers Details page: 3 stale entries | Notion Config | 10 min | Documentation accuracy |
| **P2** | Client Briefing Agent: trigger + permissions | Notion Config | 10 min | Permission hygiene |
| **P2** | Personal Ops Manager: calendar scope | Notion Config | 5 min | Blast radius reduction |
| **P2** | Governance doc: add missing tools + mail note | Agent Instructions | 15 min | Completeness |
| **P2** | Zombie `reconcile-github-items.js` in dist/ | Workers Code | 2 min | Clean build artifacts |
| **P2** | Stale review dates on 2 instruction pages | Agent Instructions | 2 min | Housekeeping |
| **P2** | Cadence labels (Docs Librarian, Drift Watcher) | Agent Instructions | 5 min | Consistency |
| **P3** | Project descriptions (11 of 14 missing) | Notion Data | 30 min | Agent output quality |
| **P3** | Tasks workflow (no status transitions) | Notion Config | 10 min | Follow-through |
| **P3** | Private sidebar cleanup | Notion Config | 10 min | Workspace hygiene |
| **P3** | Dual instruction storage resolution | Agent Instructions | Decision | Maintenance cost |

---

## What Does NOT Need to Change

- **Worker tool logic:** All 21 registered workers are correctly implemented. Governance rules, validation, error handling — all solid.
- **Governance doc structure:** Sections 1-9 are well-organized; policies are sound.
- **Dead Letters + Fleet Ops self-healing pattern:** Production-grade.
- **Label Registry routing:** Declarative email routing is the right pattern.
- **Credit Forecast tracking:** Updated March 13 estimates are accurate.
- **Upstream gating pattern:** Response Drafter → Inbox Manager dependency chain works correctly.
- **Inbox Manager ↔ Personal Ops scope split:** je@abstractdata.io vs johnreakin@gmail.com cleanly separated.
- **The Enterprise isolation:** No agents, no automations — correct.
- **Hub organization:** Routing guide, golden paths, source-of-truth index — all exactly right.

---

## Recommended Execution Order

If tackling these in sequence, this order minimizes cascading failures:

1. **Restore instruction pages from Trash** (VEP + GitHub Insyncerator) — unblocks editing
2. **Fix agent name in code** ("Home & Life Task Watcher") + add Meeting Prep to SUSPENDED + fix Drift Watcher cadence → single deploy
3. **Reconnect Home Docs database** + update `HOME_DOCS_DATABASE_ID` if needed
4. **Rotate GitHub PAT** + test `sync-github-items` manually
5. **Trigger Fleet Ops + Morning Briefing** re-runs
6. **Update Morning Briefing instructions** (add Response Layer patterns + expected schedule)
7. **Rename dev-side databases** to resolve naming collision
8. Everything else in priority order
