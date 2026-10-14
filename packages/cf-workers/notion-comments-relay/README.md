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
| `NOTION_AUTOMATION_SECRET` | for plan-approved route | Shared secret Notion automations send in `X-Relay-Automation-Secret` |
| `AS_WEBHOOK_URL` | for plan-approved route | Abstract Secretary Grok Bot webhook ingress URL |
| `AS_WEBHOOK_AUTHORIZATION` | for plan-approved route | `Authorization` header value for AS (`Bearer ` added if missing) |

## Notion automation: plan approved → AS wake

`POST /notion/automation/plan-approved` accepts Notion database-automation "Send webhook" posts
(unsigned). Auth: header `X-Relay-Automation-Secret`, constant-time compared to
`NOTION_AUTOMATION_SECRET`; missing/wrong → `401`. Properties read: `ID`, `Kind`, `Status`,
`Project`, `Approved At`. Only `Kind=Plan`, `Status=Approved`, non-empty `Project` and non-empty
`Approved At` wake AS; anything else → `200 {ignored:true, reason}`. Dedupe key
`plan_approved:v1:<page id>:<Approved At>` (TTL 7d via `kvTtl()`); one KV read per valid request,
one KV write only after a 2xx AS response. AS unset (or whitespace-only) → `503`; AS non-2xx,
network error, or 10s timeout → `502` (not deduped). Bodies over 256 KiB → `413` (checked from
`Content-Length` before reading, then again on the actual bytes). Whitespace-only secrets count as unset.
An existing `Bearer` prefix in `*_WEBHOOK_AUTHORIZATION` is matched case-insensitively.

**Property names are pinned.** Notion's *Send webhook* action only includes the properties you
tick, so tick exactly these (case/space-insensitive match, but keep these names):
`ID`, `Kind`, `Status`, `Project`, `Approved At`. Any missing one logs a
`plan_approved_missing_properties` warning (names only) and the post is ignored if a required
field ends up empty. The page id comes from the body's `data.id` (falls back to `ID`).

**Double wake.** Dedupe is a non-atomic KV get→put written only after AS returns 2xx. Two identical
posts arriving concurrently, or a re-fire while the first wake is still in flight (≤10s), can both
wake AS. Notion fires once per trigger so this is rare; AS must treat the wake as idempotent on
`page_id` + `approved_at`.

Setup (generate without printing):

```bash
openssl rand -hex 32 | tr -d '\n' | wrangler secret put NOTION_AUTOMATION_SECRET
wrangler secret put AS_WEBHOOK_URL
wrangler secret put AS_WEBHOOK_AUTHORIZATION
```

Store the same secret value (e.g. generate into 1Password first and pipe from `op read`) in the
Notion automation's webhook custom header `X-Relay-Automation-Secret`, and include the properties above.

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

**Clef shadow KV ring** (`clef_shadow_log`) is **off by default**; set `CLEF_RING=1` to mirror console Clef lines into KV. Workers Logs already receives the same JSON.

**Harness dedupe** (`wake_gate_recent_page:<pageId>`) follows `WAKE_GATE_DEDUPE=1` (default off), same as AD Docs `wake_gate:dedupe:` keys.

**Clef property fetch:** Clef hard overrides that need page fields (`needs_john`, `sensitive`, etc.) run only when webhook enrichment set `propertiesAvailable`. Otherwise shadow logs `properties_unavailable` (wake, no model call).

**Clef KV write budget (confirm plan before deploy):** Live coalesce uses `RELAY_KV` for every accepted webhook. Shadow Clef adds at most **one KV write per Clef model attempt** via `clef:calls:` (daily cap). Optional `CLEF_RING=1` adds read-modify-write on `clef_shadow_log` (avoid on KV **free** tier — 1,000 writes/day). `wake_gate_adopted_at:` writes only after a shadow adopted-change wake. Per-page 60s event counts are **in-isolate memory** (not KV). John must confirm paid KV quota before enabling `CLEF_RING=1` in production.

**Gate Log roll-up:** This Worker does not write Gate Log database rows. A separate future Worker job is expected to roll up shadow lines into the Gate Log data source.

**Privacy / sampling notes:** Console `item_id` uses an unsalted 32-bit hash (`opaque:<hex>`) — collisions are possible and pages cannot be recovered from logs alone. The 10% full Clef sample is keyed by **page id hash**, so ~10% of pages are sampled, not 10% of events. AI Gateway logging retains the Clef `state` string (title and snippet up to 120 chars each). The irreversible-action Clef override inspects **structured fields only** (Kind, Document Type, Status, Author Lane), not free-text client-facing copy.

**properties_updated change rule (shadow, day-1 review):** when `SUBMITTED_PROPERTY_IDS` **and**
`NEEDS_JOHN_PROPERTY_IDS` are both set and the webhook lists `updated_properties`, a
`page.properties_updated` that touches neither set is `would_skip` / `no_submitted_or_needs_john_change`
(echo gate). A listed Needs John id wakes `needs_john_changed` (also a Clef hard override); a listed
Submitted id wakes `submitted_changed`. Opaque updates (no ids), or either env unset, keep the old
wake. In aggregation, a `not_fleet_locks` wake from the adopted-change gate ("not my event") no
longer outvotes an explicit skip; every other wake (unset Fleet Locks ids, unreadable page, errors,
adoption) still wins.

**Pre-Clef dedupe (shadow):** this runs on the wake path, after the hard overrides (John, Submitted, Needs John,
mentions…) and before mode/cap/Clef. An event is a repeat when its dedupe key was already seen inside
`CLEF_ITEM_DEDUPE_WINDOW_S` (default 600 s, counted from the first event; `0` turns it off).
- `comment.updated` is **never** deduped, because an edit can add real content.
- Other `comment.*` events: key = the **comment id** (`entity.id`) + event type. A different comment on the same page is
  never a repeat, and a comment with no id is never deduped.
- Page events: key = page id + event type, **only when `SUBMITTED_PROPERTY_IDS` and `NEEDS_JOHN_PROPERTY_IDS` are
  both set**. Until then, page events are never deduped.
- A repeat logs `clef_decision:"would_skip"`, `reason:"dedupe_repeat_item"`, `dedupe_repeat:true`,
  `item_event_count`, and `saved_wake:true`. It makes no wake-path Clef call. **Every** repeat (100%, bypassing the
  rule-skip sampler) then goes through the false-skip check. Repeats have their **own** daily cap,
`CLEF_DEDUPE_REPEAT_DAILY_CAP` (default 100, counter `clef:dedupe_repeat_calls`), so sampled rule-skip checks
can't starve them. When that cap is exhausted, the check row logs `reason:"dedupe_repeat_daily_cap"`,
`cap_exhausted:true` and `scored:false`. That adds a `decision:"rule_skip"` row with
  `dedupe_repeat:true`, `scored:true|false` and `candidate_false_skip`. A cap hit, Clef error or mode-off logs
  `scored:false`; excluded mail logs `excluded:true`.
- Grading: report `saved_wake` rows separately from rule skips. Group them by `item_id` to count saved wakes per item.
- The dedupe is isolate-local (no KV writes), so a repeat landing on another isolate isn't deduped. That can
  undercount savings but never over-skips.

**Grading (`src/wake-gate/grade-relay.ts` `gradeRelayWindow(rows)`):** pass the window's `clef_wake_shadow`
rows. It reports per-UTC-day wake-path Clef calls, errors and error rate, plus rule skips and dedupe repeats, each
split into scored and unscored, plus false skips and saved wakes per `item_id`. The window **fails** on any scored
false skip (`candidate_false_skip`), on **any unscored dedupe repeat**, on any day with Clef error rate
> `RELAY_ERROR_RATE_MAX` = 2%, or on any `clef_ai_unbound` / `clef_gateway_unset` row, whether on the wake path
or a check row (`config_error`). Unscored repeats fail with `unscored_dedupe_repeat_cap` when the repeat cap ran out
(a capacity problem: raise the cap). Otherwise they fail with `unscored_dedupe_repeat` (Clef error, mode off,
missing row).

**Runbook: mode-off days fail the window.** With `clef:mode:*` = `off`, no Clef calls are made. Every dedupe
repeat logs `rule_skip:mode_off` / `scored:false`, so the window fails `unscored_dedupe_repeat`. An off day is
unmeasured: after mode returns to shadow, restart the 14-day window rather than skipping the off day. Rule skips are sampled, so unscored rule skips are
reported but don't fail the window. "Zero false skips" for rule skips therefore means zero among the scored ones;
always quote `rule_skips_scored`/`rule_skips` with a pass.

**Needs John hard override:** for `page.properties_updated`, the `needs_john_changed` override fires when the page's
Needs John flag is set (from enriched/fetched properties). It also fires when `NEEDS_JOHN_PROPERTY_IDS` is set and a
listed updated id is one of those ids. The flag check does not depend on the env id sets. An unreadable page already
hits the `properties_unavailable` override.

**`NON_SUBMITTED_PROPERTY_IDS`:** When unset, Fleet Locks property ids from code defaults are used so Clef/Fleet gates can distinguish non-Submitted property updates. Set the env var to override that list.

### CoS pre-filter (shadow first)

`src/wake-gate/cos-prefilter.ts` decides, on the forward path, whether an event should wake Chief of Staff at all:

| reason | drops |
|---|---|
| `ack_only` | `comment.created` / `comment.updated` whose whole text is an acknowledgement (thanks, ok, +1, done, got it, emoji-only, ...). Questions, mentions, text over 60 chars, and missing text never count. |
| `self_echo_bot` | comments whose authors are all the GrokBot Fleet Comments integration bot (built-in id plus `FLEET_COMMENTS_BOT_NOTION_USER_IDS`) |
| `self_echo_lane` | comments starting with a lane prefix (`CoS:`, `[BCH]`, `Chief of Staff —`, ...; extend with `COS_PREFILTER_LANE_PREFIXES`) |
| `non_actionable_property` | `page.properties_updated` touching neither Submitted nor Needs John (the properties_updated rule above; **inert until `NEEDS_JOHN_PROPERTY_IDS` is set** next to `SUBMITTED_PROPERTY_IDS`) |

**Hard overrides always pass:** John authored, any John @mention (mention node or plain `@John`), Needs John (set or
changed), Submitted changed (including an opaque update with no ids listed).

**Mode:** `COS_PREFILTER_LIVE=1` skips the CoS forward (`dropped_cos_prefilter` in forward history). Default is SHADOW:
the row is logged and the event is forwarded as before. In both modes the Clef shadow gates still run.

**Logging / grading:** every forwarded webhook logs one `stream:"cos_prefilter"` row (`decision` `would_drop`|`pass`,
`reason`, `mode`, `dropped`, opaque `event_key`; never text or raw ids). It is ring-buffered with `CLEF_RING=1`. Clef rows
carry the same `event_key`. `gradeRelayWindow(rows).prefilter` joins the two:
- fails `prefilter_dropped_override` when a would_drop hit an event Clef marked as a hard override (John
  authored/mention, Submitted, Needs John);
- fails `prefilter_false_drop` when Clef scored a dropped event as would_wake;
- reports `scored_by_reason` / `unscored_by_reason` coverage. Bot self-echoes are mostly unscored, because Clef
  hard-overrides fleet-bot authors, so state the coverage with any pass.

Go live only after a clean window: `wrangler.toml` `COS_PREFILTER_LIVE = "1"` (John's call).

### Deploy vars (`wrangler.toml` `[vars]`)

Ids in `[vars]` ship with `wrangler deploy` (no `--keep-vars` needed for these). Secrets stay in Wrangler secrets / dashboard.

| Name | Required | When unset |
| --- | --- | --- |
| `FLEET_LOCKS_DATA_SOURCE_ID` | recommended | Fleet Locks adopted-change gate fails open (`fleet_locks_data_source_unset`); no Fleet parent fetch targeting |
| `FLEET_LOCKS_DATABASE_ID` | optional | 2022-style `parent.database_id` matching skipped (data source id still used) |
| `GATE_LOG_DATA_SOURCE_IDS` | optional | Gate Log drop disabled — all parents forward |
| `SUBMITTED_PROPERTY_IDS` | optional | Submitted-property safety uses env/secret only when set (e.g. `;Xo<` in committed vars) |
| `NON_SUBMITTED_PROPERTY_IDS` | optional | Falls back to built-in Fleet Locks non-Submitted property id list |
| `NEEDS_JOHN_PROPERTY_IDS` | optional | Needs John property ids. With `SUBMITTED_PROPERTY_IDS` also set, enables the properties_updated change rule below; unset ⇒ inert |
| `CLEF_DEDUPE_REPEAT_DAILY_CAP` | optional | Daily cap for false-skip checks of dedupe repeats (default `100`), separate from `CLEF_RULE_SKIP_DAILY_CAP` |
| `CLEF_ITEM_DEDUPE_WINDOW_S` | optional | Pre-Clef dedupe window in seconds (default `600`; `0` disables). Comments key on comment id; page events dedupe only once both id sets are set |
| `JOHN_NOTION_USER_IDS`, `FLEET_COMMENTS_BOT_NOTION_USER_IDS` | recommended | Clef shadow overrides `john_ids_unset` / `bot_ids_unset` (wake, no model) |
| `AI_GATEWAY_ID`, `CLEF_DAILY_CALL_CAP` | Clef shadow | Clef mode/cap from defaults |
| `CLEF_RING` | optional | Default off; `1` enables `clef_shadow_log` KV ring |

KV: `wake_gate_adopted_at:<pageId>` (**90-day** TTL) for adopted-change dedupe after a shadow `adopted_change` wake.


## Gate log KV ring (durable gate log, v1)

**Durable buffer (when `GATE_LOG_DO` is bound — default in `wrangler.toml`):** each request sends its rows in **one RPC** to a single SQLite-backed Durable Object `GateLogBuffer` (`idFromName("gate_log")`). The DO stores them in SQLite (survives isolate churn) and a **DO alarm** flushes ≤ 500 rows per KV value, paced at max(5 min, time left in UTC day ÷ flushes left) and capped by `GATE_LOG_DAILY_WRITE_CAP`. The flush counter lives in DO storage (exact; **0 KV writes**). Over the cap, rows are **kept** and drained after 00:00 UTC; storage is bounded at 20,000 rows (oldest pruned, counted in DO meta `pruned:<day>`). Key schema below is unchanged except `flushId` = `do-<epoch-ms base36>` (still unique). Without the binding the in-isolate ring below is used (legacy fallback). Fail-open: RPC errors/timeouts (2 s) drop that request's rows from KV only (`gate_log_do_error` log line); forwarding is never affected. DO flush writes use the raw binding and are **not** seen by the KV write meter (≤ cap/day).

`WAKE_GATE_KV_RING=1` / `CLEF_RING=1` buffer shadow rows in isolate memory and write **one KV value per batch**. This replaces the old per-event read-modify-write keys `wake_gate:ring`, `wake_gate_shadow_log`, and `clef_shadow_log`, which are no longer written. Notion Steward's Gate Log writer reads these keys.

| Item | Value |
|---|---|
| Key | `gate_log:v1:<YYYY-MM-DD>:<HH>:<flushId>` (UTC day + UTC hour of the flush; `flushId` = `<isolateId>-<seq>`, unique, never overwritten) |
| List | `list({ prefix: "gate_log:v1:<YYYY-MM-DD>:" })` per day, or `…:<HH>:` per hour |
| Value | `{"v":1,"flushed_at":"<ISO>","rows":[GateLogRow, …]}` (≤ 25 rows typical, ≤ 200 max) |
| TTL | 7 days |
| Flush | at 25 rows; at **end of every request** when the oldest buffered row is older than the paced min age = max(5 min, time left in UTC day ÷ flushes left); and on **every cron tick** that lands on an isolate holding rows |
| Budget | `GATE_LOG_DAILY_WRITE_CAP` flush writes/UTC day (default 60) + soft counter `gate_log:writes:<YYYY-MM-DD>` (persisted every 8 flushes, TTL 48h) |
| Near cap | at ≥ 80% of the cap, only high-signal rows are kept, plus 1 in 4 of the rest (marked `sampled_near_cap: true`). At the cap, rows go to console only |

Every row has `stream`:
- `clef_wake_shadow`: `ts, gate:"clef_wake", item_id (opaque:<hash>), source, event, rule_decision, clef_decision, p_action, p_dup, q_when, confidence, model, latency_ms, sampled_full, mode, actually_ran, reason`, plus optional `decision:"rule_skip"` and `candidate_false_skip`.
- `wake_gate_shadow`: the sanitized harness rule decision `gate_name, decision, reason, inputs, ts, mode`.
- `ad_docs_wake_gate_shadow`: `ts, decision, reason, notion_type`.

**UTC rollover:** day buckets, `<HH>`, and every daily cap/counter (`gate_log:writes:`, `clef:calls:`, `clef:rule_skip_calls:`) roll over at **00:00 UTC = 7 PM CDT (summer) / 6 PM CST (winter)** Central. A Steward run "for today" in the evening Central time must also read the next UTC day's prefix.

**Counter overshoot (bounded, accepted):** daily counters persist every N increments (Clef main N=25, rule-skip N=10, gate log N=8). An isolate evicted before persisting loses at most N−1 counted increments, so actual calls/flushes can exceed a cap by ≤ (N−1) × (isolates evicted that day). Overshoot never adds KV writes beyond the cap's own flushes; it only affects Workers AI call counts slightly.

**KV write alert:** RELAY_KV puts/deletes are metered (`kv:writes:<YYYY-MM-DD>`, persisted every 25 ops). Past `KV_WRITE_ALERT_THRESHOLD` (default 800) the Worker logs one `{"level":"alert","event":"kv_write_budget_alert"}` line per isolate per UTC day.

> **The KV write meter is not billing truth.** It is a soft, per-isolate counter merged into KV every 25 ops: it can undercount (isolate eviction before persist, concurrent persists racing — KV has no CAS), it does not count its own persist writes or writes from other Workers/`wrangler` on the account, and its day is UTC. Use the Cloudflare dashboard (KV → Metrics) / billing for actual usage; treat the alert as an early warning only.

The ring is best effort: rows still in an isolate's buffer when it is evicted are lost from KV. Workers Logs (console) keeps the complete stream.


## Troubleshooting

### `notion_fetch_failed` on `page.created` (Fleet Locks / AD Docs shadow gates)

**Symptom:** `wake_gate_shadow` rows with `gate_name: "fleet_locks_adopted_change"` and `reason: "notion_fetch_failed"`, and the matching `clef_wake_shadow` row with `reason: "notion_fetch_failed"`. Forwarding is still `200`.

**Usual cause: integration access, not code.** The page is a **private, top-level page** (empty ancestor path, e.g. a fresh "New page" in John's private section) that the relay's Notion integration is not shared on. `GET /v1/pages/:id` returns 404/403, and `fetchNotionPageOutcome` maps that to `notion_fetch_failed`. Pages in shared databases resolve normally (`not_fleet_locks`, etc.).

**Check:** open the page in Notion → `•••` → *Connections*. If the relay integration isn't listed, this is expected. To confirm, `notion_fetch_timeout` means slowness instead, and `notion_token_missing` means the `NOTION_API_TOKEN` secret is unset (`wrangler secret list`).

**Fix:** nothing is required (shadow-only). If those pages should be gated, share the parent page or teamspace with the integration. Don't widen the token.
