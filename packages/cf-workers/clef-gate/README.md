# clef-gate

Shadow-only Clef email classifier (Clef Phase 2). Inbox Triage posts one PII-minimized item per processed
email; the Worker scores it with Workers AI Clef and logs a JSON line to stream `clef_email_shadow`.
No mailbox access, no labels written, nothing returned to the caller beyond a status + `{"logged":…}`.

## Routes (bearer `CLEF_EMAIL_SHADOW_TOKEN`; missing/unset secret ⇒ 401)
- `POST /clef/email-shadow` — payload v1 (see spec). Status contract (authorized):
  - `202 {"logged":true,"verdict":"pending"}` — parsed, validated, and the row (triage truth, `error_reason:"clef_pending"`) is **already in KV**. The Clef call runs in `waitUntil` and rewrites only the decision row.
  - `202 {"logged":true,"duplicate":true}` — a finished (non-pending) decision row already exists for this `msg_id_hash`: no rewrite, no Clef call. A still-pending row is re-admitted (recovers a dead background step). KV reads can be ~60 s stale across PoPs, so a near-simultaneous duplicate may still re-run Clef once. **A duplicate sent while the first copy is still `clef_pending` also re-runs Clef** (by design, so a dead background step can recover): two completions then race last-write-wins on the decision row, the flash sample may differ, and Clef budget can be spent twice. Only the decision row is rewritten; outcomes are unaffected.
  - `200 {"logged":false,"reason":"excluded"}` — grokbot exclusion: counter bump + masked `event:"excluded"` log, no row.
  - `400` invalid payload / JSON / unreadable body · `413` body over the read cap (logged `event:"rejected"`, `payload_too_large`) · `500` KV write failed (masked `event:"store_failed"`, `kv_put_failed`; background crash logs `clef_completion_failed`). Retries are idempotent (row keyed by `msg_id_hash`).
- `POST /clef/email-shadow/outcome` — `{msg_id_hash, disposition, escalated?, source?: "trainspam_rescue"}`. Last write wins.
  `202 {"logged":true,"matched":true|false}`; `matched:false` means no decision row exists for that hash (wrong
  message id / salt, or the decision post never landed): the outcome is stored but cannot be graded until one does.
  Day-1 data: 454 decisions vs 7 outcome posts, 0 rejected. The Worker accepted every outcome it got; Inbox Triage
  simply was not posting one per email. Contract: see "Outcome posting contract" below.

### Outcome posting contract (Inbox Triage)
1. For **every** email it posted a decision for, Inbox Triage posts exactly one outcome **at the end of the same
   run, after the disposition is applied** (labels set / archived / spam / handed off / escalated):
   `clef-email-shadow outcome --message-id <same Gmail message id used for post> --disposition <final>
   [--escalated true|false]`. Same message id + same salt ⇒ same `msg_id_hash`.
2. `disposition` is the **final applied** action, one of `spam | archive_fyi | escalate_john | handoff_lane | leave`
   (not the planned one). `--escalated true` whenever John was told about it (chat/brief), even if archived.
3. Later corrections post again (last write wins): John rescues from TrainSpam / spam ⇒
   `--disposition escalate_john --source trainspam_rescue`; John archives something escalated ⇒ `archive_fyi`.
4. Never post for mail that was not posted as a decision, nor for `jre@mail.grokbot.com` (excluded).
5. On `matched:false`, re-check the message id (not thread id) and that the decision post returned 202. On 5xx the
   helper retries once; never block triage on it. No subject/sender/content in the outcome, ever.

## Behavior
- Defensive re-mask of subject (140) / snippet (400): emails, URLs, phones, digit runs ≥ 6. Body > 8 KB dropped.
  Subject/snippet go to Workers AI only; they are never logged or stored.
- Excluded entirely: anything for `jre@mail.grokbot.com`: override `grokbot_inbox`, a sender domain of
  `mail.grokbot.com` (or a subdomain), or the address (any case, any `jre+alias@`, %-encoded, boundary-anchored) in a
  structured field. Subject/snippet are never scanned, so a sender cannot hide mail from the shadow data. Only a KV counter
  `clef_email:excluded:<day>` is bumped; no log row.
- **Box-side contract (required):** payload v1 carries no to/cc/delivered-to addresses, so Inbox Triage MUST send
  `override:"grokbot_inbox"` for anything to/cc/delivered-to/from `jre@mail.grokbot.com`, including `+` aliases.
- Never-Clef overrides (`known_person`, money, security, calendar, legal, tesla, x_notify, plus known domains) ⇒
  `clef_called:false`, `shadow_label:"escalate"`.
- AI Gateway calls send `{ id, collectLog: false, skipCache: true }` (no metadata) so the masked subject/snippet are not
  logged or cached by the gateway. The relay keeps its plain `{ id }`. If `AI_GATEWAY_ID` is unset the model is not
  called (`error_reason:"clef_gateway_unset"`), so the gateway rate limit and no-log layer can't be bypassed.
- One Clef call (`@cf/cloudflare/clef`) with six questions; deterministic 10% `@cf/cloudflare/clef-flash` side-by-side
  (last 8 hex of msg_id_hash mod 10 = 0). Gateway `clef-shadow-gate`.
- **Retry + fallback, inside one total budget:** a transient Clef failure (`clef_error:*` such as `AiGatewayError`/`AiError`,
  or `clef_timeout`) is retried on the same model after 250 ms and 750 ms (3 calls), then `@cf/cloudflare/clef-flash` is
  tried once. A gateway **429** (the `clef-shadow-gate` rate limit) is logged as `clef_error:RateLimited` and retried
  after **4 s and 9 s (±30 % jitter)** instead, with no flash fallback and no side-by-side (same gateway, same limit).
  All Clef work for one email (retries, fallback, and the 10% flash side-by-side) shares a
  **`CLEF_COMPLETION_BUDGET_MS` = 22 s** budget, under the 30 s `waitUntil` limit. Each call's timeout is clipped to
  the time left, and no call starts with < 500 ms left. When the budget or the cap stops a retry early, the row keeps the
  last real failure in `error_reason` and logs `clef_stopped` (`clef_budget_exhausted` / `clef_daily_cap`).
  The side-by-side flash is **one call, never retried**, and runs only if a full call's time (3 s) is left. It is
  skipped when the verdict already came from the flash fallback.
  **Cap:** every real model call (first try, each retry, the fallback, and the side-by-side) takes one unit of
  `CLEF_EMAIL_DAILY_CALL_CAP`, so the cap counts real calls. Rows log `clef_attempts` and `clef_fallback`.
  Bad output and config errors (`clef_gateway_unset`, `clef_ai_unbound`) are not retried.
  The cap counter increment is best-effort: a failed KV write (per-key write limit during a burst) still admits the
  call; only an unreadable counter is `clef_cap_unavailable`.
- **Gateway rate limit vs. bursts:** the gateway allows 60 requests / 60 s. Morning inbox runs post 120+ emails in a
  minute, so backoff alone cannot absorb a burst; raise the gateway limit (see the PR) or pace the sender.
- **`shadow_label:"error"`:** no verdict (retries/fallback exhausted, bad output, gateway unset, AI unbound, cap store
  unreadable/invalid). It is its own category: `agree`/`false_skip`/`false_wake` stay `null`. A reached daily cap stays
  `escalate` (policy). Live guard in code: `liveActionLabel("error") === "escalate"`.
- **Grading (`src/grade.ts` `gradeWindow(joinedRows)`)** is the 14-day window grader. It uses rows from `gradeFromKv` only.
  It reports per-day `decided`/`errors`/`error_rate`. The window **fails** on any `false_skip`, on any day with error
  rate > **`ERROR_RATE_MAX` = 2%**, or on **any** `clef_gateway_unset` / `clef_ai_unbound` row. Error rows whose
  triage acted (`escalate_john`, `handoff_lane`, escalated, TrainSpam rescue) are listed in `unmeasured_wakes`
  (msg_id_hash only): real wakes Clef never scored.
- Derived `shadow_label`: escalate if p_person ≥ .5 / p_money_sec ≥ .3 / p_calendar ≥ .5 / lane ≠ none; would_skip if
  p_bulk ≥ .9 and p_person ≤ .05 and p_money_sec ≤ .05; else fyi. Error/timeout/bad output ⇒ escalate.
- Join flags (computed by `gradeJoined`) vs Inbox Triage disposition: `agree`, `false_skip` (would_skip but escalated/handoff/TrainSpam rescue),
  `false_wake` (escalate but spam/archive).
- KV layout (30-day TTL each):
  - `clef_email_shadow_log:<msg_id_hash>` — decision row (pending → verdict). Written only by `/clef/email-shadow`.
  - `clef_email_shadow_outcome:<msg_id_hash>` — outcome row. Written only by `/clef/email-shadow/outcome` (last write wins). Neither writer touches the other's key, so no overwrite race.
  - **Grading must go through `gradeFromKv(kv, hash)` / `gradeJoined(decision, outcome)` only** — including the 14-day zero-false-skip window and any Gate Log rollup. Outcome triage truth wins; `null` while the verdict is pending. The outcome row (and its `event:"outcome"` log line) intentionally carries **no** verdict and **no** `agree`/`false_skip`/`false_wake`; never read flags off it. Decision-row flags reflect decision-time triage only and are superseded by the join.
- **Grading window:** shadow rows written before this fix (outcome key + idempotent resend) do **not** count toward the 14-day zero-false-skip window. Earlier rows could have an outcome overwritten by a verdict, or a verdict overwritten by a resend. Start the 14-day clock from this fix's deploy.
- Daily cap `CLEF_EMAIL_DAILY_CALL_CAP` (1000) at `clef:calls:clef_email:<day>` (soft, KV not atomic). The flash sample
  takes a second unit from the same cap, so the effective full-call budget is about 91% of the cap.
- Request bodies are stream-read with a 16 KB cap (works without content-length); parsed bodies over 8 KB are dropped.
- Rejected rows and outcomes without a prior decision log `mode:"n/a"`.
- Kill switch: KV `clef:mode:global` or `clef:mode:clef_email` = `off`. Default mode shadow; `live` is not honored.

## Deploy checklist (only after merge and John OKs)
1. **Required before any email traffic:** in the dashboard, disable log collection on AI Gateway `clef-shadow-gate`
   (also turn off caching, add a rate limit). Code sends `collectLog:false` too; keep both layers. Make one test call and
   confirm no request body shows in gateway logs.
2. `wrangler kv namespace create`; replace the placeholder id in `wrangler.toml`.
3. `wrangler secret put CLEF_EMAIL_SHADOW_TOKEN`; box copy in 1Password scoped to this route.
4. Confirm model slugs `@cf/cloudflare/clef` / `@cf/cloudflare/clef-flash`.
5. `wrangler deploy --dry-run` on Node ≥ 22, then deploy with mode shadow.
6. Redeploy the relay from main; confirm relay gate rows still appear and webhooks still forward when the gate errors.
7. Smoke: no auth → 401; auth → 202 + log row without subject/snippet; grokbot payload → 200, no row, counter + masked drop log;
   lookalike payload → normal row.
8. Inbox Triage (its own lane): send `override:"grokbot_inbox"` for to/cc/delivered-to/from jre@ incl. `+` aliases.
9. Go live only after 14 days with zero false skips and John's sign-off.
