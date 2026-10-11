import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import {
  aggregateRuleDecision,
  appendClefShadowLog,
  opaqueLogItemId,
  ruleDecisionToClefDecision,
  shouldRunClefFullSample,
} from "../src/wake-gate/clef-wake-gate.js";
import type { ClefShadowLogEntry, WakeGateDecision } from "../src/wake-gate/gate-event-types.js";
import type { Env } from "../src/env.js";

describe("clef-wake-gate helpers", () => {
  test("aggregateRuleDecision prefers wake", () => {
    const decisions: WakeGateDecision[] = [
      { gate_name: "a", decision: "would_skip", reason: "x", inputs: {}, ts: "", mode: "shadow" },
      { gate_name: "b", decision: "would_wake", reason: "y", inputs: {}, ts: "", mode: "shadow" },
    ];
    expect(aggregateRuleDecision(decisions)).toBe("would_wake");
    expect(ruleDecisionToClefDecision("would_log_only")).toBe("would_log_only");
  });

  test("shouldRunClefFullSample is deterministic for page id", () => {
    const a = shouldRunClefFullSample("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const b = shouldRunClefFullSample("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(a).toBe(b);
    expect(shouldRunClefFullSample("unknown")).toBe(false);
  });

  test("opaqueLogItemId hashes stable ids", () => {
    const id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(opaqueLogItemId(id)).toMatch(/^opaque:[0-9a-f]+$/);
    expect(opaqueLogItemId(id)).toBe(opaqueLogItemId(id));
  });
});

describe("clef KV ring hygiene", () => {
  let store: Map<string, string>;
  let origLog: typeof console.log;

  beforeEach(() => {
    store = new Map();
    origLog = console.log;
    console.log = (() => {}) as typeof console.log;
  });

  afterEach(() => {
    console.log = origLog;
  });

  function env(): Env {
    return {
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
    };
  }

  test("KV clef_shadow_log stores opaque item_id not raw page id", async () => {
    const rawPageId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const entry: ClefShadowLogEntry = {
      ts: new Date().toISOString(),
      gate: "clef_wake",
      item_id: rawPageId,
      source: "notion_page",
      event: "page.properties_updated",
      rule_decision: "would_wake",
      clef_decision: "would_wake",
      p_action: null,
      p_dup: null,
      q_when: null,
      confidence: null,
      model: null,
      latency_ms: null,
      sampled_full: null,
      mode: "shadow",
      actually_ran: "coalesce_enqueued",
      reason: "test",
    };
    await appendClefShadowLog({ ...env(), CLEF_RING: "1" }, entry);
    const raw = store.get("clef_shadow_log");
    expect(raw).toBeTruthy();
    expect(raw).not.toContain(rawPageId);
    const parsed = JSON.parse(raw ?? "[]") as ClefShadowLogEntry[];
    expect(parsed[0]?.item_id).toBe(opaqueLogItemId(rawPageId));
  });

  test("CLEF_RING=0 skips KV put", async () => {
    const e = { ...env(), CLEF_RING: "0" };
    await appendClefShadowLog(e, {
      ts: "",
      gate: "clef_wake",
      item_id: "cccccccccccccccccccccccccccccccc",
      source: "notion_page",
      event: null,
      rule_decision: "would_skip",
      clef_decision: "would_skip",
      p_action: null,
      p_dup: null,
      q_when: null,
      confidence: null,
      model: null,
      latency_ms: null,
      sampled_full: null,
      mode: "shadow",
      actually_ran: "coalesce_enqueued",
      reason: "x",
    });
    expect(store.has("clef_shadow_log")).toBe(false);
  });
});
