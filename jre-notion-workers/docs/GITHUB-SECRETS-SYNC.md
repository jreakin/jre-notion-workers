# GitHub Environment — Notion Worker Secrets Sync

This repo syncs **production** Notion Worker environment variables from 1Password to the hosted worker using `ntn workers env push`. New keys are added; changed values are updated. Keys that exist only in Notion are not removed.

CI reads secrets from a [1Password Environment](https://developer.1password.com/docs/environments) (`op environment read`) rather than per-field `op://` secret references — there is no `.env.1p`-equivalent file to keep in sync with 1Password item fields for CI. (Local development can still use `.env.1p` / `op://` references — see [Local sync](#local-sync).)

## What runs where

| Context | Tool | Auth |
|--------|------|------|
| **GitHub Actions** | `.github/workflows/sync-notion-secrets.yml` | `OP_SERVICE_ACCOUNT_TOKEN` (scoped to the Environment) + `NOTION_API_TOKEN` |
| **Maintainer laptop** | `bash scripts/sync-notion-worker-secrets.sh` | `op` CLI + `NOTION_API_TOKEN` (or `ntn login`) |
| **Worker runtime** | Notion-hosted worker | `NTN_API_TOKEN` and `*_DATABASE_ID` from worker env |

**Important:** `NOTION_API_TOKEN` is a Notion **personal access token** for the `ntn` CLI. `NTN_API_TOKEN` on the worker is the **integration token** workers read at runtime — different credentials, often stored in the same 1Password Environment.

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
| `OP_SERVICE_ACCOUNT_TOKEN` | 1Password service account with **read access to the 1Password Environment** (`i6ul2k6tk5kzyszv465wzhdpnu`) — not just a vault |
| `NOTION_API_TOKEN` | Notion PAT with Workers deploy/manage permission for workspace `c0b7d7f5-6298-81dd-8aad-0003d8ccc420` |

Create the PAT in [Notion Developer → Personal access tokens](https://www.notion.so/my-integrations).

If the existing `OP_SERVICE_ACCOUNT_TOKEN` was only scoped to vault `Dev`, it must be re-scoped (or a new service account issued) with read access to the Environment itself — vault access alone doesn't grant `op environment read` permission.

### 3. 1Password Environment variables

Ensure the 1Password Environment (ID `i6ul2k6tk5kzyszv465wzhdpnu`) has a variable for every key in `scripts/worker-env-keys.txt`.

Add any new worker variable to:

1. `scripts/worker-env-keys.txt`
2. The 1Password Environment (add the variable there)

A push to `main` that touches `worker-env-keys.txt` or `sync-notion-worker-secrets.sh` triggers an automatic sync (or run the workflow manually).

## Local sync

```bash
cd jre-notion-workers

# PAT for ntn CLI (not the worker integration token unless yours are the same)
export NOTION_API_TOKEN=ntn_...

# Preview keys without pushing
DRY_RUN=1 bash scripts/sync-notion-worker-secrets.sh

# Push from 1Password via .env.1p (item/field op:// references)
bash scripts/sync-notion-worker-secrets.sh

# Or push from the same 1Password Environment CI uses
SOURCE=op-environment OP_ENVIRONMENT_ID=i6ul2k6tk5kzyszv465wzhdpnu bash scripts/sync-notion-worker-secrets.sh
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

1. `1password/install-cli-action` installs the beta 1Password CLI (required for `op environment read`)
2. `scripts/sync-notion-worker-secrets.sh` with `SOURCE=op-environment` reads `OP_ENVIRONMENT_ID` via `op environment read` and builds the push file from `worker-env-keys.txt`
3. `ntn workers env push --yes` updates Notion

After rotating a secret that workers already loaded, redeploy:

```bash
npm run build && ntn workers deploy
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `NOTION_API_TOKEN is not set` | Export PAT locally or add GitHub environment secret |
| `op CLI not found` | Install 1Password CLI (`install-cli-action` in CI; `brew install 1password-cli` locally) |
| `OP_ENVIRONMENT_ID is not set` | Set it to `i6ul2k6tk5kzyszv465wzhdpnu` (or export as a step/job env var) |
| `No production keys resolved` | Add the missing variable to the 1Password Environment; confirm the service account has read access to that Environment |
| Worker still uses old value | Redeploy after `env push` |
| `NTN_API_TOKEN` missing but `NOTION_TOKEN` present | Script maps legacy field name; prefer `NTN_API_TOKEN` as the variable name |

## Related files

- `scripts/worker-env-keys.txt` — canonical list of production keys
- `scripts/sync-notion-worker-secrets.sh` — sync implementation (`SOURCE=op-environment`, `1p`, `file`, or `env`)
- `../../scripts/install-ntn.sh` — install `ntn` CLI on Cloud Agent / CI (no sudo)
- `.env.1p` — 1Password secret references for local dev flows (safe to commit)
- `workers.json` — worker ID and workspace for `ntn`
