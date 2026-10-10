import { describe, expect, test, mock, afterEach } from "bun:test";
import {
  fetchNotionPage,
  NOTION_VERSION_LEGACY,
  NOTION_VERSION_PAGE,
  readDataSourceFromPageParent,
} from "../src/wake-gate/notion-page-fetch.js";
import { AD_DOCS_DATA_SOURCE_ID } from "../src/wake-gate/wake-gate-types.js";
import { resetPageFetchCache } from "../src/wake-gate/page-fetch-cache.js";
import { runShadowWakeGates } from "../src/wake-gate/wake-gate-shadow.js";
import type { Env } from "../src/env.js";

describe("notion page fetch", () => {
  let origFetch: typeof fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
    mock.restore();
    resetPageFetchCache();
  });

  test("readDataSourceFromPageParent prefers data_source_id then database_id", () => {
    expect(
      readDataSourceFromPageParent({
        parent: { type: "data_source_id", data_source_id: "ds-1" },
      }),
    ).toBe("ds-1");
    expect(
      readDataSourceFromPageParent({
        parent: { type: "database_id", database_id: AD_DOCS_DATA_SOURCE_ID },
      }),
    ).toBe(AD_DOCS_DATA_SOURCE_ID);
  });

  test("fetch uses Notion-Version header and URL-encodes page id", async () => {
    origFetch = globalThis.fetch;
    const calls: { url: string; version: string | null }[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers = init?.headers as Record<string, string> | undefined;
      calls.push({
        url,
        version: headers?.["notion-version"] ?? null,
      });
      return Response.json({
        parent: { database_id: AD_DOCS_DATA_SOURCE_ID },
        properties: {},
      });
    }) as unknown as typeof fetch;

    await fetchNotionPage("tok", "page/with/slash", NOTION_VERSION_PAGE);
    expect(calls[0]?.version).toBe(NOTION_VERSION_PAGE);
    expect(calls[0]?.url).toContain(encodeURIComponent("page/with/slash"));

    await fetchNotionPage("tok", "p2", NOTION_VERSION_LEGACY);
    expect(calls[1]?.version).toBe(NOTION_VERSION_LEGACY);
  });

  test("comment.created on Needs John page reaches needs_john via database_id parent", async () => {
    origFetch = globalThis.fetch;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = ((line: unknown) => {
      logs.push(String(line));
    }) as typeof console.log;

    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const version =
        (init?.headers as Record<string, string> | undefined)?.["notion-version"] ?? "";
      if (version === NOTION_VERSION_LEGACY) {
        return Response.json({
          parent: { type: "database_id", database_id: AD_DOCS_DATA_SOURCE_ID },
          properties: {},
        });
      }
      return Response.json({
        parent: { type: "data_source_id", data_source_id: AD_DOCS_DATA_SOURCE_ID },
        properties: {
          Name: { type: "title", title: [{ plain_text: "Comment target" }] },
          "Needs John": { type: "checkbox", checkbox: true },
          Sensitive: { type: "checkbox", checkbox: false },
          Kind: { type: "select", select: { name: "Other" } },
          "Source Repo": { type: "rich_text", rich_text: [{ plain_text: "x" }] },
          "Document Type": { type: "select", select: { name: "Report" } },
        },
      });
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
        type: "comment.created",
        entity: { id: "c1", type: "comment" },
        authors: [{ id: "human-1" }],
        data: { page_id: "page-abc", parent: { type: "page", id: "page-abc" } },
      },
      "comment.created",
    );

    console.log = origLog;
    const line = JSON.parse(logs.find((l) => l.includes("ad_docs_wake_gate_shadow")) ?? "{}");
    expect(line.decision).toBe("would_wake");
    expect(line.reason).toBe("needs_john");
  });
});
