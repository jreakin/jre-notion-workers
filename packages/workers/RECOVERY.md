# RECOVERY.md — recovered canonical worker generation

> **⛔ DO NOT RUN `ntn workers deploy` FROM ANYWHERE IN THIS REPO UNTIL THE RECOVERY IS COMPLETE.**
> Worker `019cc6cd-60d7-769c-b5e9-ecf1de02fbf3` is currently serving the second-generation
> build. Deploying a partial tree replaces the entire worker bundle, and Notion Workers have
> **no versioning and no rollback** — redeploying prior source is the only rollback, and that
> source is exactly what is missing.

## What happened

This repository contained two divergent generations of the worker project:

| | `jre-notion-workers/` (nested) | root `dist/` |
|---|---|---|
| Tools | 33 | 34 + 1 webhook + 2 syncs + 2 managed DBs |
| TypeScript source | present | **never committed — does not exist** |
| `@notionhq/client` | 2.3.0 | **5.21.0** |
| Notion API version | unpinned → defaults to **2022-06-28** | pinned **2026-03-11** |
| Query path | `notion.databases.query` (25 call sites) | `dataSources.query` via `resolveDataSourceId` |
| `@notionhq/workers` | 0.1.0 | **0.4.0** |
| Deployed? | no | **yes — this is what is live** |

The root build is therefore not stale cruft and not a side branch of extra features. It is
the **Notion API 2026-03-11 migration itself**, plus a Zoho One integration, a plan webhook,
a scheduler, inbox routing and autofill workers — and it exists only as compiled JavaScript.
It was committed at `d37ba9e`; `git log --all -- 'src/'` confirms the root `src/` tree was
never tracked.

Because `tsc` preserves comments, every JSDoc block survived compilation, which makes the
output recoverable by transcription plus restoring type annotations rather than by guesswork.

## Recovery method and fidelity guarantee

Each file was reconstructed from its compiled counterpart under a strict rule: **reproduce
runtime behaviour exactly.** Same control flow, iteration order, defaults, error messages,
and `console.log` strings including emoji and `[tag]` prefixes. Nothing was refactored,
renamed, or "fixed" — bugs found during recovery are catalogued below, deliberately
unchanged.

Fidelity is then *proven mechanically*: recompiling the recovered TypeScript and comparing
the emitted JavaScript against the original `dist/` file, normalised for comments, trailing
commas and whitespace, must be **token-identical**.

```
npm run verify:fidelity
```

Current status — **6/6 token-identical**, `tsc --noEmit` clean under `strict` +
`noUncheckedIndexedAccess`:

| Recovered file | LOC | Fidelity |
|---|---:|---|
| `src/shared/notion-client.ts` | 376 | ✓ token-identical |
| `src/shared/zoho-client.ts` | 265 | ✓ token-identical |
| `src/shared/time-log-relations.ts` | 460 | ✓ token-identical |
| `src/workers/sync-zoho-projects.ts` | 382 | ✓ token-identical |
| `src/workers/sync-crm-accounts.ts` | 241 | ✓ token-identical |
| `src/workers/sync-hours-by-client.ts` | 456 | ✓ token-identical |

`src/shared/types.ts` has no compiled counterpart to compare against — TypeScript erases
type-only modules, so `dist/shared/types.js` is 124 bytes of nothing. Its contents are
reconstructed from the tool registration schemas in `dist/index.js` and from each worker's
observed property access, and are therefore the one part of this recovery that is *inferred*
rather than *proven*.

## Still to recover

Nine tools and seven shared modules remain sourceless. In dependency order:

**Blocked on `write-agent-digest` being ported to the 2026-03-11 shared layer:**
- `audit-time-log` (263 lines) — imports `write-agent-digest` and `time-log-relations` (done)
- `run-fleet-ops-daily` (109) — orchestrates monitor-fleet-status → resolve-stale-dead-letters → calculate-credit-forecast
- `audit-dev-environment` (211)
- `compose-morning-briefing` (163)

**Independent:**
- `label-github-prs` (291), `route-inbox` (144) + `shared/inbox-rules` (148)
- `autofill-task-clients` (135), `autofill-task-priority` (200), `autofill-docs-projects` (10), `autofill-meeting-dates` (10) + `shared/autofill-rules` (168)
- `shared/notion-preflight` (204), `shared/fleet-baselines` (36), `shared/github-url` (29), `shared/plan-content-hash` (40)
- `workers/scheduler` (215) and `workers/plan-webhook` (403) — these register `worker.sync()` / `worker.webhook()` capabilities, which `@notionhq/workers@0.4.0` already provides (verified: `tool`, `sync`, `webhook`, `database`, `oauth`, `pacer`, `automation`, `run`, `aiConnector`)
- `workers/sync-github-repos` (561) — registers `worker.database()` + `worker.sync()`

**Also required:** the 21 tools that exist in *both* generations must be ported forward from
the nested tree onto this shared layer, migrating their 25 `notion.databases.query` call
sites to `queryAllDatabase` / `queryDatabase`.

## Dependency pins are evidence, not guesses

The canonical generation left its own `node_modules` at the repo root alongside its `dist/`.
Reading versions out of it gives the exact toolchain the live build was compiled against:
`@notionhq/client@5.21.0`, `@notionhq/workers@0.4.0`, `typescript@5.9.3`, `esbuild@0.27.4`,
`ntn@0.13.2`. `package.json` pins those, and fidelity is verified against them.

`0.4.0` already exposes every capability the canonical `index.ts` registers, so the
`@notionhq/workers` 0.8.3 upgrade is a genuinely separate, optional PR — not a prerequisite.

## Environment variables this generation needs

Sixteen variables absent from the nested `.env.example`. Values for several are in the
untracked root `.env`; all of them must end up in the 1Password Environment
(`i6ul2k6tk5kzyszv465wzhdpnu`) and in `WORKER_ENV_KEYS` in `scripts/deploy.sh`, or the
deploy silently drops them.

```
ZOHO_CLIENT_ID  ZOHO_CLIENT_SECRET  ZOHO_REFRESH_TOKEN  ZOHO_API_BASE_URL
ZOHO_PROJECTS_API_BASE_URL  ZOHO_PROJECTS_PORTAL_ID
PLANS_DATABASE_ID  PLANS_DATA_SOURCE_ID  PLAN_WEBHOOK_SECRET  SUBMISSIONS_DATA_SOURCE_ID
GITHUB_ABSTRACT_TOKEN  GITHUB_ITEMS_SYNC_DATABASE_ID  GITHUB_PRS_SYNC_DATABASE_ID
AGENT_SKILLS_DATABASE_ID  REFERENCE_DOCS_DATABASE_ID  SETUP_TEMPLATES_DATABASE_ID
```

`AGENT_OPS_DATABASE_ID` and `CLIENT_SHARED_DOCUMENTS_DATABASE_ID` are pushed by
`scripts/deploy.sh` but missing from `.env.1p` — confirm against `ntn workers env pull`.

## Bugs found during recovery — catalogued, NOT fixed

Recovery fidelity required leaving these alone. Each is a candidate for a separate,
reviewable follow-up commit.

### `sync-crm-accounts`
1. **False green.** `success = errors.length === 0 || (created + updated) > 0` — the `||`
   makes a run report `success: true` whenever any page was written, even if *every* CRM
   write-back failed and `errors` is full. Since the Notion write happens before the
   `zohoPatch`, a run with a revoked Zoho token still reads as green in the digest.
2. In dry-run mode `crm_patched` is incremented although no CRM PUT is attempted.
3. `Description` is selected in the COQL projection but never mapped; `Notion_Client_ID` is
   selected but never read.

### `sync-hours-by-client`
4. **`entry_count` double-counts multi-client rows.** Hours are split evenly across clients
   (`row.hours / row.clientIds.length`) but `entryCount++` fires once per client link, so
   per-client counts can sum above `total_entries_scanned`.
5. **Only the first project on a row is used** (`row.projectIds[0]`) — hours for projects
   2..n are silently attributed to project 1. Multi-client splitting has no multi-project
   equivalent.
6. Compounded rounding: totals reduce over already-`round2`-ed per-client values, then get
   rounded again. Cent-level drift.
7. Timezone-dependent cutoff — `cutoff.setDate()` mutates in local time, then the result is
   `toISOString()`-sliced to a date, so the lookback window can land a day early or late.
8. `Notion-Version` is a **hardcoded** `"2026-03-11"` string literal in the raw markdown-API
   call, duplicating `NOTION_API_VERSION`. It will drift silently when the constant is bumped.
9. `esc()` does not escape `-` or `_`, yet the static unlinked-hours bullet hand-escapes them
   — names containing those characters are escaped inconsistently with the static copy.
10. A negative `default_rate_per_hour` is silently coerced to `null` by the `> 0` test.

### `sync-zoho-projects`
11. **`page.properties` dereferenced without an `isFullPage` guard.** If Notion returns a
    partial page object the property getters throw `TypeError`, and because the throw is
    caught by the outer `try` the *whole run* aborts with `success: false` rather than
    skipping one row.
12. `max_projects` is applied client-side *after* full pagination, so `max_projects: 1` still
    pulls the entire Projects database.
13. The `budgetDollars` argument is ignored for `Retainer`/`Hourly`, so a Retainer project
    with a Budget but no Hourly Rate Override syncs with no amount at all — the JSDoc
    describes a fallback that was never implemented.
14. De-dup keys on `zohoName` while results report `notion_name`, so two Notion projects
    sharing an External Project Name silently update the same Zoho project twice and both
    report `updated`.
15. Status filter uses `select: { equals: … }`; if the Projects `Status` property is a
    `status` type rather than `select`, the query errors.

### `time-log-relations`
16. **Only the first source page is consulted** (`githubItemIds[0]`, `taskIds[0]`) — relations
    available on the 2nd+ linked GitHub Item or Task are never inherited.
17. `stillUnlinkedIds` is recorded from *resolution*, not from the write: an entry whose write
    is skipped still counts as linked, and entries skipped by the cap/deadline are counted in
    `remaining` but never appear in `stillUnlinkedIds` — the two counters describe different
    populations.
18. `readTitle` reads `"Title"` then `"Name"`, but an empty-but-present `Title` (`title: []`)
    yields `""` instead of falling through, because `??` only falls through on null/undefined.
19. The deadline is checked once per entry *before* work, so a single entry's three sequential
    reads plus a write can overrun `deadlineMs`. Best-effort, not a hard bound.
20. A throwing entry increments `errors` but is silently dropped from `stillUnlinkedIds`.

### Pre-existing, in the nested generation (not part of this recovery)
21. `check-agent-staleness` filters on title property `"Name"` unconditionally, but the
    home_docs database uses `"Doc"` — so both home-docs agents always report stale and get
    spurious Dead Letters filed. Its `dry_run` also defaults to `false`, so it **writes by
    default**.
22. `monitor-fleet-status` computes staleness from page `created_time` while
    `check-agent-staleness` uses the parsed `Run Time:` line — two definitions of "stale"
    that disagree.
