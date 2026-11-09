# Clef scoring plan (relay wake gate, shadow only)

Goal: grade each `clef_wake_shadow` decision against what actually happened, so a skip rule can be judged
on evidence before anything goes live. This plan adds **no run-receipt fields now**; it uses the join keys the
relay already logs and proposes a later receipt shape.

## Join keys (already logged, no change)

| Key | Value | Where |
|---|---|---|
| `event_key` | `ev:<hex>`: hash of the webhook `id` (`id:<id>`); raw body hash only when `id` is missing | every `clef_wake_shadow` and `cos_prefilter` row (`opaqueEventKey`) |
| `item_id` | `opaque:<hex>`: 32-bit hash of the normalized Notion page id | Clef rows (`opaqueLogItemId`) |

Notes:
- `event_key` is the exact join: one webhook delivery, all of its rows (prefilter, Clef, rule-skip check,
  echo row, echo score row).
- `item_id` is per page, so it groups many events. For LOCK-69 echo rows on comments it hashes the **comment** id
  (the wake path hashes the page id), so join comment echo rows by `event_key`, not `item_id`.
- `item_id` is a 32-bit hash: collisions are possible across a large window. Treat it as a grouping key, not identity.
- Neither key is reversible from the log alone. A grader that needs page-level truth hashes the page ids it already
  holds with the same function and compares hashes; raw ids never enter the log.

## Ground truth per event type

"Acted" means CoS (or an agent it woke) did something attributable to that item after the event.

| Event | Ground truth "should have woken" | Ground truth "quiet was fine" |
|---|---|---|
| `comment.created` | CoS replied in the thread, or acted on the page (edit, task, message) within the window | no reply and no action on the item |
| `page.created` | CoS triaged the page (property change, comment, task, routed it) | page untouched by CoS |
| `page.properties_updated` (tracked parent) | CoS acted on the item after the edit (Needs John, Submitted, status) | no CoS action; the edit was bookkeeping |
| `page.properties_updated` (untracked property) | rare: CoS acted anyway (that is an echo-filter miss) | default |
| `page.content_updated` / others | CoS acted on the page | default |

Comments are the cleanest signal: "did CoS reply or act" is directly observable. Page events need an attributable
CoS action; edits by other agents or John do not count.

## How the join works

1. Steward/BCH exports a window of `clef_wake_shadow` rows from `gate_log:v1:<day>:` (masked, see README
   "Offline Clef replay harness").
2. CoS run receipts for the same window say which items each run acted on (below).
3. Join on `event_key` when the receipt carries it, else on `item_id` + time window.
4. Label each row: `acted` / `quiet` / `unknown` (no receipt covers it).
5. Score the rule: false skip = Clef/rule skip on an `acted` row; wasted wake = wake on a `quiet` row.
   Report coverage (labelled / total) beside every rate.

## Proposed RunReceipt v2 (later, not in this change)

Only hashes, never titles or ids:

```json
{
  "v": 2,
  "event_keys": ["ev:<hex>", "ev:<hex>"],
  "items": [
    { "item_id": "opaque:<hex>", "outcome": "acted" },
    { "item_id": "opaque:<hex>", "outcome": "quiet" }
  ]
}
```

- `event_keys`: every webhook delivery the run consumed, as the relay's `ev:` hashes (pattern `^ev:[0-9a-f]+$`).
  CoS already receives each raw webhook (with its `id`), so it can recompute the key with the same hash
  (`opaqueEventKey`); the alternative is the relay adding `event_key` to the forwarded payload (a wire change).
- `items[].outcome`: per item the run touched or was woken for, `acted` or `quiet`, using `opaque:` hashes
  (pattern `^opaque:[0-9a-f]+$`).

## Caveat: 20 s coalescing

The relay buffers forwarded events and flushes them to CoS in one batch about 20 s later
(`COALESCE_MS = 20_000`). One CoS run therefore covers several events and items:

- A run-level "acted" cannot be credited to every event in the batch. Use per-item `outcome`, not run-level.
- Several events on one item in one batch share one outcome. Grade per (item, batch), not per event, or
  bursts inflate both hits and misses.
- Events dropped live (LOCK-69 echo filter) never reach CoS, so they have no receipt. Their truth comes only from
  later activity on the item (for example, John asking again), so label them `unknown` unless such evidence exists.

## What `candidate_false_skip` means today

`candidate_false_skip: true` on a `decision:"rule_skip"` row means **Clef disagreed with the skip** (Clef said
`would_wake`). It does **not** mean the skip was wrong. Until rows are joined to ground truth:

- Report these as "disagreements", not "false skips".
- A true false skip is `candidate_false_skip` **and** ground truth `acted`.
- `gradeRelayWindow` currently fails a window on any scored `candidate_false_skip`, which includes the sampled
  echo-filter score rows (`source:"echo_filter"`). That is conservative by design; read failures with this in mind.

## Order of work

1. Now: replay harness (Mode A on exported rows, Mode B on masked fixtures). No receipts needed.
2. Next: CoS emits per-item `acted`/`quiet` with `opaque:` hashes; Steward joins by `item_id` + window.
3. Later: relay forwards `event_key`, CoS echoes it in `event_keys`; switch the join to `event_key`.
4. Only then: grade skip rules on `acted` truth and bring the numbers to John. No gate goes live from this plan.
