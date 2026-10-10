import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { Env } from "../src/env.js";
import worker from "../src/index.js";

const TOKEN_KEY = "notion_verification_token";
const COALESCE_BUF_KEY = "coalesce_buffer";
const GATE_BOT = "3d87d7f5-6298-8165-8af9-0027a153ccbd";
const GATE_DB = "b25a26f0-5464-476b-afb3-da4257e2a53b";
const OTHER_DB = "11111111-2222-3333-4444-555555555555";

function signBody(body: string, token: string): string {
  const mac = createHmac("sha256", token).update(body).digest("hex");
  return `sha256=${mac}`;
}

function makeEnv(kvStore: Map<string, string>): Env {
  const kv = {
    get: async (key: string) => kvStore.get(key) ?? null,
    put: async (key: string, value: string) => {
      kvStore.set(key, value);
    },
    delete: async (key: string) => {
      kvStore.delete(key);
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async (key: string) => ({
      value: kvStore.get(key) ?? null,
      metadata: null,
      cacheStatus: null,
    }),
  } as unknown as KVNamespace;
  return {
    RELAY_KV: kv,
    COS_WEBHOOK_URL: "https://cos.example/webhook",
    COS_WEBHOOK_AUTHORIZATION: "Bearer cos",
    SETUP_SECRET: "setup",
    NOTION_VERIFICATION_TOKEN: "secret_test_token",
    GATE_LOG_DATA_SOURCE_IDS: `af0ab5b0-2d9d-42bb-9621-526198146e46,${GATE_DB}`,
    GATE_LOG_BOT_NOTION_USER_IDS: GATE_BOT,
    FLEET_COMMENTS_BOT_NOTION_USER_IDS: GATE_BOT,
  };
}

function pagePropertiesUpdatedPayload(parentDatabaseId: string): Record<string, unknown> {
  return {
    type: "page.properties_updated",
    authors: [{ id: GATE_BOT, type: "bot" }],
    entity: { id: "page-abc", type: "page" },
    data: {
      parent: { type: "database_id", database_id: parentDatabaseId },
      updated_properties: ["prop-1"],
    },
  };
}

describe("index forward gate log", () => {
  test("bot page.properties_updated on non-gate-log parent is buffered", async () => {
    const kvStore = new Map<string, string>([[TOKEN_KEY, "secret_test_token"]]);
    const env = makeEnv(kvStore);
    const body = JSON.stringify(pagePropertiesUpdatedPayload(OTHER_DB));
    const signature = signBody(body, "secret_test_token");
    const ctx = { waitUntil() {} } as unknown as ExecutionContext;

    const res = await worker.fetch(
      new Request("https://relay/", {
        method: "POST",
        headers: {
          "X-Notion-Signature": signature,
          "content-type": "application/json",
          "user-agent": "notion",
        },
        body,
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const bufRaw = await env.RELAY_KV.get(COALESCE_BUF_KEY);
    expect(bufRaw).toBeTruthy();
    const buf = JSON.parse(bufRaw!) as unknown[];
    expect(buf.length).toBe(1);
  });

  test("gate log database parent is not buffered on real path", async () => {
    const kvStore = new Map<string, string>([[TOKEN_KEY, "secret_test_token"]]);
    const env = makeEnv(kvStore);
    const body = JSON.stringify(pagePropertiesUpdatedPayload(GATE_DB));
    const signature = signBody(body, "secret_test_token");
    const ctx = { waitUntil() {} } as unknown as ExecutionContext;

    const res = await worker.fetch(
      new Request("https://relay/", {
        method: "POST",
        headers: {
          "X-Notion-Signature": signature,
          "content-type": "application/json",
          "user-agent": "notion",
        },
        body,
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const bufRaw = await env.RELAY_KV.get(COALESCE_BUF_KEY);
    expect(bufRaw).toBeNull();
  });
});
