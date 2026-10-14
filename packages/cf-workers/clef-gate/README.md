# clef-gate

Shadow-only Clef email classifier (Clef Phase 2). Inbox Triage posts one PII-minimized item per processed
email; the Worker scores it with Workers AI Clef and logs a JSON line to stream `clef_email_shadow`.
No mailbox access, no labels written, nothing returned to the caller beyond a status + `{"logged":…}`.

## Routes (bearer `CLEF_EMAIL_SHADOW_TOKEN`; missing/unset secret ⇒ 401)
- `POST /clef/email-shadow` — payload v1 (see spec). Status contract (authorized):
  - `202 {"logged":true,"verdict":"pending"}` — parsed, validated, and the row (triage truth, `error_reason:"clef_pending"`) is **already in KV**. The Clef call runs in `waitUntil` and rewrites the row; a racing outcome's triage fields are preserved.
  - `200 {"logged":false,"reason":"excluded"}` — grokbot exclusion: counter bump + masked `event:"excluded"` log, no row.
  - `400` invalid payload / JSON · `413` body over the read cap · `500` KV write failed (masked `event:"store_failed"` log). Retries are idempotent (row keyed by `msg_id_hash`).
- `POST /clef/email-shadow/outcome` — `{msg_id_hash, disposition, escalated?, source?: "trainspam_rescue"}`. Last write wins.

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
- Derived `shadow_label`: escalate if p_person ≥ .5 / p_money_sec ≥ .3 / p_calendar ≥ .5 / lane ≠ none; would_skip if
  p_bulk ≥ .9 and p_person ≤ .05 and p_money_sec ≤ .05; else fyi. Error/timeout/bad output ⇒ escalate.
- Join flags vs Inbox Triage disposition: `agree`, `false_skip` (would_skip but escalated/handoff/TrainSpam rescue),
  `false_wake` (escalate but spam/archive).
- KV ring: `clef_email_shadow_log:<msg_id_hash>`, 30-day TTL.
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
