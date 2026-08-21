# GitHub Environment — Notion Worker Secrets Sync

This repo syncs **production** Notion Worker environment variables from 1Password to the hosted worker using `ntn workers env push`. New keys are added; changed values are updated. Keys that exist only in Notion are not removed.

## What runs where

| Context | Tool | Auth |
|--------|------|------|
| **GitHub Actions** | `.github/workflows/sync-notion-secrets.yml` | `OP_SERVICE_ACCOUNT_TOKEN` + `NOTION_API_TOKEN` |
| **Maintainer laptop** | `bash scripts/sync-notion-worker-secrets.sh` | `op` CLI + `NOTION_API_TOKEN` (or `ntn login`) |
| **Worker runtime** | Notion-hosted worker | `NTN_API_TOKEN` and `*_DATABASE_ID` from worker env |

**Important:** `NOTION_API_TOKEN` is a Notion **personal access token** for the `ntn` CLI. `NTN_API_TOKEN` on the worker is the **integration token** workers read at runtime — different credentials, often stored in the same 1Password item.

## One-time GitHub setup

### 1. Create GitHub Environment

In GitHub: **Settings → Environments → New environment**

- Name: `notion-workers-production` (must match the workflow `environment:` value)

Optional but recommended:

- Required reviewers before sync runs
- Deployment branch rule: `main` only

### 2. Add environment secrets

| Secret | Purpose |
|--------|---------|
| `OP_SERVICE_ACCOUNT_TOKEN` | 1Password service account with read access to vault `Dev` (or your vault) and item `JRE Notion Workers - API Credentials` |
| `NOTION_API_TOKEN` | Notion PAT with Workers deploy/manage permission for workspace `c0b7d7f5-6298-81dd-8aad-0003d8ccc420` |

Create the PAT in [Notion Developer → Personal access tokens](https://www.notion.so/my-integrations).

### 3. 1Password item fields

Ensure item **JRE Notion Workers - API Credentials** (vault **Dev**) has fields matching `scripts/worker-env-keys.txt`. References live in `.env.1p`.

Add any new worker variable to:

1. `.env.example`
2. `.env.1p` (`op://` reference)
3. `scripts/worker-env-keys.txt`
4. 1Password item field

A push to `main` that touches those files triggers an automatic sync (or run the workflow manually).

## Local sync

```bash
cd jre-notion-workers

# PAT for ntn CLI (not the worker integration token unless yours are the same)
export NOTION_API_TOKEN=ntn_...

# Preview keys without pushing
DRY_RUN=1 bash scripts/sync-notion-worker-secrets.sh

# Push from 1Password via .env.1p
bash scripts/sync-notion-worker-secrets.sh
```

Using a materialized `.env` file instead:

```bash
SOURCE=file ENV_FILE=.env bash scripts/sync-notion-worker-secrets.sh
```

## CI workflow

Workflow: **Sync Notion Worker Secrets** (`sync-notion-secrets.yml`)

Triggers:

- **Manual** — Actions → Sync Notion Worker Secrets → Run workflow (optional dry run)
- **Automatic** — push to `main` when secrets manifest files change

Steps:

1. `1password/load-secrets-action` loads all variables from `.env.1p`
2. `scripts/sync-notion-worker-secrets.sh` with `SOURCE=env` builds the push file from `worker-env-keys.txt`
3. `ntn workers env push --yes` updates Notion

After rotating a secret that workers already loaded, redeploy:

```bash
npm run build && ntn workers deploy
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `NOTION_API_TOKEN is not set` | Export PAT locally or add GitHub environment secret |
| `op CLI not found` | Install 1Password CLI; in CI only the GitHub Action is used |
| `No production keys resolved` | Add missing fields to 1Password item; check `.env.1p` paths |
| Worker still uses old value | Redeploy after `env push` |
| `NTN_API_TOKEN` missing but `NOTION_TOKEN` present | Script maps legacy field name; prefer `NTN_API_TOKEN` in 1Password |

## Related files

- `scripts/worker-env-keys.txt` — canonical list of production keys
- `scripts/sync-notion-worker-secrets.sh` — sync implementation
- `.env.1p` — 1Password secret references (safe to commit)
- `workers.json` — worker ID and workspace for `ntn`
