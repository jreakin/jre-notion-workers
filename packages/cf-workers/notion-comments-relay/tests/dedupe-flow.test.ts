import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import {
  applyDuplicateSkip,
  evaluateAdDocsGate,
  snapshotsEqual,
  wakeRelevantSnapshot,
} from "../src/wake-gate/ad-docs-gate.js";
import { AD_DOCS_DATA_SOURCE_ID } from "../src/wake-gate/wake-gate-types.js";
import type { GatePageInputs } from "../src/wake-gate/wake-gate-types.js";
import { runShadowWakeGates } from "../src/wake-gate/wake-gate-shadow.js";
import type { Env } from "../src/env.js";
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

describe("dedupe snapshot", () => {
  test("retitled page breaks duplicate match", () => {
    const a = wakeRelevantSnapshot(baseInputs({ title: "Before" }));
    const b = wakeRelevantSnapshot(baseInputs({ title: "Test: after" }));
    expect(snapshotsEqual(a, b)).toBe(false);
  });

  test("source repo cleared breaks duplicate match", () => {
    const a = wakeRelevantSnapshot(baseInputs({ sourceRepo: "repo-a" }));
    const b = wakeRelevantSnapshot(baseInputs({ sourceRepo: null }));
    expect(snapshotsEqual(a, b)).toBe(false);
  });

  test("in_trash restored breaks duplicate match", () => {
    const a = wakeRelevantSnapshot(baseInputs({ inTrash: true }));
    const b = wakeRelevantSnapshot(baseInputs({ inTrash: false }));
    expect(snapshotsEqual(a, b)).toBe(false);
  });

  test("only dedupes when prior reason was default_wake", () => {
    const base = evaluateAdDocsGate(baseInputs(), {});
    const dup = applyDuplicateSkip(base, baseInputs(), true, "default_wake");
    expect(dup.reason).toBe("duplicate_within_60s");
    const noDup = applyDuplicateSkip(base, baseInputs(), true, "template_or_test_title");
    expect(noDup.reason).toBe("default_wake");
  });

  test("template with source repo set wakes instead of template skip", () => {
    const r = evaluateAdDocsGate(
      baseInputs({ title: "Test: draft", sourceRepo: "my-repo" }),
      {},
    );
    expect(r.decision).toBe("would_wake");
    expect(r.reason).toBe("default_wake");
  });

  test("ade agent digest is would_log_only", () => {
    const r = evaluateAdDocsGate(
      baseInputs({
        sourceRepo: "jre-agent-dev-cli",
        documentType: "Agent Digest",
      }),
      {},
    );
    expect(r.decision).toBe("would_log_only");
    expect(r.reason).toBe("ade_agent_digest");
  });
});

describe("dedupe shadow flow", () => {
  let logs: string[] = [];
  let origFetch: typeof fetch;
  let origLog: typeof console.log;
  let store: Map<string, string>;
  let kvGets: string[];
  let kvPuts: string[];

  beforeEach(() => {
    logs = [];
    store = new Map();
    kvGets = [];
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

  function mockPage(overrides: Partial<GatePageInputs> = {}) {
    const inputs = baseInputs(overrides);
    return {
      parent: { type: "data_source_id", data_source_id: AD_DOCS_DATA_SOURCE_ID },
      properties: {
        Name: { type: "title", title: [{ plain_text: inputs.title ?? "Doc" }] },
        "Needs John": { type: "checkbox", checkbox: inputs.needsJohn ?? false },
        Sensitive: { type: "checkbox", checkbox: inputs.sensitive ?? false },
        Kind: { type: "select", select: { name: inputs.kind ?? "Other" } },
        "Source Repo": {
          type: "rich_text",
          rich_text: inputs.sourceRepo ? [{ plain_text: inputs.sourceRepo }] : [],
        },
        "Document Type": { type: "select", select: { name: inputs.documentType ?? "Report" } },
      },
      archived: inputs.inTrash,
      in_trash: inputs.inTrash,
    };
  }

  function envWithDedupe(): Env {
    return {
      RELAY_KV: {
        get: async (k: string) => {
          kvGets.push(k);
          return store.get(k) ?? null;
        },
        put: async (k: string, v: string) => {
          kvPuts.push(k);
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
      WAKE_GATE_DEDUPE: "1",
    } as Env;
  }

  test("second default_wake within 60s becomes duplicate_within_60s", async () => {
    globalThis.fetch = mock(async () => Response.json(mockPage())) as unknown as typeof fetch;
    const env = envWithDedupe();
    const pageCreated = {
      type: "page.created",
      entity: { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", type: "page" },
      data: {
        parent: { data_source_id: AD_DOCS_DATA_SOURCE_ID },
      },
    };
    await runShadowWakeGates(env, pageCreated, "page.created");
    await runShadowWakeGates(env, pageCreated, "page.created");
    const reasons = logs
      .filter((l) => l.includes("ad_docs_wake_gate_shadow"))
      .map((l) => (JSON.parse(l) as { reason: string }).reason);
    expect(reasons).toContain("default_wake");
    expect(reasons).toContain("duplicate_within_60s");
  });

  test("template skip then retitled title wakes on second page event", async () => {
    let title = "Test: first";
    globalThis.fetch = mock(async () =>
      Response.json(
        mockPage({
          title,
          sourceRepo: null,
        }),
      ),
    ) as unknown as typeof fetch;
    const env = envWithDedupe();
    const payload = {
      type: "page.created",
      entity: { id: "page-dedupe-retitle", type: "page" },
      data: { parent: { data_source_id: AD_DOCS_DATA_SOURCE_ID } },
    };
    await runShadowWakeGates(env, payload, "page.created");
    title = "Real decision title";
    await runShadowWakeGates(env, payload, "page.created");
    const decisions = logs
      .filter((l) => l.includes("ad_docs_wake_gate_shadow"))
      .map((l) => JSON.parse(l) as { decision: string; reason: string });
    expect(decisions[0]?.reason).toBe("template_or_test_title");
    expect(decisions[1]?.decision).toBe("would_wake");
    expect(decisions[1]?.reason).not.toBe("duplicate_within_60s");
  });

  test("WAKE_GATE_DEDUPE off performs no KV get or put", async () => {
    globalThis.fetch = mock(async () => Response.json(mockPage())) as unknown as typeof fetch;
    const env = envWithDedupe();
    delete (env as { WAKE_GATE_DEDUPE?: string }).WAKE_GATE_DEDUPE;
    kvGets = [];
    kvPuts = [];
    const pageCreated = {
      type: "page.created",
      entity: { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", type: "page" },
      data: { parent: { data_source_id: AD_DOCS_DATA_SOURCE_ID } },
    };
    await runShadowWakeGates(env, pageCreated, "page.created");
    expect(kvGets.filter((k) => k.startsWith("wake_gate:dedupe:"))).toHaveLength(0);
    expect(kvPuts.filter((k) => k.startsWith("wake_gate:dedupe:"))).toHaveLength(0);
  });
});
