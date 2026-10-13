# clef-gate

Shadow-only Clef email classifier (Clef Phase 2). Inbox Triage posts one PII-minimized item per processed
email; the Worker scores it with Workers AI Clef and logs a JSON line to stream `clef_email_shadow`.
No mailbox access, no labels written, nothing returned to the caller beyond `202 {"logged":true}`.

## Routes (bearer `CLEF_EMAIL_SHADOW_TOKEN`; missing/unset secret ⇒ 401)
- `POST /clef/email-shadow` — payload v1 (see spec). Always 202 when authorized.
- `POST /clef/email-shadow/outcome` — `{msg_id_hash, disposition, escalated?, source?: "trainspam_rescue"}`. Last write wins.

## Behavior
- Defensive re-mask of subject (140) / snippet (400): emails, URLs, phones, digit runs ≥ 6. Body > 8 KB dropped.
  Subject/snippet go to Workers AI only; they are never logged or stored.
- Excluded entirely: anything for `jre@mail.grokbot.com` (override `grokbot_inbox`, a grokbot mailbox, or the address anywhere
  in the body). Only a KV counter `clef_email:excluded:<day>` is bumped; no log row.
- Never-Clef overrides (`known_person`, money, security, calendar, legal, tesla, x_notify, plus known domains) ⇒
  `clef_called:false`, `shadow_label:"escalate"`.
- One Clef call (`@cf/cloudflare/clef`) with six questions; deterministic 10% `@cf/cloudflare/clef-flash` side-by-side
  (last 8 hex of msg_id_hash mod 10 = 0). Gateway `clef-shadow-gate`.
- Derived `shadow_label`: escalate if p_person ≥ .5 / p_money_sec ≥ .3 / p_calendar ≥ .5 / lane ≠ none; would_skip if
  p_bulk ≥ .9 and p_person ≤ .05 and p_money_sec ≤ .05; else fyi. Error/timeout/bad output ⇒ escalate.
- Join flags vs Inbox Triage disposition: `agree`, `false_skip` (would_skip but escalated/handoff/TrainSpam rescue),
  `false_wake` (escalate but spam/archive).
- KV ring: `clef_email_shadow_log:<msg_id_hash>`, 30-day TTL.
- Daily cap `CLEF_EMAIL_DAILY_CALL_CAP` (1000) at `clef:calls:clef_email:<day>` (soft, KV not atomic).
- Kill switch: KV `clef:mode:global` or `clef:mode:clef_email` = `off`. Default mode shadow; `live` is not honored.

## Deploy (only after merge + John OK)
Create a KV namespace, replace the placeholder id in wrangler.toml, `wrangler secret put CLEF_EMAIL_SHADOW_TOKEN`.
