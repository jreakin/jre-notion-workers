import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { runShadowWakeGates } from "../src/wake-gate/wake-gate-shadow.js";
import { AD_DOCS_DATA_SOURCE_ID } from "../src/wake-gate/wake-gate-types.js";
import { resetPageFetchCache } from "../src/wake-gate/page-fetch-cache.js";
import type { Env } from "../src/env.js";

/** Distinct from AD_DOCS_DATA_SOURCE_ID — simulates 2022-06-28 database_id parent. */
const TEST_AD_DOCS_DATABASE_ID = "11111111-1111-4111-8111-111111111111";

function mockKvEnv(overrides: Partial<Env> = {}): Env {
  return {
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
    AD_DOCS_DATABASE_ID: TEST_AD_DOCS_DATABASE_ID,
    ...overrides,
  } as Env;
}

function adDocsPage(needsJohn: boolean, title: string) {
  return {
    parent: { type: "database_id", database_id: TEST_AD_DOCS_DATABASE_ID },
    properties: {
      Name: { type: "title", title: [{ plain_text: title }] },
      "Needs John": { type: "checkbox", checkbox: needsJohn },
      Sensitive: { type: "checkbox", checkbox: false },
      Kind: { type: "select", select: { name: "Other" } },
      "Source Repo": { type: "rich_text", rich_text: [] },
      "Document Type": { type: "select", select: { name: "Report" } },
    },
  };
}

describe("comment parent cache (S3)", () => {
  let logs: string[] = [];
  let origFetch: typeof fetch;
  let origLog: typeof console.log;

  beforeEach(() => {
    logs = [];
    resetPageFetchCache();
    origFetch = globalThis.fetch;
    origLog = console.log;
    console.log = ((line: unknown) => {
      logs.push(String(line));
    }) as typeof console.log;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    console.log = origLog;
    resetPageFetchCache();
    mock.restore();
  });

  const commentFixture = {
    type: "comment.created",
    entity: { id: "c1", type: "comment" },
    authors: [{ id: "human-1" }],
    data: { page_id: "probe-page", parent: { type: "page", id: "probe-page" } },
  };

  test("second comment refetches properties after Needs John flips (not stale template skip)", async () => {
    let fetchCalls = 0;
    globalThis.fetch = mock(async () => {
      fetchCalls += 1;
      const needsJohn = fetchCalls >= 3;
      return Response.json(adDocsPage(needsJohn, "Template: draft"));
    }) as unknown as typeof fetch;

    const env = mockKvEnv();
    await runShadowWakeGates(env, commentFixture, "comment.created");
    await runShadowWakeGates(env, commentFixture, "comment.created");

    const shadowLines = logs
      .filter((l) => l.includes("ad_docs_wake_gate_shadow"))
      .map((l) => JSON.parse(l) as { decision: string; reason: string });
    expect(shadowLines[0]?.reason).toBe("template_or_test_title");
    expect(shadowLines[1]?.decision).toBe("would_wake");
    expect(shadowLines[1]?.reason).toBe("needs_john");
    expect(fetchCalls).toBeGreaterThanOrEqual(3);
  });

  test("non-AD page second comment skips Notion fetch via negative parent cache", async () => {
    let fetchCalls = 0;
    globalThis.fetch = mock(async () => {
      fetchCalls += 1;
      return Response.json({
        parent: { type: "database_id", database_id: "other-database-id" },
        properties: {},
      });
    }) as unknown as typeof fetch;

    const env = mockKvEnv();
    const fixture = {
      ...commentFixture,
      data: { page_id: "non-ad-page", parent: { type: "page", id: "non-ad-page" } },
    };
    await runShadowWakeGates(env, fixture, "comment.created");
    await runShadowWakeGates(env, fixture, "comment.created");
    expect(fetchCalls).toBe(1);
  });
});

describe("AD_DOCS_DATABASE_ID membership", () => {
  test("2022-style database_id-only parent matches via env var", async () => {
    const { pageBelongsToAdDocs } = await import("../src/wake-gate/notion-page-fetch.js");
    const page = {
      parent: { type: "database_id", database_id: TEST_AD_DOCS_DATABASE_ID },
      properties: {},
    };
    const m = pageBelongsToAdDocs(page, { AD_DOCS_DATABASE_ID: TEST_AD_DOCS_DATABASE_ID });
    expect(m.isAdDocs).toBe(true);
    expect(m.matchedVia).toBe("database_id");
    expect(m.dataSourceId).toBe(AD_DOCS_DATA_SOURCE_ID);
    expect(m.databaseId).toBe(TEST_AD_DOCS_DATABASE_ID);
  });
});
