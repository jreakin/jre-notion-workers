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
- Excluded entirely: anything for `jre@mail.grokbot.com`: override `grokbot_inbox`, a grokbot mailbox, a sender domain of
  `mail.grokbot.com` (or a subdomain), or the address anywhere in the body (any case, any `jre+alias@`). Only a KV counter
  `clef_email:excluded:<day>` is bumped; no log row.
- **Box-side contract (required):** payload v1 carries no to/cc/delivered-to addresses, so Inbox Triage MUST send
  `override:"grokbot_inbox"` for anything to/cc/delivered-to/from `jre@mail.grokbot.com`, including `+` aliases.
- Never-Clef overrides (`known_person`, money, security, calendar, legal, tesla, x_notify, plus known domains) ⇒
  `clef_called:false`, `shadow_label:"escalate"`.
- AI Gateway calls send `{ id, collectLog: false, skipCache: true }` (no metadata) so the masked subject/snippet are not
  logged or cached by the gateway. The relay keeps its plain `{ id }`.
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

## Deploy checklist (only after #33 merges and John OKs)
1. `bun test` + `tsc --noEmit` green.
2. `wrangler kv namespace create` and replace the placeholder id in `wrangler.toml`.
3. `wrangler secret put CLEF_EMAIL_SHADOW_TOKEN`; box copy in 1Password scoped to this route.
4. **Turn off logging for email in the AI Gateway `clef-shadow-gate`** (dashboard: log collection off) and set a rate
   limit — second layer behind the per-request `collectLog:false`. Not changed by this PR.
5. Model slugs `@cf/cloudflare/clef` / `@cf/cloudflare/clef-flash` (confirmed in Cloudflare docs 2026-10-13). Run
   `wrangler deploy --dry-run` on Node ≥ 22, then deploy with mode shadow.
6. Smoke test: no auth → 401; auth → 202 + a Workers Logs row with no subject/snippet; grokbot payload → no row, counter only.
7. Inbox Triage (its own lane): send `override:"grokbot_inbox"` for to/cc/delivered-to/from jre@ incl. `+` aliases.
8. Go live only after 14 days with zero false skips and John's sign-off.
