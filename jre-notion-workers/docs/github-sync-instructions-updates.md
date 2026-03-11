# GitHub Sync Instructions — Required Updates

These edits add JREakin (personal user account) alongside Abstract-Data (org) so the
GitHub Insyncerator scans both sources. Apply these to **both** copies of the page:

- Primary: https://www.notion.so/f207d7f562988341bd840160d9e387e8
- Secondary: https://www.notion.so/a047d7f5629883a297fe0162c8340e75

---

## Change 1 — Sync scope section

### FIND:
```
### 🔍 Sync scope (what to pull)
Sync **every repository** in the GitHub organization:
- `Abstract-Data`
For each repo in the org, include:
```

### REPLACE WITH:
```
### 🔍 Sync scope (what to pull)
Sync **every repository** across these GitHub sources:
- `Abstract-Data` (organization)
- `JREakin` (personal user account)
For each repo across all sources, include:
```

---

## Change 2 — Repo field mapping

### FIND:
```
- **Repo**: full repo name like `Abstract-Data/<repo>`
```

### REPLACE WITH:
```
- **Repo**: full repo name like `Abstract-Data/<repo>` or `JREakin/<repo>`
```

---

## Change 3 — Sync behavior step 1

### FIND:
```
1. List all repositories in the `Abstract-Data` org (excluding archived; excluding forks by default).
```

### REPLACE WITH:
```
1. List all repositories from each configured source — `Abstract-Data` (org) and `JREakin` (user) — excluding archived and excluding forks by default.
```

---

## Change 4 (optional) — Troubleshooting step 1

### FIND:
```
- Ensure you iterate *all* org repos (excluding archived, excluding forks by default).
```

### REPLACE WITH:
```
- Ensure you iterate *all* repos from every configured source (excluding archived, excluding forks by default).
```

---

That's it — 3 required changes plus 1 optional tweak per page.
The Implementation Notes page (`1e6ccf5c29e7479eb03986c4b4bf863b`) was already
updated via MCP successfully.
