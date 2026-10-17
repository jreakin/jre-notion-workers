import { afterEach, expect, test } from "bun:test";
import worker from "../src/index.js";
import { COALESCE_MAX_ATTEMPTS, coalesceBackingOff, coalesceRetryDelayMs } from "../src/coalesce-backoff.js";
import type { Env } from "../src/env.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function memKv(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  const writes: string[] = [];
  const kv = {
    get: async (k: string) => data.get(k) ?? null,
    put: async (k: string, v: string) => {
      writes.push(k);
      data.set(k, v);
    },
    delete: async (k: string) => {
      writes.push(`del:${k}`);
      data.delete(k);
    },
  } as unknown as KVNamespace;
  return { kv, data, writes };
}

function envWith(kv: KVNamespace): Env {
  return { RELAY_KV: kv, COS_WEBHOOK_URL: "https://cos.invalid/hook", COS_WEBHOOK_AUTHORIZATION: "a", SETUP_SECRET: "s" } as Env;
}

const ctx = { waitUntil() {} } as unknown as ExecutionContext;
const item = (extra: Record<string, unknown> = {}) => ({ at: "t", notion_type: "page.created", body: "{}", signature: null, ...extra });

test("retry delay: 1, 2, 4, 8, then capped at 15 min", () => {
  expect([1, 2, 3, 4, 5, 9].map(coalesceRetryDelayMs)).toEqual([60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
});

test("backing off only when the oldest item's next_at is in the future", () => {
  expect(coalesceBackingOff([], 10)).toBe(false);
  expect(coalesceBackingOff([item()], 10)).toBe(false);
  expect(coalesceBackingOff([item({ next_at: 11 })], 10)).toBe(true);
  expect(coalesceBackingOff([item({ next_at: 10 })], 10)).toBe(false);
});

test("cron tick while a failed batch backs off: zero KV writes, no forward", async () => {
  const { kv, writes } = memKv({ coalesce_buffer: JSON.stringify([item({ attempts: 1, next_at: Date.now() + 60_000 })]) });
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  for (let i = 0; i < 10; i += 1) await worker.scheduled!({} as ScheduledController, envWith(kv), ctx);
  expect(calls).toBe(0);
  expect(writes.filter((w) => w !== "kv:writes" && !w.startsWith("kv:writes"))).toEqual([]);
});

test("upstream 400 (rate limit): buffer restored with attempts + next_at; one forward_history write, no last_forward", async () => {
  const { kv, data, writes } = memKv({ coalesce_buffer: JSON.stringify([item()]) });
  globalThis.fetch = (async () =>
    new Response('{"success":false,"error":"Automation run rate limit exceeded"}', { status: 400 })) as unknown as typeof fetch;
  const before = Date.now();
  await worker.scheduled!({} as ScheduledController, envWith(kv), ctx);
  const buf = JSON.parse(data.get("coalesce_buffer") ?? "[]");
  expect(buf.length).toBe(1);
  expect(buf[0].attempts).toBe(1);
  expect(buf[0].next_at).toBeGreaterThanOrEqual(before + 60_000);
  expect(writes.filter((w) => w === "forward_history").length).toBe(1);
  expect(writes).not.toContain("last_forward");
  // next tick is a no-op
  const n = writes.length;
  await worker.scheduled!({} as ScheduledController, envWith(kv), ctx);
  expect(writes.length).toBe(n);
});

test("after COALESCE_MAX_ATTEMPTS failures the item is dropped", async () => {
  const { kv, data } = memKv({ coalesce_buffer: JSON.stringify([item({ attempts: COALESCE_MAX_ATTEMPTS - 1, next_at: 0 })]) });
  globalThis.fetch = (async () => new Response("{}", { status: 400 })) as unknown as typeof fetch;
  await worker.scheduled!({} as ScheduledController, envWith(kv), ctx);
  expect(data.get("coalesce_buffer")).toBeUndefined();
});

test("success clears the buffer", async () => {
  const { kv, data } = memKv({ coalesce_buffer: JSON.stringify([item({ attempts: 2, next_at: 0 })]) });
  globalThis.fetch = (async () => new Response('{"success":true}', { status: 200 })) as unknown as typeof fetch;
  await worker.scheduled!({} as ScheduledController, envWith(kv), ctx);
  expect(data.get("coalesce_buffer")).toBeUndefined();
  expect(JSON.parse(data.get("forward_history") ?? "[]")[0].status).toBe(200);
});
