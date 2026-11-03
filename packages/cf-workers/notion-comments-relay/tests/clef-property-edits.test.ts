/**
 * page.properties_updated on tracked parents: properties are parsed from the page the event already
 * fetches (same parse as page.created), so Clef is consulted instead of the blanket
 * properties_unavailable override. All ids are fake.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Env } from "../src/env.js";
import { resetClefPageEventCountsForTests, resetItemDedupeForTests } from "../src/wake-gate/clef-wake-gate.js";
import { decideEchoFilter } from "../src/wake-gate/echo-filter.js";
import { echoFilterConfigFromEnv } from "../src/wake-gate/echo-filter-config.js";
import {
  buildGateContext,
  enrichContextFromNotionPage,
  runHarnessRuleShadowGates,
} from "../src/wake-gate/gate-orchestration.js";
import { resetPageFetchMemo } from "../src/wake-gate/notion-page-fetch.js";
import { resetSoftDailyCountersForTests } from "../src/soft-daily-counter.js";

const JOHN = "11111111-1111-4111-8111-111111111111";
const BOT = "22222222-2222-4222-8222-222222222222";
const OTHER_USER = "33333333-3333-4333-8333-333333333333";
const TRACKED_DS = "7aac0000-0000-4000-8000-000000000001";
const UNTRACKED_DS = "0dd00000-0000-4000-8000-000000000002";
const PAGE = "fa4e0000-0000-4000-8000-000000000003";
const PROP_OTHER = "fakeOther";
const PROP_SUBMITTED = "fakeSubm";
const PROP_NEEDS_JOHN = "fakeNJ";

function kv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
    delete: async (k: string) => {
      store.delete(k);
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
}

const AI_STUB = {
  run: async () => ({
    answers: {
      q_action: { type: "noul", noul: 0.9 },
      q_dup: { type: "noul", noul: 0.05 },
      q_when: { type: "choice", choice: "now" },
    },
  }),
} as unknown as Ai;

function env(o: Partial<Env> = {}): Env {
  return {
    RELAY_KV: kv(),
    COS_WEBHOOK_URL: "u",
    COS_WEBHOOK_AUTHORIZATION: "a",
    SETUP_SECRET: "s",
    CLEF_DEFAULT_MODE: "shadow",
    NOTION_API_TOKEN: "fake-token",
    JOHN_NOTION_USER_IDS: JOHN,
    FLEET_COMMENTS_BOT_NOTION_USER_IDS: BOT,
    TRACKED_DATA_SOURCE_IDS: TRACKED_DS,
    // Only PROP_OTHER is a known non-Submitted id, so an edit of it is not "submitted_changed".
    NON_SUBMITTED_PROPERTY_IDS: PROP_OTHER,
    AI: AI_STUB,
    ...o,
  };
}

function event(parentDs: string, updated: string[] = [PROP_OTHER]): Record<string, unknown> {
  return {
    id: "ev-fake-0001",
    type: "page.properties_updated",
    authors: [{ id: OTHER_USER, type: "person" }],
    entity: { id: PAGE, type: "page" },
    data: { parent: { type: "data_source_id", data_source_id: parentDs }, updated_properties: updated },
  };
}

function page(props: { needsJohn?: boolean; sensitive?: boolean } = {}): Record<string, unknown> {
  return {
    object: "page",
    id: PAGE,
    parent: { type: "data_source_id", data_source_id: TRACKED_DS },
    properties: {
      Name: { type: "title", title: [{ plain_text: "Masked title" }] },
      "Needs John": { type: "checkbox", checkbox: props.needsJohn === true },
      Sensitive: { type: "checkbox", checkbox: props.sensitive === true },
      Kind: { type: "select", select: { name: "Note" } },
    },
  };
}

describe("properties_updated on tracked parents", () => {
  let logs: string[] = [];
  let fetchCalls = 0;
  const origLog = console.log;
  const origFetch = globalThis.fetch;

  function mockFetch(responder: () => Response | Promise<Response>): void {
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return responder();
    }) as unknown as typeof fetch;
  }

  function clefRow(): Record<string, unknown> {
    const line = logs.filter((l) => l.includes('"clef_wake_shadow"')).at(-1);
    return JSON.parse(line ?? "{}") as Record<string, unknown>;
  }

  beforeEach(() => {
    logs = [];
    fetchCalls = 0;
    console.log = ((line: unknown) => {
      logs.push(String(line));
    }) as typeof console.log;
    resetClefPageEventCountsForTests();
    resetItemDedupeForTests();
    resetSoftDailyCountersForTests();
    resetPageFetchMemo();
  });

  afterEach(() => {
    console.log = origLog;
    globalThis.fetch = origFetch;
  });

  test("fetch ok ⇒ properties available and Clef consulted (stub AI)", async () => {
    mockFetch(() => new Response(JSON.stringify(page()), { status: 200 }));
    const parsed = event(TRACKED_DS);
    await runHarnessRuleShadowGates(env(), parsed, "page.properties_updated", JSON.stringify(parsed));
    expect(fetchCalls).toBe(1);
    const row = clefRow();
    expect(row.reason).not.toBe("properties_unavailable");
    expect(row.model).not.toBeNull();
    expect(row.p_action).toBe(0.9);
    expect(row.clef_decision).toBe("would_wake");
  });

  test("fetch fail ⇒ forced wake, no model call", async () => {
    mockFetch(() => new Response("{}", { status: 502 }));
    const parsed = event(TRACKED_DS);
    await runHarnessRuleShadowGates(env(), parsed, "page.properties_updated", JSON.stringify(parsed));
    expect(fetchCalls).toBeGreaterThanOrEqual(1);
    const row = clefRow();
    expect(row.reason).toBe("notion_fetch_failed");
    expect(row.clef_decision).toBe("would_wake");
    expect(row.model).toBeNull();
  });

  test("unreadable properties ⇒ notion_page_unreadable forced wake", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({ ...page(), properties: { "Needs John": { type: "rich_text", rich_text: [] } } }),
          { status: 200 },
        ),
    );
    const parsed = event(TRACKED_DS);
    await runHarnessRuleShadowGates(env(), parsed, "page.properties_updated", JSON.stringify(parsed));
    const row = clefRow();
    expect(row.reason).toBe("notion_page_unreadable");
    expect(row.model).toBeNull();
  });

  test("untracked edit ⇒ deterministic echo-filter skip and no fetch", async () => {
    mockFetch(() => new Response(JSON.stringify(page()), { status: 200 }));
    const e = env();
    const parsed = event(UNTRACKED_DS);
    const ctx = buildGateContext(parsed, "page.properties_updated", JSON.stringify(parsed), e);
    const verdict = decideEchoFilter(parsed, ctx, echoFilterConfigFromEnv(e));
    expect(verdict.decision).toBe("drop");
    expect(verdict.reason).toBe("untracked_property_edit");
    // Even if the shadow gates saw it, an untracked parent does not trigger the property fetch.
    await runHarnessRuleShadowGates(e, parsed, "page.properties_updated", JSON.stringify(parsed));
    expect(fetchCalls).toBe(0);
    expect(clefRow().reason).toBe("properties_unavailable");
  });

  test("Submitted change still forces a wake", async () => {
    mockFetch(() => new Response(JSON.stringify(page()), { status: 200 }));
    const parsed = event(TRACKED_DS, [PROP_SUBMITTED]);
    await runHarnessRuleShadowGates(
      env({ SUBMITTED_PROPERTY_IDS: PROP_SUBMITTED }),
      parsed,
      "page.properties_updated",
      JSON.stringify(parsed),
    );
    const row = clefRow();
    expect(row.reason).toBe("submitted_changed");
    expect(row.model).toBeNull();
  });

  test("Needs John change still forces a wake (by property id and by fetched flag)", async () => {
    mockFetch(() => new Response(JSON.stringify(page()), { status: 200 }));
    const byId = event(TRACKED_DS, [PROP_NEEDS_JOHN]);
    await runHarnessRuleShadowGates(
      env({ NEEDS_JOHN_PROPERTY_IDS: PROP_NEEDS_JOHN, NON_SUBMITTED_PROPERTY_IDS: PROP_NEEDS_JOHN }),
      byId,
      "page.properties_updated",
      JSON.stringify(byId),
    );
    expect(clefRow().reason).toBe("needs_john_changed");
    expect(clefRow().model).toBeNull();

    resetPageFetchMemo();
    mockFetch(() => new Response(JSON.stringify(page({ needsJohn: true })), { status: 200 }));
    const byFlag = event(TRACKED_DS);
    await runHarnessRuleShadowGates(env(), byFlag, "page.properties_updated", JSON.stringify(byFlag));
    expect(clefRow().reason).toBe("needs_john_changed");
    expect(clefRow().model).toBeNull();
  });

  test("prefilter fetch + shadow gates share one GET (per-request memo)", async () => {
    mockFetch(() => new Response(JSON.stringify(page()), { status: 200 }));
    const e = env();
    const parsed = event(TRACKED_DS);
    const scope = "req-fake-1";
    const pre = buildGateContext(parsed, "page.properties_updated", JSON.stringify(parsed), e);
    pre.fetchScope = scope;
    await enrichContextFromNotionPage(e, pre, "page.properties_updated", { caller: "cos_prefilter" }, {
      parsePropertyEdits: true,
    });
    await runHarnessRuleShadowGates(e, parsed, "page.properties_updated", JSON.stringify(parsed), true, scope);
    expect(fetchCalls).toBe(1);
    expect(clefRow().model).not.toBeNull();
  });

  test("without parsePropertyEdits (prefilter default) a tracked non-Fleet edit does not fetch", async () => {
    mockFetch(() => new Response(JSON.stringify(page()), { status: 200 }));
    const e = env();
    const parsed = event(TRACKED_DS);
    const ctx = buildGateContext(parsed, "page.properties_updated", JSON.stringify(parsed), e);
    await enrichContextFromNotionPage(e, ctx, "page.properties_updated");
    expect(fetchCalls).toBe(0);
    expect(ctx.propertiesAvailable).toBe(false);
  });
});
