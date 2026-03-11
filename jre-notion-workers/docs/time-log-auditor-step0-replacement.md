# Time Log Auditor — Step 0 Replacement Content

> Apply this to BOTH copies:
> - Primary: https://www.notion.so/0e57d7f56298820a9bc701ffc6070b03
> - Secondary: https://www.notion.so/c2a7d7f562988299975f01d3ccc84289

---

## REPLACE: Step 0 section

Delete everything from `### 0. Time stub generation from GitHub PRs (estimate-first)` through the report additions bullets (ending before `## 🔍 What to Audit` / `### 1. Missing time entries`).

Replace with:

---

### 0. Time stub generation from GitHub activity (estimate-first)

- **Goal:** Automatically create and maintain Time Log entries for all trackable GitHub activity — issues and PRs — so John never has to manually log development hours.
- **Source of truth:** GitHub Items database (collection://8c8a07b9-8ac9-45fb-8572-9bfc2cf3a18e).
- **Time window:** Past 7 days (rolling), based on the GitHub Item's Created or Updated date.
- **Trigger events** (process all three in this order):

#### A. New Issues (Type = Issue, Created within window)

For each new Issue in GitHub Items:

1. Check for existing Time Log entry where GitHub Item relation contains this issue.
2. If none exists, create a new Time Log entry:
   - Description: `[EST] Issue: [Title] (#[GitHub Number]) — [Repo]`
   - Date: GitHub Item Created date
   - GitHub Item: relate to the GitHub Item row
   - Client: copy from GitHub Item Client relation (if present)
   - Project: copy from GitHub Item Project relation (if present)
   - Task: copy from GitHub Item Task relation (if set)
   - Hours: call **estimate-github-hours** worker with `type: "issue"`. Populate with the returned `estimatedHours`. If the worker returns `success: false`, use the coarse rubric as fallback and note the error in the report.
   - Billable: true only when Project is set AND Project Type is Retainer or Hourly; otherwise false
3. Confidence from the worker determines the `[EST]` prefix:
   - low confidence → `[EST-LOW]`
   - medium confidence → `[EST]`
   - high confidence → `[EST]`

#### B. New PRs (Type = PR, Created within window, Status = Open or In Progress)

For each new PR in GitHub Items:

1. Check if a Time Log entry already exists for a linked issue (via GitHub Item relations or matching title/branch patterns). If yes, **update** that entry rather than creating a new one:
   - Update Description to: `[EST] PR: [Title] (#[GitHub Number]) — [Repo]`
   - Update Hours with the new estimate from **estimate-github-hours** worker with `type: "pr"`
   - Keep all other fields (Client, Project, Task) — don't overwrite with blanks
2. If no linked issue entry exists, create a new Time Log entry with the same field mapping as Issues above, but:
   - Description: `[EST] PR: [Title] (#[GitHub Number]) — [Repo]`
   - Hours: call **estimate-github-hours** with `type: "pr"`

#### C. Merged PRs (Type = PR, Status = Merged, Updated within window)

For each merged PR:

1. Find the existing Time Log entry (by GitHub Item relation).
2. If found:
   - Update Description prefix from `[EST]` or `[EST-LOW]` to `[EST-FINAL]`
   - Re-estimate hours using **estimate-github-hours** with `type: "pr"` (merged PRs have final diff stats)
   - Update Hours with the final estimate
   - Update Date to the merge date (GitHub Item Updated date)
3. If no existing entry (edge case — PR was created before we started tracking):
   - Create a new entry with `[EST-FINAL]` prefix using the same field mapping

- **Deduplication rules:**
  - One Time Log entry per unit of work (issue → PR → merge is one entry, refined over time)
  - Matching rule: existing Time Log row where GitHub Item relation contains this item
  - When an issue and its PR both exist, the PR entry supersedes the issue entry (update, don't duplicate)
  - Never create two Time Log entries for the same GitHub Item

- **Missing data handling:**
  - If Client and Project are both missing on the GitHub Item, still create the stub but flag it in the report as "Needs mapping"
  - Never guess Client or Project
  - If **estimate-github-hours** worker fails, fall back to the coarse rubric:
    - documentation: 0.5h
    - bug: 2h
    - feature/enhancement: 5h
    - unknown/no labels: 2h
    - Prefix with `[EST-FALLBACK]` instead of `[EST]`

- **Report section** (title: **GitHub Activity → Time Log**):
  - Issues processed: count (new stubs created / skipped)
  - PRs processed: count (new stubs / updated from issue / skipped)
  - Merged PRs finalized: count
  - Items using fallback estimates: list (worker call failed)
  - Items missing Client/Project mapping: list
  - Total estimated hours generated this week: sum

---

## REPLACE: Guardrails section

Delete the entire `## 🚫 Guardrails` section and replace with:

---

## 🚫 Guardrails

- You may **create new** Time Log entries for any GitHub activity (issues and PRs) as described in Step 0.
- You may **update** existing Time Log entries that have an `[EST]`, `[EST-LOW]`, or `[EST-FALLBACK]` prefix — specifically: Description, Hours, and Date — when a PR is created for a tracked issue or when a PR is merged. Never update entries that John has manually edited (entries without an `[EST*]` prefix).
- Never **delete** Time Log entries.
- Never create or delete tasks — flag only.
- If retainer budget data is unavailable for a client, note it as `Budget: unknown` and skip the percentage calculation.
