import { describe, expect, test, mock, beforeEach } from "bun:test";
import { evaluateAdDocsGate, applyDuplicateSkip } from "../src/wake-gate/ad-docs-gate.js";
import type { GatePageInputs } from "../src/wake-gate/wake-gate-types.js";
import { parseWebhookForWakeGate, titleFromNotionUrlSlug } from "../src/wake-gate/payload-parse.js";
import {
  isTestOrTemplateTitlePrefix,
  titleEndsWithEmDashTemplate,
} from "../src/wake-gate/title-match.js";
import { evaluateSafety } from "../src/wake-gate/notion-safety.js";
import { runShadowWakeGates, SHADOW_LOG_EVENT } from "../src/wake-gate/wake-gate-shadow.js";
import type { Env } from "../src/env.js";
import integrationFixture from "../fixtures/integration-page-updated.json";
import automationFixture from "../fixtures/automation-page.json";

function baseInputs(overrides: Partial<GatePageInputs> = {}): GatePageInputs {
  return {
    pageId: "page-1",
    dataSourceId: "2e97d7f5-6298-804c-b8a5-000b18b72684",
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
    notionEventType: "page.properties_updated",
    authorUserIds: [],
    ...overrides,
  };
}

describe("title-match", () => {
  test("whole-word Test/Template prefix", () => {
    expect(isTestOrTemplateTitlePrefix("Test: something")).toBe(true);
    expect(isTestOrTemplateTitlePrefix("Template- draft")).toBe(true);
    expect(isTestOrTemplateTitlePrefix("Contest: no")).toBe(false);
    expect(isTestOrTemplateTitlePrefix("Testimony: no")).toBe(false);
    expect(isTestOrTemplateTitlePrefix("Contemplate: no")).toBe(false);
  });
  test("em dash template suffix", () => {
    expect(titleEndsWithEmDashTemplate("Foo \u2014 Template")).toBe(true);
    expect(titleEndsWithEmDashTemplate("Foo - Template")).toBe(false);
  });
});

describe("ad-docs gate rules", () => {
  test("wake on needs john / sensitive / kind", () => {
    expect(evaluateAdDocsGate(baseInputs({ needsJohn: true }), {}).reason).toBe("needs_john");
    expect(evaluateAdDocsGate(baseInputs({ sensitive: true }), {}).reason).toBe("sensitive");
    expect(evaluateAdDocsGate(baseInputs({ kind: "Decision" }), {}).reason).toBe("kind_decision");
    expect(evaluateAdDocsGate(baseInputs({ kind: "Brief" }), {}).reason).toBe("kind_brief");
  });
  test("ade source repo skip", () => {
    const r = evaluateAdDocsGate(baseInputs({ sourceRepo: "jre-agent-dev-cli" }), {});
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
  test("wake beats skip", () => {
    const r = evaluateAdDocsGate(
      baseInputs({ needsJohn: true, sourceRepo: "jre-agent-dev-cli" }),
      {},
    );
    expect(r.decision).toBe("would_wake");
  });
  test("template and trash skips", () => {
    expect(evaluateAdDocsGate(baseInputs({ title: "X \u2014 Template" }), {}).reason).toBe(
      "template_or_test_title",
    );
    expect(evaluateAdDocsGate(baseInputs({ inTrash: true }), {}).reason).toBe("in_trash");
  });
  test("default wake", () => {
    expect(evaluateAdDocsGate(baseInputs(), {}).reason).toBe("default_wake");
  });
  test("duplicate only on unchanged default wake", () => {
    const base = evaluateAdDocsGate(baseInputs(), {});
    const dup = applyDuplicateSkip(base, baseInputs(), true);
    expect(dup.reason).toBe("duplicate_within_60s");
    const changed = applyDuplicateSkip(
      evaluateAdDocsGate(baseInputs({ needsJohn: true }), {}),
      baseInputs({ needsJohn: true }),
      true,
    );
    expect(changed.reason).toBe("needs_john");
  });
});

describe("safety", () => {
  test("submitted and unknown property ids", () => {
    const env = { SUBMITTED_PROPERTY_IDS: "sub-1" };
    const w = evaluateSafety(baseInputs({ updatedPropertyIds: ["sub-1"] }), env);
    expect(w.forceWake).toBe(true);
    const unknown = evaluateSafety(baseInputs({ updatedPropertyIds: ["x"] }), {});
    expect(unknown.forceWake).toBe(true);
  });
  test("john comment", () => {
    const w = evaluateSafety(
      baseInputs({ authorUserIds: ["john-1"], notionEventType: "comment.created" }),
      { JOHN_NOTION_USER_IDS: "john-1" },
    );
    expect(w.forceWake).toBe(true);
  });
  test("fleet echo skip flag on comments only", () => {
    const w = evaluateSafety(
      baseInputs({ authorUserIds: ["fleet-1"], notionEventType: "comment.created" }),
      { FLEET_COMMENTS_BOT_NOTION_USER_IDS: "fleet-1" },
    );
    expect(w.fleetEchoSkip).toBe(true);
    const page = evaluateSafety(
      baseInputs({ authorUserIds: ["fleet-1"], notionEventType: "page.created" }),
      { FLEET_COMMENTS_BOT_NOTION_USER_IDS: "fleet-1" },
    );
    expect(page.fleetEchoSkip).toBe(false);
  });
});

describe("payload shapes", () => {
  test("integration webhook", () => {
    const p = parseWebhookForWakeGate(integrationFixture as Record<string, unknown>);
    expect(p.pageId).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(p.dataSourceId).toBe("2e97d7f5-6298-804c-b8a5-000b18b72684");
    expect(p.isAutomationPageObject).toBe(false);
  });
  test("automation page object", () => {
    const p = parseWebhookForWakeGate(automationFixture as Record<string, unknown>);
    expect(p.pageId).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(p.isAutomationPageObject).toBe(true);
    expect(p.titleFromAutomation).toBe("Quiet Update");
  });
  test("title slug helper", () => {
    expect(
      titleFromNotionUrlSlug(
        "https://www.notion.so/Quiet-Update-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ),
    ).toBe("Quiet Update");
  });
});

describe("shadow runner fail-open", () => {
  let logs: string[] = [];
  beforeEach(() => {
    logs = [];
    console.log = ((...args: unknown[]) => {
      logs.push(String(args[0]));
    }) as typeof console.log;
  });

  function mockEnv(overrides: Partial<Env> = {}): Env {
    const store = new Map<string, string>();
    return {
      RELAY_KV: {
        get: async (k: string) => store.get(k) ?? null,
        put: async (k: string, v: string) => {
          store.set(k, v);
        },
        delete: async () => {},
        list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
        getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
      } as KVNamespace,
      COS_WEBHOOK_URL: "https://example.com",
      COS_WEBHOOK_AUTHORIZATION: "Bearer x",
      SETUP_SECRET: "s",
      ...overrides,
    };
  }

  test("not_ad_docs does not fetch", async () => {
    const fetchMock = mock(() => Promise.reject(new Error("should not fetch")));
    globalThis.fetch = fetchMock as typeof fetch;
    await runShadowWakeGates(
      mockEnv(),
      {
        type: "page.created",
        entity: { id: "p1", type: "page" },
        data: { parent: { data_source_id: "other-db" } },
      },
      "page.created",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    const line = JSON.parse(logs[0] ?? "{}");
    expect(line.reason).toBe("not_ad_docs");
  });

  test("missing token fail open", async () => {
    await runShadowWakeGates(mockEnv(), integrationFixture as Record<string, unknown>, "page.properties_updated");
    const line = JSON.parse(logs[0] ?? "{}");
    expect(line.event).toBe(SHADOW_LOG_EVENT);
    expect(line.decision).toBe("would_wake");
    expect(line.reason).toBe("needs_property_fetch");
  });

  test("notion 500 fail open", async () => {
    globalThis.fetch = mock(async () => new Response("err", { status: 500 })) as typeof fetch;
    await runShadowWakeGates(
      mockEnv({ NOTION_API_TOKEN: "secret" }),
      integrationFixture as Record<string, unknown>,
      "page.properties_updated",
    );
    const line = JSON.parse(logs[0] ?? "{}");
    expect(line.decision).toBe("would_wake");
    expect(String(line.reason)).toContain("error:");
  });

  test("gate internal errors fail open", async () => {
    await runShadowWakeGates(mockEnv(), null as unknown as Record<string, unknown>, null);
    const line = JSON.parse(logs[0] ?? "{}");
    expect(line.decision).toBe("would_wake");
  });
});

  test("fleet bot echo skip on comments", () => {
    const r = evaluateAdDocsGate(
      baseInputs({ authorUserIds: ["fleet-1"], notionEventType: "comment.created" }),
      { FLEET_COMMENTS_BOT_NOTION_USER_IDS: "fleet-1" },
    );
    expect(r.decision).toBe("would_skip");
    expect(r.reason).toBe("fleet_bot_echo");
  });
