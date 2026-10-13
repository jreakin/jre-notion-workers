import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { runShadowWakeGates } from "../src/wake-gate/wake-gate-shadow.js";
import { AD_DOCS_DATA_SOURCE_ID } from "../src/wake-gate/wake-gate-types.js";
import type { Env } from "../src/env.js";

const TITLE_SENTINEL = "SENTINEL_TITLE_DO_NOT_LOG";
const AUTHOR_SENTINEL = "SENTINEL_AUTHOR_DO_NOT_LOG";
const PAGE_SENTINEL = "SENTINEL_PAGE_ID_DO_NOT_LOG";

describe("shadow log hygiene", () => {
  let logs: string[] = [];
  let origFetch: typeof fetch;
  let origLog: typeof console.log;

  beforeEach(() => {
    logs = [];
    origFetch = globalThis.fetch;
    origLog = console.log;
    console.log = ((line: unknown) => {
      logs.push(String(line));
    }) as typeof console.log;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    console.log = origLog;
    mock.restore();
  });

  test("sentinels never appear in shadow or fail-open log lines", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error(`${TITLE_SENTINEL} body leak`);
    }) as unknown as typeof fetch;

    const env = {
      RELAY_KV: {
        get: async () => null,
        put: async () => {},
        delete: async () => {},
        list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
        getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
      } as unknown as KVNamespace,
      COS_WEBHOOK_URL: "u",
      COS_WEBHOOK_AUTHORIZATION: "a",
      SETUP_SECRET: "s",
      NOTION_API_TOKEN: "t",
    } as Env;

    await runShadowWakeGates(
      env,
      {
        type: "page.properties_updated",
        entity: { id: PAGE_SENTINEL, type: "page" },
        authors: [{ id: AUTHOR_SENTINEL }],
        data: {
          parent: { data_source_id: AD_DOCS_DATA_SOURCE_ID },
          updated_properties: ["x"],
        },
      },
      "page.properties_updated",
    );

    for (const line of logs) {
      expect(line).not.toContain(TITLE_SENTINEL);
      expect(line).not.toContain(AUTHOR_SENTINEL);
      expect(line).not.toContain(PAGE_SENTINEL);
    }
    const shadow = JSON.parse(logs.find((l) => l.includes("ad_docs_wake_gate_shadow")) ?? "{}");
    expect(shadow.reason).toBe("error:Error");
    expect(shadow).not.toHaveProperty("page_id");
  });

  test("clef shadow KV ring never stores raw page ids when enabled", async () => {
    const store = new Map<string, string>();
    const pageId = "dddddddddddddddddddddddddddddddd";
    globalThis.fetch = mock(async () =>
      Response.json({
        parent: { type: "data_source_id", data_source_id: AD_DOCS_DATA_SOURCE_ID },
        properties: {
          Name: { type: "title", title: [{ plain_text: "Doc" }] },
          "Needs John": { type: "checkbox", checkbox: true },
          Sensitive: { type: "checkbox", checkbox: false },
          Kind: { type: "select", select: { name: "Decision" } },
          "Source Repo": { type: "rich_text", rich_text: [{ plain_text: "x" }] },
          "Document Type": { type: "select", select: { name: "Report" } },
        },
      }),
    ) as unknown as typeof fetch;

    const env = {
      RELAY_KV: {
        get: async (k: string) => store.get(k) ?? null,
        put: async (k: string, v: string) => {
          store.set(k, v);
        },
        delete: async () => {},
        list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
        getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
      } as unknown as KVNamespace,
      COS_WEBHOOK_URL: "u",
      COS_WEBHOOK_AUTHORIZATION: "a",
      SETUP_SECRET: "s",
      NOTION_API_TOKEN: "t",
      CLEF_DEFAULT_MODE: "off",
    } as Env;

    await runShadowWakeGates(
      env,
      {
        type: "page.properties_updated",
        entity: { id: pageId, type: "page" },
        data: {
          parent: { data_source_id: AD_DOCS_DATA_SOURCE_ID },
          updated_properties: ["x"],
        },
      },
      "page.properties_updated",
    );

    for (const [k, v] of store) {
      if (k.startsWith("gate_log:v1:")) expect(v).not.toContain(pageId);
    }
  });
});
