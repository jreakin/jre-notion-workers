# notion-comments-relay

Cloudflare Worker that accepts **Notion Integration** webhooks, verifies signatures, coalesces events for ~45 seconds, and forwards a single batch to the **CoS Grok Bot** webhook ingress.

**Live service (do not break in this PR):** https://notion-comments-relay.johnreakin.workers.dev

This module is the repo-owned source of truth. `src/index.ts` is the **verbatim live box SoT** (486 lines from `/workspace/notion-comments-relay` on the Grok Bot box), not a reconstruction. The live Worker continues to run from that ad-hoc path until cutover (below).

## Purpose

| Stage | Behavior |
| --- | --- |
| Notion → Worker | Handshake stores `verification_token` in KV; later events verified via `X-Notion-Signature` (HMAC-SHA256) |
| Filter | Drops `page.deleted` and `page.undeleted`; forwards other accepted events |
| Coalesce | Buffers events for **45s** (`COALESCE_MS`) in KV namespace `RELAY_KV` |
| Worker → CoS | POST batch to `COS_WEBHOOK_URL` with `Authorization: COS_WEBHOOK_AUTHORIZATION` |

Forwarded batch shape:

```json
{
  "coalesce": true,
  "window_ms": 45000,
  "count": 3,
  "types": ["comment.created", "page.properties_updated"],
  "events": [ /* raw Notion webhook bodies */ ]
}
```

Notion always receives HTTP **200** with body `ok` after the Worker accepts a payload (including dropped events and failed signature checks).

## Layout

```
packages/cf-workers/notion-comments-relay/
├── src/index.ts      # Worker entry
├── wrangler.toml     # Worker name + KV binding (placeholder namespace id)
├── package.json
├── tsconfig.json
└── README.md
```

Sibling to `packages/workers/` (recovered Notion Workers / Bun). This package uses **Wrangler** only — not part of the `jre-notion-workers` Bun app or `ntn` deploy path.

## Secrets (names only — never commit values)

| Name | Required | Purpose |
| --- | --- | --- |
| `COS_WEBHOOK_URL` | yes | CoS Grok Bot webhook ingress URL |
| `COS_WEBHOOK_AUTHORIZATION` | yes | `Authorization` header value for CoS |
| `SETUP_SECRET` | yes | Gates `/setup/*` diagnostic routes |
| `NOTION_VERIFICATION_TOKEN` | optional | Fallback if token not yet stored in KV from Notion handshake |

Set via Wrangler (see cutover). **Do not rotate** during repo migration — reuse existing live values.

## KV

| Binding | Live namespace id (John's CF account) |
| --- | --- |
| `RELAY_KV` | `108f8eb2447e4f41aa5ab76de3cfcad0` |

Committed `wrangler.toml` uses placeholder `REPLACE_WITH_RELAY_KV_NAMESPACE_ID` so the live id is not required for CI. Replace locally before deploy.

KV keys used by the Worker:

- `notion:verification_token` — Notion webhook verification token
- `relay:pending` — buffered events JSON
- `relay:flush_at` — scheduled flush timestamp (ms)
- `relay:flush_lock` — short-lived flush mutex
- `relay:last_flush` — metadata from last successful forward

## Local development

```bash
cd packages/cf-workers/notion-comments-relay
bun install   # or npm install

# Copy secrets into .dev.vars (not committed):
# COS_WEBHOOK_URL=...
# COS_WEBHOOK_AUTHORIZATION=...
# SETUP_SECRET=...
# NOTION_VERIFICATION_TOKEN=...   # optional

bun run dev
```

Typecheck:

```bash
bun run check
```

## Deploy (manual — not wired in CI)

This PR does **not** add Cloudflare deploy to GitHub Actions. Deploy from the module directory after cutover prep:

```bash
cd packages/cf-workers/notion-comments-relay
wrangler deploy
```

Worker name in `wrangler.toml` is `notion-comments-relay` — deploy targets the **existing** Worker so `*.johnreakin.workers.dev` URL is unchanged.

## Routes

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/health` | none | `{ ok, service, coalesce_ms }` |
| `POST` | `/` | Notion signature (after handshake) | Webhook ingress |
| `GET` | `/setup` | `?secret=` or `X-Setup-Secret` | Overview + pending summary |
| `GET` | `/setup/status` | setup secret | Pending window / flush schedule |
| `GET` | `/setup/pending` | setup secret | Full pending event list |
| `GET` | `/setup/verify` | setup secret | Config checks + optional CoS probe |
| `GET` | `/setup/flush` | setup secret | Force flush pending batch to CoS |

## Cutover (CoS / John)

Perform **after** this PR is merged. Do **not** deploy from the PR branch to production.

1. **Merge PR** into `main`.
2. **Checkout** `main` and `cd packages/cf-workers/notion-comments-relay`.
3. **Set KV id** in `wrangler.toml`: replace `REPLACE_WITH_RELAY_KV_NAMESPACE_ID` with `108f8eb2447e4f41aa5ab76de3cfcad0` (binding name stays `RELAY_KV`).
4. **Secrets** — reuse existing live values (do not create a new Worker):
   ```bash
   wrangler secret put COS_WEBHOOK_URL
   wrangler secret put COS_WEBHOOK_AUTHORIZATION
   wrangler secret put SETUP_SECRET
   # optional, if not relying on KV handshake token alone:
   wrangler secret put NOTION_VERIFICATION_TOKEN
   ```
5. **Deploy** to the same Worker name:
   ```bash
   wrangler deploy
   ```
   Confirm URL: https://notion-comments-relay.johnreakin.workers.dev/health
6. **Prove end-to-end:**
   - Trigger a Notion `comment.created` or disposable `page.created` in a test page.
   - Within ~45s, confirm CoS ingress receives the coalesced batch and returns **200**.
   - `GET /setup/status?secret=…` should show `pending_count: 0` after flush.
7. **Decommission ad-hoc copy** only after step 6 passes: delete `/workspace/notion-comments-relay` on the Grok Bot box.

## CI note

Root CI runs `bun run check` under `jre-notion-workers/` only. This module is excluded until a dedicated check is added. Run `bun run check` locally in this directory before deploy.
