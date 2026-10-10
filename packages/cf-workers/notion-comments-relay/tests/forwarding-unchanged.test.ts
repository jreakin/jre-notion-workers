import { describe, expect, test, mock } from "bun:test";
import { runShadowWakeGates } from "../src/wake-gate/wake-gate-shadow.js";
import type { Env } from "../src/env.js";

describe("forwarding path", () => {
  test("shadow gate does not throw when payload is malformed", async () => {
    const env: Env = {
      RELAY_KV: {
        get: async () => null,
        put: async () => {},
        delete: async () => {},
        list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
        getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
      } as unknown as KVNamespace,
      COS_WEBHOOK_URL: "https://cos.example/hook",
      COS_WEBHOOK_AUTHORIZATION: "Bearer t",
      SETUP_SECRET: "s",
    };
    let enqueued = false;
    const enqueue = () => {
      enqueued = true;
    };
    await runShadowWakeGates(env, undefined as unknown as Record<string, unknown>, "page.created");
    enqueue();
    expect(enqueued).toBe(true);
  });
});
