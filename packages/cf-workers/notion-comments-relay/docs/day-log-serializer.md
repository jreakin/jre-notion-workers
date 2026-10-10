# Day Log writer serializer (design note)

## Problem

On 2026-10-08 ~01:40, four fires about one second apart created **two** Day Log pages — a create race in the downstream writer (not in this repo).

Those four events were **cross-isolate**: they hit different Cloudflare Worker isolates, so in-memory mutual exclusion cannot see them.

## Finding

There is **no** Day Log create/write path under `packages/cf-workers/notion-comments-relay` or sibling packages in `jre-notion-workers`. The race belongs to the Abstract Secretary / ad-docs-webhook stack that materializes Day Log pages in Notion.

## Shipped helper (isolate-only)

`src/day-log/serialize-key.ts` exports `runSerializedByKey(key, { pageId? }, work)`:

- Per-key mutual exclusion **inside one Worker isolate** (microtask-coalesced waiters).
- Bursts in the **same isolate** coalesce: one `work({ pageIds })` sees every page id accumulated for that key.
- **Not** a fix for cross-request or cross-isolate Day Log races (the 10/8 incident).
- Followers enqueue their own `work` functions, but **only the leader's `work` runs**; the same return value is shared. Every caller must pass **identical, idempotent** `work` logic.
- Idle lanes are removed from the in-memory map after completion (no KV persistence).

## What would actually fix cross-isolate races

One of:

1. **Durable Object** keyed by `day-log:{operator}:{date}` running create-or-get single-threaded (needs binding + migration in `wrangler.toml`, John's OK, and provisioning).
2. **Notion-side idempotency key** in the downstream writer (preferred if the writer owns create-or-get).

### Durable Object sketch (not enabled)

```toml
# wrangler.toml — commented out; do not enable without John
# [[durable_objects.bindings]]
# name = "DAY_LOG_SERIALIZER"
# class_name = "DayLogSerializer"
#
# [[migrations]]
# tag = "v1-day-log-serializer"
# new_classes = ["DayLogSerializer"]
```

```typescript
// export class DayLogSerializer {
//   async fetch(request: Request) {
//     // Serialize create-or-get for one operator+date key
//   }
// }
```

## Integration guidance

Wrap Day Log **create-or-get** in `runSerializedByKey` only when all concurrent callers share the **same isolate** (rare for webhook bursts). For production Day Log creation, plan on a DO or Notion idempotency instead.

Do not call the serializer from the shadow wake gate; it is for the writer only.
