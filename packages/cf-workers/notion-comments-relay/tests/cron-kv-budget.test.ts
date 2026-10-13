import { expect, test } from "bun:test";
import worker from "../src/index.js";
import type { Env } from "../src/env.js";

test("cron tick with empty coalesce buffer performs zero KV writes", async () => {
  let writes = 0;
  const env = {
    RELAY_KV: {
      get: async () => null,
      put: async () => {
        writes += 1;
      },
      delete: async () => {
        writes += 1;
      },
    } as unknown as KVNamespace,
    COS_WEBHOOK_URL: "u",
    COS_WEBHOOK_AUTHORIZATION: "a",
    SETUP_SECRET: "s",
  } as Env;
  for (let i = 0; i < 60; i += 1) {
    await worker.scheduled!({} as ScheduledController, env, { waitUntil() {} } as unknown as ExecutionContext);
  }
  expect(writes).toBe(0);
});
