# NEXT-STEPS.md — Post-Audit Action Items
> Generated: 2026-03-11 | Audit performed via Perplexity Computer + Notion MCP
> Status at time of writing: repo is up to date, workers deployed, documentation clean.

---

## P0 — Fix today (both block active agents)

### 1. Home Docs Database inaccessible
**Impact:** Personal Ops Manager and Home & Life Task Watcher are both showing `❌ Missing / inaccessible` in the Control Plane fleet status table. Neither agent can write digests.

**Root cause:** Database `d125ed60-c250-48e2-a3ff-724cd952f5be` is either not shared with the Notion integration token, or was recreated under a new ID.

**Fix (try in order):**

**Option A — Re-share the existing DB with the integration:**
1. Open Notion → find the Home Docs database (`d125ed60`)
2. Click `...` → `Connections` → add your integration
3. Run `validate-database-references` via Fleet Ops Agent to confirm it resolves

**Option B — DB was recreated, update the secret:**
```bash
# Get the new DB ID from Notion (open the DB, copy URL, extract the UUID)
ntn workers secrets set HOME_DOCS_DATABASE_ID=<new-id>
```
Then update `.env.1p` or your 1Password Environment entry to match.

**Verify fix:**
After fixing, @mention Fleet Ops Agent on any page to trigger an on-demand run. Confirm both agents appear as `Active` with a fresh run time in the Control Plane fleet table within the next scheduled cycle.

---

### 2. GitHub Insyncerator persistent failures
**Impact:** Dead letters accumulating, Client Repo Auditor running on stale data, time stubs not being auto-generated from merged PRs.

**Diagnosis steps:**
1. Open [Dead Letters](https://www.notion.so/7f952f5edbf04437b6eee738b77f8937) → filter `Agent = GitHub Insyncerator`, `Resolution Status = Open`
2. Read the `Notes` field on the most recent record — the error message will be there
3. Cross-check the most recent GitHub Sync digest in Docs for the actual failure line

**Common causes and fixes:**

| Symptom in dead letter | Fix |
|---|---|
| `401 Unauthorized` | GitHub PAT expired — rotate in 1Password, update `GITHUB_TOKEN` secret via `ntn workers secrets set GITHUB_TOKEN=<new>` |
| `404 Not Found` on org | Org name changed or PAT lost org access — verify `Abstract-Data` org membership and PAT scopes (`repo`, `read:org`) |
| `ETIMEDOUT` / rate limit | Transient — @mention the agent to re-run; if recurring, add delay logic in `sync-github-items.ts` |
| Partial sync / upsert failures | Check the `Fix GitHub Sync — YYYY-MM-DD` task linked in the dead letter for specifics |

**After fixing:** @mention GitHub Insyncerator for an on-demand run. Confirm `Sync Status: ✅ Complete` in the new digest. Fleet Ops Agent will auto-resolve the stale dead letters on its next daily run via `resolve-stale-dead-letters`.

---

## P1 — System map Mermaid block (manual Notion edit)
**Why it can't be automated:** The system map is a synced block. The Notion API does not support editing synced block source content programmatically.

**What's missing:** Response Drafter (`RD`) and Client Briefing Agent (`CBA`) nodes are referenced in the edge definitions but have no subgraph/node declarations.

**How to fix:**
1. Open [Custom agents managing document metadata](https://www.notion.so/3127d7f562988025a990f1f240bfe2e0)
2. Find the Mermaid code block (the system map)
3. After the `subgraph "Scorecards"` block and before `subgraph "Consolidation"`, insert:

```
    subgraph "Response Layer"
        RD["✍️ Response Drafter<br>(Notion Mail + Workers)"]
        CBA["📋 Client Briefing Agent<br>(Notion Calendar + Workers)"]
    end
```

The edges already exist (`IM --> RD`, `RD --> MB`, `CBA --> MB`, `CHS --> RD`) — you're just adding the node declarations so Mermaid renders them correctly instead of auto-generating unstyled nodes.

This synced block is shared between the Hub and the design/rationale doc — one edit fixes both places.

---

## Completed (no action needed)

| Item | Status |
|---|---|
| Hub integrations list (Morning Briefing, Response Drafter, Client Briefing Agent) | ✅ Already present |
| Design/rationale doc agent count (11 → 15) | ✅ Already says 15-agent ecosystem |
| Worker repo — 12 missing workers built and registered | ✅ Committed to `main` |
| Workers deployed | ✅ `b3cb6b8 feat: deploy jre-notion-workers` |
| TypeScript check | ✅ `tsc --noEmit` passes clean |
| Hub worker tools reference (single source of truth) | ✅ Links to Workers Details page |
| Governance doc section numbering | ✅ Sections 1–9 correct |
| Credit Forecast table | ✅ Updated 2026-03-13 (IM 90→60, RD 60→30 runs/mo) |
| Control Plane change log | ✅ Current through 2026-03-13 |
| Digest retention threshold | ✅ Updated 90→30 days (code + Control Plane) |
| Workers audit remediation (March 13) | ✅ ActionsTaken.auto_closed_by_pr, circuit breaker PR fix, open_only sync, DetectedBy expanded |
| Fleet Monitor status | ✅ Deprecated — merged into Fleet Ops Agent (prompt page retained as historical reference) |

---

## For the agent running this file

If you are a Cursor agent or similar running in the `jre-notion-workers` project directory:

1. **Do not modify any worker source files** unless explicitly instructed — the fleet is deployed and production workers are live.
2. **P0 fixes require secrets** — use `op run` or the 1Password-mounted `.env` per the README credential setup.
3. **To verify Home Docs fix:** run `bun run test:connection` after updating secrets to confirm all DB IDs resolve before redeploying.
4. **To redeploy after any source change:** `npm run build && ntn workers deploy` — always run `npm run check` first.
5. **After fixing GitHub Insyncerator:** do not manually close dead letters — Fleet Ops Agent will auto-resolve via `resolve-stale-dead-letters` on its next run.
6. **Mermaid block edit** is a Notion UI operation only — do not attempt via API or MCP.
