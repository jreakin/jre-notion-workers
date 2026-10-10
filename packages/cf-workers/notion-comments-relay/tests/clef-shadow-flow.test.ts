import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { runClefShadowWakeGate, resetClefPageEventCountsForTests } from "../src/wake-gate/clef-wake-gate.js";
import type { Env } from "../src/env.js";
import type { GateEventContext, WakeGateDecision } from "../src/wake-gate/gate-event-types.js";

const JOHN = "2e7d872b-594c-8161-92a2-00024b29e816";
const BOT = "3d87d7f5-6298-8165-8af9-0027a153ccbd";

function baseCtx(): GateEventContext {
  return {
    notionType: "page.properties_updated",
    rawBody: "{}",
    pageId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    johnUserIds: new Set([JOHN]),
    fleetCommentsBotIds: new Set([BOT]),
    submittedPropertyIds: new Set(),
    nonSubmittedPropertyIds: new Set(["]GbO"]),
    updatedPropertyIds: ["]GbO"],
    isCommentEvent: false,
    propertiesAvailable: true,
    properties: { needsJohn: false, sensitive: false },
  };
}

function wakeDecision(): WakeGateDecision[] {
  return [
    {
      gate_name: "fleet_locks_adopted_change",
      decision: "would_wake",
      reason: "not_page_event",
      inputs: {},
      ts: new Date().toISOString(),
      mode: "shadow",
    },
  ];
}

describe("runClefShadowWakeGate flow", () => {
  let logs: string[] = [];
  let origLog: typeof console.log;

  beforeEach(() => {
    logs = [];
    origLog = console.log;
    console.log = ((line: unknown) => {
      logs.push(String(line));
    }) as typeof console.log;
    resetClefPageEventCountsForTests();
  });

  afterEach(() => {
    console.log = origLog;
    mock.restore();
  });

  function env(overrides: Partial<Env> = {}): Env {
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
      CLEF_DEFAULT_MODE: "shadow",
      ...overrides,
    };
  }

  function lastClefLog(): Record<string, unknown> {
    const line = logs.filter((l) => l.includes("clef_wake_shadow")).at(-1);
    return JSON.parse(line ?? "{}") as Record<string, unknown>;
  }

  test("override before AI when properties unavailable", async () => {
    await runClefShadowWakeGate(
      env(),
      { ...baseCtx(), propertiesAvailable: false, properties: {} },
      "page.properties_updated",
      {},
      true,
      wakeDecision(),
    );
    expect(lastClefLog().reason).toBe("properties_unavailable");
    expect(lastClefLog().model).toBeNull();
  });

  test("clef_mode_off skips model call", async () => {
    await runClefShadowWakeGate(
      env({ CLEF_DEFAULT_MODE: "off" }),
      baseCtx(),
      "page.properties_updated",
      {},
      true,
      wakeDecision(),
    );
    expect(String(lastClefLog().reason)).toContain("clef_mode_off");
    expect(lastClefLog().model).toBeNull();
  });

  test("clef_ai_unbound when AI binding missing", async () => {
    await runClefShadowWakeGate(env(), baseCtx(), "page.properties_updated", {}, true, wakeDecision());
    expect(lastClefLog().reason).toBe("clef_ai_unbound");
  });

  test("clef_bad_output on malformed model response", async () => {
    const e = env({
      AI: {
        run: async () => ({ answers: { q_action: { type: "noul", noul: 99 } } }),
      } as unknown as Ai,
    });
    await runClefShadowWakeGate(e, baseCtx(), "page.properties_updated", {}, true, wakeDecision());
    expect(lastClefLog().reason).toBe("clef_bad_output");
  });

  test("KV ring failure does not throw", async () => {
    const badAi = { run: async () => ({ answers: {} }) } as unknown as Ai;
    await runClefShadowWakeGate(
      env({ CLEF_RING: "1", AI: badAi }),
      baseCtx(),
      "page.properties_updated",
      {},
      true,
      wakeDecision(),
    );
    expect(logs.some((l) => l.includes("clef_wake_shadow"))).toBe(true);
  });
});
