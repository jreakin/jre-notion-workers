import { describe, expect, test, beforeEach } from "bun:test";
import {
  runSerializedByKey,
  resetSerializeKeyMemory,
} from "../src/day-log/serialize-key.js";
import type { Env } from "../src/env.js";

function mockEnv(): Env {
  const store = new Map<string, string>();
  const puts: string[] = [];
  return {
    RELAY_KV: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => {
        puts.push(k);
        store.set(k, v);
      },
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
      getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
    } as unknown as KVNamespace,
    COS_WEBHOOK_URL: "u",
    COS_WEBHOOK_AUTHORIZATION: "a",
    SETUP_SECRET: "s",
    _puts: puts,
  } as Env & { _puts: string[] };
}

describe("serialize-key", () => {
  beforeEach(() => resetSerializeKeyMemory());

  test("coalesces burst into one work invocation", async () => {
    const env = mockEnv();
    let runs = 0;
    const work = async (ctx: { pageIds: string[] }) => {
      runs += 1;
      return ctx.pageIds.sort();
    };
    const key = "day-log:2026-10-08";
    const [a, b, c] = await Promise.all([
      runSerializedByKey(env, key, { pageId: "p1" }, work),
      runSerializedByKey(env, key, { pageId: "p2" }, work),
      runSerializedByKey(env, key, { pageId: "p3" }, work),
    ]);
    expect(runs).toBe(1);
    expect(a).toEqual(["p1", "p2", "p3"]);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect((env as Env & { _puts: string[] })._puts).toHaveLength(0);
  });
});
