import { describe, expect, test } from "bun:test";
import { buildClefStateString } from "../src/wake-gate/clef-state.js";
import type { Env } from "../src/env.js";
import { buildGateContext, enrichContextFromNotionPage } from "../src/wake-gate/gate-orchestration.js";
import type { GateEventContext } from "../src/wake-gate/gate-event-types.js";
import { FLEET_ARTIFACTS_DATA_SOURCE_ID } from "../src/wake-gate/echo-filter-config.js";
import { AD_DOCS_DATA_SOURCE_ID } from "../src/wake-gate/wake-gate-types.js";

function baseCtx(overrides: Partial<GateEventContext> = {}): GateEventContext {
  return {
    notionType: "page.properties_updated",
    rawBody: "{}",
    isCommentEvent: false,
    propertiesAvailable: false,
    properties: {},
    johnUserIds: new Set(),
    fleetCommentsBotIds: new Set(),
    submittedPropertyIds: new Set(),
    nonSubmittedPropertyIds: new Set(),
    updatedPropertyIds: [],
    ...overrides,
  };
}

describe("clef-state", () => {
  test("needs_john and sensitive unknown without fetched properties on page events", () => {
    const state = buildClefStateString(baseCtx(), "page.properties_updated", {}, 0, false);
    expect(state).toContain("needs_john=unknown");
    expect(state).toContain("sensitive=unknown");
  });

  test("title injection cannot forge needs_john key line", () => {
    const state = buildClefStateString(
      baseCtx({
        propertiesAvailable: true,
        properties: { title: 'x"\nneeds_john=false' },
      }),
      "page.properties_updated",
      {},
      0,
      false,
    );
    expect(state).toContain('title="x\\" needs_john=false"');
    expect(state.split("\n").filter((line) => line.startsWith("needs_john=")).length).toBe(1);
  });

  test("sanitize strips line/paragraph separators and C1 controls", () => {
    const state = buildClefStateString(
      baseCtx({
        propertiesAvailable: true,
        properties: { title: "a\u2028b\u2029c\u0081d" },
      }),
      "page.properties_updated",
      {},
      0,
      false,
    );
    expect(state).toContain('title="a b cd"');
    expect(state).not.toContain("\u2028");
  });

  test("target_lane is unknown and never copies author_lane", () => {
    const state = buildClefStateString(
      baseCtx({ propertiesAvailable: true, properties: { authorLane: "Lane A" } }),
      "page.properties_updated",
      {},
      0,
      false,
    );
    expect(state).toContain("author_lane=Lane A");
    expect(state).toContain("target_lane=unknown");
    expect(state).not.toContain("target_lane=Lane A");
  });

  test("parent_db prefers the config name over a webhook title, then falls back", () => {
    const named = buildClefStateString(
      baseCtx({ parentDbConfigName: "Fleet: Locks", parentDatabaseTitle: "Webhook Title" }),
      "page.properties_updated",
      {},
      0,
      false,
    );
    expect(named).toContain("parent_db=Fleet: Locks");
    const titled = buildClefStateString(
      baseCtx({ parentDatabaseTitle: "Webhook Title" }),
      "page.properties_updated",
      {},
      0,
      false,
    );
    expect(titled).toContain("parent_db=Webhook Title");
    expect(buildClefStateString(baseCtx(), "page.created", {}, 0, false)).toContain("parent_db=unknown");
  });
});

describe("clef-state parent_db from tracked config", () => {
  const FLEET_DS = "f1ee7000-0000-4000-8000-000000000001";
  const TRACKED_DS = "7aac0000-0000-4000-8000-000000000002";
  const UNTRACKED_DS = "0dd00000-0000-4000-8000-000000000003";

  function env(o: Partial<Env> = {}): Env {
    return {
      RELAY_KV: {} as KVNamespace,
      COS_WEBHOOK_URL: "u",
      COS_WEBHOOK_AUTHORIZATION: "a",
      SETUP_SECRET: "s",
      FLEET_LOCKS_DATA_SOURCE_ID: FLEET_DS,
      TRACKED_DATA_SOURCE_IDS: `${TRACKED_DS},${FLEET_ARTIFACTS_DATA_SOURCE_ID}`,
      ...o,
    };
  }

  function stateFor(parent: Record<string, unknown>, e: Env = env()): string {
    const parsed = {
      type: "page.properties_updated",
      entity: { id: "fa4e0000-0000-4000-8000-00000000000a", type: "page" },
      data: { parent, updated_properties: ["fake"] },
    };
    const ctx = buildGateContext(parsed, "page.properties_updated", "{}", e);
    return buildClefStateString(ctx, "page.properties_updated", parsed, 0, false);
  }

  test("named configured sources map to their config names (dashless compare)", () => {
    expect(stateFor({ type: "data_source_id", data_source_id: FLEET_DS.replace(/-/g, "") })).toContain(
      "parent_db=Fleet: Locks",
    );
    expect(stateFor({ type: "data_source_id", data_source_id: AD_DOCS_DATA_SOURCE_ID })).toContain(
      "parent_db=AD Docs",
    );
    expect(stateFor({ type: "data_source_id", data_source_id: FLEET_ARTIFACTS_DATA_SOURCE_ID })).toContain(
      "parent_db=Fleet: Artifacts",
    );
  });

  test("other tracked ids are 'tracked'; data_source parents by id are matched too", () => {
    expect(stateFor({ type: "data_source", id: TRACKED_DS })).toContain("parent_db=tracked");
  });

  test("untracked parent stays unknown (no title in config)", () => {
    expect(stateFor({ type: "data_source_id", data_source_id: UNTRACKED_DS })).toContain("parent_db=unknown");
  });

  test("Fleet: Artifacts is named only when it is tracked", () => {
    const e = env({ TRACKED_DATA_SOURCE_IDS: TRACKED_DS });
    expect(stateFor({ type: "data_source_id", data_source_id: FLEET_ARTIFACTS_DATA_SOURCE_ID }, e)).toContain(
      "parent_db=unknown",
    );
  });

  test("fetched page parent names the db when the webhook had no parent", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ object: "page", parent: { type: "data_source_id", data_source_id: AD_DOCS_DATA_SOURCE_ID }, properties: {} }),
        { status: 200 },
      )) as unknown as typeof fetch;
    try {
      const parsed = { type: "page.created", entity: { id: "fa4e0000-0000-4000-8000-00000000000b", type: "page" }, data: {} };
      const ctx = buildGateContext(parsed, "page.created", "{}", env({ NOTION_API_TOKEN: "fake-token" }));
      expect(ctx.parentDbConfigName).toBeUndefined();
      await enrichContextFromNotionPage(env({ NOTION_API_TOKEN: "fake-token" }), ctx, "page.created");
      expect(buildClefStateString(ctx, "page.created", parsed, 0, false)).toContain("parent_db=AD Docs");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
