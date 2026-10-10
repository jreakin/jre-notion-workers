import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { evaluateAdDocsGate, applyDuplicateSkip, gateLogInputs } from "../src/wake-gate/ad-docs-gate.js";
import type { GatePageInputs } from "../src/wake-gate/wake-gate-types.js";
import { AD_DOCS_DATA_SOURCE_ID } from "../src/wake-gate/wake-gate-types.js";
import { parseWebhookForWakeGate, titleFromNotionUrlSlug } from "../src/wake-gate/payload-parse.js";
import {
  isTestOrTemplateTitlePrefix,
  titleEndsWithEmDashTemplate,
  isTemplateLikeTitle,
} from "../src/wake-gate/title-match.js";
import { evaluateSafety } from "../src/wake-gate/notion-safety.js";
import { idInCsvSet } from "../src/wake-gate/env-parse.js";
import { gateInputsFromNotionPage } from "../src/wake-gate/notion-properties.js";
import { runShadowWakeGates, SHADOW_LOG_EVENT } from "../src/wake-gate/wake-gate-shadow.js";
import type { Env } from "../src/env.js";
import integrationFixture from "../fixtures/integration-page-updated.json";
import automationFixture from "../fixtures/automation-page.json";

function baseInputs(overrides: Partial<GatePageInputs> = {}): GatePageInputs {
  return {
    pageId: "page-1",
    dataSourceId: AD_DOCS_DATA_SOURCE_ID,
    title: "Normal doc",
    inTrash: false,
    needsJohn: false,
    sensitive: false,
    kind: "Other",
    sourceRepo: null,
    documentType: "Report",
    hasClientsRelation: true,
    hasProjectRelation: true,
    updatedPropertyIds: [],
    updatedPropertiesKnown: true,
    notionEventType: "page.created",
    authorUserIds: [],
    ...overrides,
  };
}

describe("title-match", () => {
  test("whole-word Test/Template prefix with colon only", () => {
    expect(isTestOrTemplateTitlePrefix("Test: something")).toBe(true);
    expect(isTestOrTemplateTitlePrefix("Template: draft")).toBe(true);
    expect(isTestOrTemplateTitlePrefix("Test-driven development notes")).toBe(false);
    expect(isTestOrTemplateTitlePrefix("Template-based pricing")).toBe(false);
    expect(isTestOrTemplateTitlePrefix("Template- draft")).toBe(false);
    expect(isTestOrTemplateTitlePrefix("Contest: no")).toBe(false);
  });
  test("em dash template suffix on full joined title", () => {
    const title = "Q3 \u2014 Template Review: real decision doc";
    expect(titleEndsWithEmDashTemplate(title)).toBe(false);
    expect(isTemplateLikeTitle(title)).toBe(false);
    expect(isTemplateLikeTitle("Foo \u2014 Template")).toBe(true);
  });
});

describe("notion-properties", () => {
  test("joins all title and rich_text segments and trims source repo", () => {
    const page = {
      archived: false,
      in_trash: false,
      properties: {
        Name: {
          type: "title",
          title: [
            { plain_text: "Q3 \u2014 Template" },
            { plain_text: " Review: real decision doc" },
          ],
        },
        "Needs John": { type: "checkbox", checkbox: false },
        Sensitive: { type: "checkbox", checkbox: false },
        Kind: { type: "select", select: { name: "Decision" } },
        "Source Repo": { type: "rich_text", rich_text: [{ plain_text: "  spaced-repo  " }] },
        "Document Type": { type: "select", select: { name: "Report" } },
      },
    };
    const inputs = gateInputsFromNotionPage(page, {
      pageId: "p",
      dataSourceId: AD_DOCS_DATA_SOURCE_ID,
      updatedPropertyIds: ["x"],
      updatedPropertiesKnown: true,
      notionEventType: "page.properties_updated",
      authorUserIds: [],
      titleFromAutomation: null,
      inTrashFromPayload: null,
    });
    expect(inputs.title).toBe("Q3 \u2014 Template Review: real decision doc");
    expect(inputs.sourceRepo).toBe("spaced-repo");
    expect(inputs.schemaNeedsPropertyFetch).toBe(false);
  });
  test("archived true counts as in_trash", () => {
    const inputs = gateInputsFromNotionPage(
      { archived: true, properties: {} },
      {
        pageId: "p",
        dataSourceId: AD_DOCS_DATA_SOURCE_ID,
        updatedPropertyIds: [],
        updatedPropertiesKnown: true,
        notionEventType: "page.created",
        authorUserIds: [],
        titleFromAutomation: null,
        inTrashFromPayload: false,
      },
    );
    expect(inputs.inTrash).toBe(true);
  });
  test("schema surprise on Kind", () => {
    const inputs = gateInputsFromNotionPage(
      {
        properties: {
          Kind: { type: "number", number: 1 },
          "Needs John": { type: "checkbox", checkbox: false },
          Sensitive: { type: "checkbox", checkbox: false },
        },
      },
      {
        pageId: "p",
        dataSourceId: AD_DOCS_DATA_SOURCE_ID,
        updatedPropertyIds: ["a"],
        updatedPropertiesKnown: true,
        notionEventType: "page.properties_updated",
        authorUserIds: [],
        titleFromAutomation: null,
        inTrashFromPayload: null,
      },
    );
    expect(inputs.schemaNeedsPropertyFetch).toBe(true);
  });
});

describe("ad-docs gate rules", () => {
  test("wake on needs john / sensitive / kind", () => {
    expect(evaluateAdDocsGate(baseInputs({ needsJohn: true }), {}).reason).toBe("needs_john");
    expect(evaluateAdDocsGate(baseInputs({ sensitive: true }), {}).reason).toBe("sensitive");
    expect(evaluateAdDocsGate(baseInputs({ kind: "Decision" }), {}).reason).toBe("kind_decision");
  });
  test("ade source repo skip wins over agent digest", () => {
    const r = evaluateAdDocsGate(
      baseInputs({ sourceRepo: "jre-agent-dev-cli", documentType: "Agent Digest" }),
      {},
    );
    expect(r.decision).toBe("would_skip");
    expect(r.reason).toBe("ade_source_repo");
  });
  test("agent digest wakes without ade repo", () => {
    const r = evaluateAdDocsGate(
      baseInputs({ documentType: "Agent Digest", sourceRepo: "other" }),
      {},
    );
    expect(r.decision).toBe("would_wake");
    expect(r.reason).toBe("agent_digest_needs_review");
  });
  test("logging inputs omit raw title and author ids", () => {
    const logged = gateLogInputs(baseInputs({ title: "Secret title", authorUserIds: ["u1"] }));
    expect(logged).not.toHaveProperty("title");
    expect(logged).not.toHaveProperty("authorUserIds");
    expect(logged.title_length).toBe("Secret title".length);
    expect(logged.title_matched_template).toBe(false);
  });
  test("duplicate only on page events", () => {
    const base = evaluateAdDocsGate(baseInputs(), {});
    const pageDup = applyDuplicateSkip(base, baseInputs(), true);
    expect(pageDup.reason).toBe("duplicate_within_60s");
    const commentDup = applyDuplicateSkip(
      base,
      baseInputs({ notionEventType: "comment.created" }),
      true,
    );
    expect(commentDup.reason).toBe("default_wake");
  });
});

describe("safety", () => {
  test("opaque submitted property id matching", () => {
    const env = { SUBMITTED_PROPERTY_IDS: ";Xo<,]GbO" };
    expect(idInCsvSet(new Set([";Xo<"]), "%3BXo%3C")).toBe(true);
    const w = evaluateSafety(baseInputs({ updatedPropertyIds: ["H=?>", "other"] }), {
      SUBMITTED_PROPERTY_IDS: "H%3D%3F%3E",
    });
    expect(w.forceWake).toBe(true);
    expect(w.reason).toBe("submitted_property_change");
  });
  test("no_updated_property_ids on empty properties_updated", () => {
    const w = evaluateSafety(
      baseInputs({ updatedPropertyIds: [], notionEventType: "page.properties_updated" }),
      {},
    );
    expect(w.reason).toBe("no_updated_property_ids");
  });
  test("fleet echo skip flag on comments only", () => {
    const w = evaluateSafety(
      baseInputs({ authorUserIds: ["fleet-1"], notionEventType: "comment.created" }),
      { FLEET_COMMENTS_BOT_NOTION_USER_IDS: "fleet-1" },
    );
    expect(w.fleetEchoSkip).toBe(true);
  });
});

describe("payload shapes", () => {
  test("integration webhook", () => {
    const p = parseWebhookForWakeGate(integrationFixture as Record<string, unknown>);
    expect(p.pageId).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(p.dataSourceId).toBe(AD_DOCS_DATA_SOURCE_ID);
    expect(p.isCommentEvent).toBe(false);
  });
  test("comment.created uses data.page_id and parent page", () => {
    const p = parseWebhookForWakeGate({
      type: "comment.created",
      entity: { id: "c1", type: "comment" },
      authors: [{ id: "human-1" }],
      data: {
        page_id: "page-from-data",
        parent: { type: "page", id: "parent-page-id" },
      },
    });
    expect(p.isCommentEvent).toBe(true);
    expect(p.pageId).toBe("page-from-data");
    expect(p.dataSourceId).toBeNull();
  });
  test("automation page object", () => {
    const p = parseWebhookForWakeGate(automationFixture as Record<string, unknown>);
    expect(p.isAutomationPageObject).toBe(true);
    expect(p.titleFromAutomation).toBe("Quiet Update");
  });
});

describe("shadow runner", () => {
  let logs: string[] = [];
  let origFetch: typeof fetch;
  let origLog: typeof console.log;

  beforeEach(() => {
    logs = [];
    origFetch = globalThis.fetch;
    origLog = console.log;
    console.log = ((...args: unknown[]) => {
      logs.push(String(args[0]));
    }) as typeof console.log;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    console.log = origLog;
  });

  function mockEnv(overrides: Partial<Env> = {}): Env {
    const store = new Map<string, string>();
    const puts: string[] = [];
    return {
      RELAY_KV: {
        get: async (k: string) => store.get(k) ?? null,
        put: async (k: string, v: string) => {
          puts.push(k);
          store.set(k, v);
        },
        delete: async () => {},
        list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
        getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
      } as unknown as KVNamespace,
      COS_WEBHOOK_URL: "https://example.com",
      COS_WEBHOOK_AUTHORIZATION: "Bearer x",
      SETUP_SECRET: "s",
      _puts: puts,
      ...overrides,
    } as Env & { _puts: string[] };
  }

  test("comment on non-ad docs logs comment_unresolved", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        parent: { type: "data_source_id", data_source_id: "other-db" },
        properties: {},
      }),
    ) as unknown as typeof fetch;
    await runShadowWakeGates(
      mockEnv({ NOTION_API_TOKEN: "t" }),
      {
        type: "comment.created",
        entity: { id: "c", type: "comment" },
        data: { page_id: "p1", parent: { type: "page", id: "p1" } },
      },
      "comment.created",
    );
    const line = JSON.parse(logs[0] ?? "{}");
    expect(line.reason).toBe("comment_unresolved");
    expect(line.reason).not.toBe("not_ad_docs");
  });

  test("AbortError maps to error:timeout", async () => {
    globalThis.fetch = mock(async () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof fetch;
    await runShadowWakeGates(
      mockEnv({ NOTION_API_TOKEN: "t" }),
      integrationFixture as Record<string, unknown>,
      "page.properties_updated",
    );
    const line = JSON.parse(logs[0] ?? "{}");
    expect(line.reason).toBe("error:timeout");
  });

  test("dedupe KV put only when WAKE_GATE_DEDUPE=1 and not duplicate", async () => {
    const page = {
      parent: { type: "data_source_id", data_source_id: AD_DOCS_DATA_SOURCE_ID },
      properties: {
        Name: { type: "title", title: [{ plain_text: "Doc" }] },
        "Needs John": { type: "checkbox", checkbox: false },
        Sensitive: { type: "checkbox", checkbox: false },
        Kind: { type: "select", select: { name: "Other" } },
        "Source Repo": { type: "rich_text", rich_text: [{ plain_text: "x" }] },
        "Document Type": { type: "select", select: { name: "Report" } },
      },
    };
    globalThis.fetch = mock(async () => Response.json(page)) as unknown as typeof fetch;
    const envOff = mockEnv({ NOTION_API_TOKEN: "t" });
    await runShadowWakeGates(envOff, integrationFixture as Record<string, unknown>, "page.properties_updated");
    expect((envOff as Env & { _puts: string[] })._puts.filter((k) => k.startsWith("wake_gate:dedupe:"))).toHaveLength(0);

    const envOn = mockEnv({ NOTION_API_TOKEN: "t", WAKE_GATE_DEDUPE: "1" });
    await runShadowWakeGates(envOn, integrationFixture as Record<string, unknown>, "page.properties_updated");
    expect((envOn as Env & { _puts: string[] })._puts.some((k) => k.startsWith("wake_gate:dedupe:"))).toBe(true);
  });

  test("fleet bot echo skip on comments", async () => {
    const page = {
      parent: { type: "data_source_id", data_source_id: AD_DOCS_DATA_SOURCE_ID },
      properties: {
        Name: { type: "title", title: [{ plain_text: "Doc" }] },
        "Needs John": { type: "checkbox", checkbox: false },
        Sensitive: { type: "checkbox", checkbox: false },
        Kind: { type: "select", select: { name: "Other" } },
        "Source Repo": { type: "rich_text", rich_text: [{ plain_text: "x" }] },
        "Document Type": { type: "select", select: { name: "Report" } },
      },
    };
    globalThis.fetch = mock(async () => Response.json(page)) as unknown as typeof fetch;
    const fixture = {
      type: "comment.created",
      entity: { id: "c", type: "comment" },
      authors: [{ id: "fleet-1" }],
      data: { page_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", parent: { type: "page", id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
    };
    await runShadowWakeGates(
      mockEnv({ NOTION_API_TOKEN: "t", FLEET_COMMENTS_BOT_NOTION_USER_IDS: "fleet-1" }),
      fixture,
      "comment.created",
    );
    const line = JSON.parse(logs[0] ?? "{}");
    expect(line.decision).toBe("would_skip");
    expect(line.reason).toBe("fleet_bot_echo");
  });

  test("shadow logs use SHADOW_LOG_EVENT", async () => {
    await runShadowWakeGates(mockEnv(), integrationFixture as Record<string, unknown>, "page.properties_updated");
    const line = JSON.parse(logs[0] ?? "{}");
    expect(line.event).toBe(SHADOW_LOG_EVENT);
  });
});
