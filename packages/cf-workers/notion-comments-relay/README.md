# notion-comments-relay

Cloudflare Worker that accepts **Notion Integration** webhooks, verifies signatures, coalesces events for **20 seconds**, and forwards a single batch to the **CoS Grok Bot** webhook ingress. A cron trigger (`*/1 * * * *`) runs `flushCoalesce` as a safety net when `waitUntil` may have been dropped.

**Live service (do not break in this PR):** https://notion-comments-relay.johnreakin.workers.dev

This module is the repo-owned source of truth. `src/index.ts` is ported from the **live box SoT** (`/workspace/notion-comments-relay` on the Grok Bot box), with targeted security/correctness fixes from CodeRabbit review (setup auth header, token rotation guard, flush-after-2xx). The live Worker continues to run from that ad-hoc path until cutover (below).

## Purpose

| Stage | Behavior |
| --- | --- |
| Notion → Worker | Handshake stores `verification_token` in KV once; rotation via `POST /setup/verification-token` |
| Verify | Later events verified via `X-Notion-Signature` (HMAC-SHA256) |
| Filter | Drops `page.deleted` and `page.undeleted`; forwards other accepted events |
| Coalesce | Buffers events for **20s** (`COALESCE_MS`) in KV key `coalesce_buffer`; cron `*/1 * * * *` safety flush |
| Worker → CoS | POST batch to `COS_WEBHOOK_URL` with `Authorization: COS_WEBHOOK_AUTHORIZATION` |

Forwarded batch shape:

```json
{
  "coalesce": true,
  "window_ms": 20000,
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
├── src/wake-gate/    # AD Docs shadow gate (rules + shadow runner)
├── src/day-log/      # Day Log serializer helper
├── tests/            # bun test
├── fixtures/         # webhook payload fixtures
├── wrangler.toml     # Worker name, pinned account_id, KV binding (placeholder namespace id)
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
| `SETUP_SECRET` | yes | `X-Setup-Secret` header for `/setup/*` routes |
| `NOTION_VERIFICATION_TOKEN` | optional | Fallback if token not yet stored in KV from Notion handshake |

Set via Wrangler (see cutover). **Do not rotate** during repo migration — reuse existing live values.

## KV

| Binding | Live namespace id (John's CF account) |
| --- | --- |
| `RELAY_KV` | `108f8eb2447e4f41aa5ab76de3cfcad0` |

Committed `wrangler.toml` uses placeholder `REPLACE_WITH_RELAY_KV_NAMESPACE_ID` so the live id is not required for CI. Replace locally before deploy.

KV keys used by the Worker (see `src/index.ts` constants):

| Key | Purpose |
| --- | --- |
| `notion_verification_token` | Notion webhook verification token (one-time handshake store; rotate via setup route) |
| `last_notion_post` | Debug snapshot of most recent POST to `/` |
| `last_forward` | Most recent forward attempt metadata |
| `forward_history` | Ring buffer of recent forward attempts (max 10) |
| `coalesce_buffer` | Pending coalesced webhook payloads (JSON array) |
| `coalesce_flush_scheduled` | Lock indicating a flush timer is active (TTL 180s) |

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

`account_id` is pinned in `wrangler.toml` (`e83f342a6c0f6e20b80697363714bf7b`, John's personal Cloudflare account). That is a non-secret identifier: it prevents a Quorum-account `wrangler` token from deploying this Worker to the wrong account.

## Routes

All `/setup/*` routes require header `X-Setup-Secret: <SETUP_SECRET>` (query params are not accepted).

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/health` | none | `{ ok, service, coalesce_ms: 20000 }` |
| `POST` | `/` | Notion signature (after handshake) | Webhook ingress |
| `GET` | `/setup/verification-token` | `X-Setup-Secret` | Read stored verification token |
| `POST` | `/setup/verification-token` | `X-Setup-Secret` | Rotate verification token (`{ "verification_token": "..." }`) |
| `GET` | `/setup/last-post` | `X-Setup-Secret` | Last POST debug snapshot |
| `GET` | `/setup/last-forward` | `X-Setup-Secret` | Last forward attempt |
| `GET` | `/setup/forward-history` | `X-Setup-Secret` | Forward history ring buffer |
| `GET` | `/setup/last-unsigned` | `X-Setup-Secret` | Alias of last-post (unsigned debug) |
| `POST` | `/setup/flush-coalesce` | `X-Setup-Secret` | Force flush `coalesce_buffer` to CoS |

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
   - Under normal operation, CoS ingress should receive the batch within about **20 seconds** (the `waitUntil` coalesce window).
   - If `waitUntil` was dropped, the cron safety flush may deliver within up to about **one minute** instead — allow that longer window before failing the check.
   - Confirm CoS ingress returns **200** for the forwarded batch.
   - `GET /setup/last-forward` with `X-Setup-Secret` should show a successful forward (`status` 2xx).
   - Or force flush: `POST /setup/flush-coalesce` with `X-Setup-Secret`, then re-check `last-forward`.
7. **Decommission ad-hoc copy** only after step 6 passes: delete `/workspace/notion-comments-relay` on the Grok Bot box.

## CI note

`.github/workflows/ci-quality.yml` runs `bun install --frozen-lockfile`, `bun run check`, and `bun run test` in this directory (Bun **1.4.0**, lockfile v2). Root `jre-notion-workers` typecheck runs in the same workflow.

## AD Docs shadow wake gate (BCH)

**Shadow mode only:** after Notion signature verification and before coalesce enqueue, the Worker runs `runShadowWakeGates` inside `ctx.waitUntil`. It logs one JSON line (`event: ad_docs_wake_gate_shadow`) to Workers Logs with `would_wake`, `would_skip`, or `would_log_only`, a reason, and the inputs it saw. It **never** drops, delays, or alters forwarded payloads for AD Docs shadow evaluation — except the **Gate Log real-path drop** (see LOCK-61 below), which stops forwarding before coalesce when the webhook parent matches Gate Log.

### Payload shapes this Worker actually receives

This deployment is subscribed as a **Notion Integration webhook** ingress (see Purpose table above). It receives signed Integration events (`entity`, `authors`, `data.parent.data_source_id`, `data.updated_properties`, etc.).

**Notion automation** payloads shaped like `data.object = "page"` with empty `properties` (the shape sent to the separate **ad-docs-webhook** routine) are **not** expected on this Worker URL unless routing is changed. The gate still parses that shape for tests and future wiring; for those events it fails open with `needs_property_fetch` because properties are empty.

### AD Docs data source

Gate evaluation runs when the webhook already carries `data.parent.data_source_id` for AD Docs (`2e97d7f5-6298-804c-b8a5-000b18b72684`), or when a page GET parent matches that data source id or `AD_DOCS_DATABASE_ID` (2022-06-28 `database_id` parent). Other databases log `not_ad_docs` (sampled). For `comment.*`, a per-isolate cache (60s TTL, bounded) stores **only** whether the page parent is AD Docs (`ad_docs` / `not_ad_docs`) so repeat comments on non-AD pages skip the parent GET; **properties are always fetched fresh** for AD Docs evaluation.

### Rules (summary)

1. **Wake:** Needs John, Sensitive, or Kind ∈ {Decision, Brief} (wake reasons beat skip rules).
2. **ADE noise:** `Source Repo` = `jre-agent-dev-cli` **and** `Document Type` = Agent Digest → `would_log_only` (`ade_agent_digest`, matches harness). `Source Repo` = `jre-agent-dev-cli` alone → `would_skip` (`ade_source_repo`). `Document Type` = Agent Digest without that repo → `would_wake` (`agent_digest_needs_review`). Legacy **`Doc Type`** is **not** used.
3. **Template / test / trash / duplicate:** title matches `/^\s*(template|test)\b[:\s-]/i` **only when `Source Repo` is unset**; `in_trash` (including `archived` on fetched pages); duplicate within 60s **only for `page.*`** when the prior shadow decision was also `default_wake` and wake-relevant fields match (Needs John, Sensitive, Kind, title-match flag, Source Repo, Document Type, in_trash). Skipping **only** for missing Client/Project relations is **not** implemented.

**Skip / log reasons (shadow):** `ade_source_repo`, `template_or_test_title`, `in_trash`, `fleet_bot_echo`, `duplicate_within_60s`, `not_ad_docs` (sampled counter only). **Log-only:** `ade_agent_digest`.

**Safety (fail open to wake):** Submitted property ids in `updated_properties`, John-authored comments, missing/unknown inputs, Notion fetch errors/timeouts (~3s), missing `NOTION_API_TOKEN`.

### Optional env (names only)

| Name | Purpose |
| --- | --- |
| `NOTION_API_TOKEN` | Fetch page properties for Integration events when not bound elsewhere |
| `JOHN_NOTION_USER_IDS` | Comma-separated Notion user ids |
| `FLEET_COMMENTS_BOT_NOTION_USER_IDS` | Fleet bot echo skip on `comment.*` only |
| `SUBMITTED_PROPERTY_IDS` | Comma-separated opaque property ids (URL-encode ids that contain commas, e.g. `H%3D%3F%3E` for `H=?>`) |
| `WAKE_GATE_KV_RING` | Set to `1` for optional KV ring buffer of truncated decisions (default off) |
| `WAKE_GATE_DEDUPE` | Set to `1` to write dedupe keys `wake_gate:dedupe:{pageId}` (TTL ~65s). **Default off** — each enabled put counts toward the relay's `RELAY_KV` daily quota |
| `AD_DOCS_DATABASE_ID` | Notion **database** id for AD Docs pages whose parent only exposes `database_id` (Notion-Version 2022-06-28). Non-secret; pair with the data source id above. Shadow logs include `database_id` when membership matched via database parent. |

KV: optional dedupe keys `wake_gate:dedupe:{pageId}` when `WAKE_GATE_DEDUPE=1` (try/caught, TTL ~65s). Optional ring `wake_gate:ring` when `WAKE_GATE_KV_RING=1`.

### Day Log serializer

No Day Log writer lives in this repository. See `docs/day-log-serializer.md` for `runSerializedByKey` (in-isolate coalescing only — **not** a cross-isolate Day Log fix).

### Tests

```bash
cd packages/cf-workers/notion-comments-relay
bun install --frozen-lockfile
bun run check
bun run test
```

Shadow JSON logs omit raw titles and author ids; they include `title_length` and `title_matched_template` only. `page_id` is omitted from routine shadow lines (sampled `not_ad_docs` lines omit it as well). Fail-open `error:` reasons log the exception **name** only (e.g. `error:AbortError`).

## Wake gates (LOCK-61)

Shadow rule gates (console + optional KV ring): comments echo, Fleet Locks adopted-change (`fleet_locks_adopted_change`), Clef second stage (Workers AI, daily cap, 10% full sample). AD Docs shadow gate (`ad_docs_wake_gate_shadow`) remains in `wake-gate-shadow.ts` with PR #30 improvements.

**Real path:** Gate Log parent matches drop forwarding (`dropped_gate_log_event`) before coalesce; shadow path exits early on the same parent match.

**Clef shadow KV ring** (`clef_shadow_log`) is **on by default**; set `CLEF_RING=0` to disable KV writes (console shadow logs still emit).

**Harness dedupe** (`wake_gate_recent_page:<pageId>`) follows `WAKE_GATE_DEDUPE=1` (default off), same as AD Docs `wake_gate:dedupe:` keys.

### Deploy vars (`wrangler.toml` `[vars]`)

| Name | Required | When unset |
| --- | --- | --- |
| `FLEET_LOCKS_DATA_SOURCE_ID` | recommended | Fleet Locks adopted-change gate fails open (`fleet_locks_data_source_unset`); no Fleet parent fetch targeting |
| `FLEET_LOCKS_DATABASE_ID` | optional | 2022-style `parent.database_id` matching skipped (data source id still used) |
| `GATE_LOG_DATA_SOURCE_IDS` | optional | Gate Log drop disabled — all parents forward |
| `SUBMITTED_PROPERTY_IDS` | optional | Submitted-property safety uses env/secret only when set (e.g. `;Xo<` in committed vars) |
| `NON_SUBMITTED_PROPERTY_IDS` | optional | No non-submitted allowlist |
| `AI_GATEWAY_ID`, `CLEF_DAILY_CALL_CAP` | Clef shadow | Clef mode/cap from defaults |

KV: `wake_gate_adopted_at:<pageId>` (**90-day** TTL) for adopted-change dedupe after a shadow `adopted_change` wake.
