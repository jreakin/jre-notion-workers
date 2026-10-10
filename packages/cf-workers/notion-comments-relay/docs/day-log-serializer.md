# Day Log writer serializer (design note)

## Problem

On 2026-10-08 ~01:40, four fires about one second apart created **two** Day Log pages — a create race in the downstream writer (not in this repo).

## Finding

There is **no** Day Log create/write path under `packages/cf-workers/notion-comments-relay` or sibling packages in `jre-notion-workers`. The race belongs to the Abstract Secretary / ad-docs-webhook stack that materializes Day Log pages in Notion.

## Shipped helper

`src/day-log/serialize-key.ts` exports `runSerializedByKey(env, key, { pageId? }, work)`:

- Per-key mutual exclusion inside a Worker isolate (microtask-coalesced waiters).
- Bursts coalesce: one `work({ pageIds })` sees every page id accumulated for that key.
- Best-effort KV buffer `daylog:buf:{key}` for cross-request handoff (try/caught).
- **Durable Object–free** — uses existing `RELAY_KV` only.

## Integration guidance

Wrap the existing Day Log **create-or-get** in `runSerializedByKey` using a stable key (e.g. `day-log:{operatorId}:{YYYY-MM-DD}`). The work function must:

1. List all `pageIds` since the last cursor in one wake.
2. Create the Day Log page once (idempotent create-or-get).

Do not call the serializer from the shadow wake gate; it is for the writer only.
