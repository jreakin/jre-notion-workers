import { describe, expect, test, mock, afterEach, spyOn } from "bun:test";
import { createHmac } from "node:crypto";
import type { Env } from "../src/env.js";
import * as gateOrchestration from "../src/wake-gate/gate-orchestration.js";

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

async function postWebhook(env: Env, payload: Record<string, unknown>): Promise<Response> {
  const body = JSON.stringify(payload);
  const signature = signBody(body, "secret_test_token");
  const ctx = { waitUntil() {} } as unknown as ExecutionContext;
  const { default: worker } = await import("../src/index.js");
  return worker.fetch(
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
}

describe("index forward gate log", () => {
  afterEach(() => {
    mock.restore();
  });

  test("bot page.properties_updated on non-gate-log parent is buffered", async () => {
    const kvStore = new Map<string, string>([[TOKEN_KEY, "secret_test_token"]]);
    const env = makeEnv(kvStore);
    const res = await postWebhook(env, pagePropertiesUpdatedPayload(OTHER_DB));
    expect(res.status).toBe(200);
    const bufRaw = await env.RELAY_KV.get(COALESCE_BUF_KEY);
    expect(bufRaw).toBeTruthy();
    const buf = JSON.parse(bufRaw!) as unknown[];
    expect(buf.length).toBe(1);
  });

  test("gate log database parent is not buffered on real path", async () => {
    const kvStore = new Map<string, string>([[TOKEN_KEY, "secret_test_token"]]);
    const env = makeEnv(kvStore);
    const res = await postWebhook(env, pagePropertiesUpdatedPayload(GATE_DB));
    expect(res.status).toBe(200);
    const bufRaw = await env.RELAY_KV.get(COALESCE_BUF_KEY);
    expect(bufRaw).toBeNull();
  });

  test("updated_properties with non-string elements still buffers one event", async () => {
    const kvStore = new Map<string, string>([[TOKEN_KEY, "secret_test_token"]]);
    const env = makeEnv(kvStore);
    const payload = pagePropertiesUpdatedPayload(OTHER_DB);
    (payload.data as Record<string, unknown>).updated_properties = [{ toString: 1 }];
    const res = await postWebhook(env, payload);
    expect(res.status).toBe(200);
    const buf = JSON.parse((await env.RELAY_KV.get(COALESCE_BUF_KEY)) ?? "[]") as unknown[];
    expect(buf.length).toBe(1);
  });

  test("buildGateContext throw still buffers one event", async () => {
    const spy = spyOn(gateOrchestration, "buildGateContext").mockImplementation(() => {
      throw new TypeError("mock_throw");
    });
    const kvStore = new Map<string, string>([[TOKEN_KEY, "secret_test_token"]]);
    const env = makeEnv(kvStore);
    const res = await postWebhook(env, pagePropertiesUpdatedPayload(OTHER_DB));
    spy.mockRestore();
    expect(res.status).toBe(200);
    const buf = JSON.parse((await env.RELAY_KV.get(COALESCE_BUF_KEY)) ?? "[]") as unknown[];
    expect(buf.length).toBe(1);
  });

  test("non-string gate env ids still buffer one event", async () => {
    const kvStore = new Map<string, string>([[TOKEN_KEY, "secret_test_token"]]);
    const env = makeEnv(kvStore) as Env & Record<string, unknown>;
    env.GATE_LOG_DATA_SOURCE_IDS = 12345 as unknown as string;
    env.JOHN_NOTION_USER_IDS = { bad: true } as unknown as string;
    const res = await postWebhook(env, pagePropertiesUpdatedPayload(OTHER_DB));
    expect(res.status).toBe(200);
    const buf = JSON.parse((await env.RELAY_KV.get(COALESCE_BUF_KEY)) ?? "[]") as unknown[];
    expect(buf.length).toBe(1);
  });

});
