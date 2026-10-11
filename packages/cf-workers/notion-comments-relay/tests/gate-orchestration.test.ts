import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { runHarnessRuleShadowGates } from "../src/wake-gate/gate-orchestration.js";
import type { Env } from "../src/env.js";

const FLEET_DS = "6e0a45b3-eb3f-448f-b215-49e002bfeff3";
const OTHER_DS = "11111111-2222-3333-4444-555555555555";
const PAGE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("gate-orchestration enrich", () => {
  let logs: string[] = [];
  let kvPuts: string[] = [];
  let origFetch: typeof fetch;
  let origLog: typeof console.log;

  beforeEach(() => {
    logs = [];
    kvPuts = [];
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

  function mockEnv(overrides: Partial<Env> = {}): Env {
    const store = new Map<string, string>();
    return {
      RELAY_KV: {
        get: async (k: string) => store.get(k) ?? null,
        put: async (k: string, v: string) => {
          kvPuts.push(k);
          store.set(k, v);
        },
        delete: async () => {},
        list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
        getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
      } as unknown as KVNamespace,
      COS_WEBHOOK_URL: "https://example.com",
      COS_WEBHOOK_AUTHORIZATION: "Bearer x",
      SETUP_SECRET: "s",
      NOTION_API_TOKEN: "t",
      FLEET_LOCKS_DATA_SOURCE_ID: FLEET_DS,
      ...overrides,
    };
  }

  test("webhook fleet locks parent mismatch: would_wake unreadable, no adopted-at KV", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        parent: { type: "data_source_id", data_source_id: OTHER_DS },
        properties: {
          Status: { type: "select", select: { name: "Proposed" } },
        },
      }),
    ) as unknown as typeof fetch;

    const env = mockEnv();
    await runHarnessRuleShadowGates(
      env,
      {
        type: "page.properties_updated",
        entity: { id: PAGE_ID, type: "page" },
        data: {
          parent: { data_source_id: FLEET_DS },
          updated_properties: ["]GbO"],
        },
      },
      "page.properties_updated",
      "{}",
      true,
    );

    const fleetDecision = logs
      .map((l) => JSON.parse(l))
      .find((o) => o.gate_name === "fleet_locks_adopted_change");
    expect(fleetDecision?.decision).toBe("would_wake");
    expect(fleetDecision?.reason).toBe("notion_page_unreadable");
    expect(kvPuts.some((k) => k.startsWith("wake_gate_adopted_at:"))).toBe(false);
  });

  test("comment events use data.page_id for context pageId", async () => {
    const env = mockEnv();
    await runHarnessRuleShadowGates(
      env,
      {
        type: "comment.created",
        entity: { id: "comment-entity-id", type: "comment" },
        data: { page_id: PAGE_ID, parent: { data_source_id: FLEET_DS } },
      },
      "comment.created",
      "{}",
      true,
    );
    const clefLine = logs
      .map((l) => JSON.parse(l))
      .find((o) => o.stream === "clef_wake_shadow");
    expect(clefLine?.item_id).not.toBe("comment-entity-id");
  });

  test("harness recent-page dedupe KV only when WAKE_GATE_DEDUPE=1", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        parent: { type: "data_source_id", data_source_id: FLEET_DS },
        properties: {},
      }),
    ) as unknown as typeof fetch;

    const off = mockEnv();
    kvPuts = [];
    await runHarnessRuleShadowGates(
      off,
      {
        type: "page.properties_updated",
        entity: { id: PAGE_ID, type: "page" },
        data: { parent: { data_source_id: FLEET_DS } },
      },
      "page.properties_updated",
      "{}",
      true,
    );
    expect(kvPuts.filter((k) => k.startsWith("wake_gate_recent_page:"))).toHaveLength(0);

    const on = mockEnv({ WAKE_GATE_DEDUPE: "1" });
    kvPuts = [];
    await runHarnessRuleShadowGates(
      on,
      {
        type: "page.properties_updated",
        entity: { id: PAGE_ID, type: "page" },
        data: { parent: { data_source_id: FLEET_DS } },
      },
      "page.properties_updated",
      "{}",
      true,
    );
    expect(kvPuts.some((k) => k.startsWith("wake_gate_recent_page:"))).toBe(true);
  });
});
