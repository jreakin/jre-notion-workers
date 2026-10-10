import { describe, expect, test } from "bun:test";
import type { Env } from "../src/env.js";
import {
  gateLogBlocksForward,
  isGateLogDataSourceEvent,
  shouldDropGateLogEvent,
} from "../src/wake-gate/gate-log-filter.js";
import type { GateEventContext } from "../src/wake-gate/gate-event-types.js";

const GATE_DS = "af0ab5b0-2d9d-42bb-9621-526198146e46";
const GATE_DB = "b25a26f0-5464-476b-afb3-da4257e2a53b";
function env(overrides: Partial<Env> = {}): Env {
  return {
    RELAY_KV: {} as KVNamespace,
    COS_WEBHOOK_URL: "x",
    COS_WEBHOOK_AUTHORIZATION: "y",
    SETUP_SECRET: "z",
    GATE_LOG_DATA_SOURCE_IDS: `${GATE_DS},${GATE_DB}`,
    ...overrides,
  };
}

function ctx(overrides: Partial<GateEventContext> = {}): GateEventContext {
  return {
    notionType: "page.properties_updated",
    rawBody: "{}",
    johnUserIds: new Set(),
    fleetCommentsBotIds: new Set(),
    submittedPropertyIds: new Set(),
    nonSubmittedPropertyIds: new Set(),
    updatedPropertyIds: [],
    isCommentEvent: false,
    propertiesAvailable: false,
    ...overrides,
  };
}

describe("gate-log-filter", () => {
  test("gate log data_source_id parent matches dashless uppercase env id", () => {
    const c = ctx({
      webhookParentDataSourceId: "AF0AB5B02D9D42BB9621526198146E46",
    });
    expect(isGateLogDataSourceEvent(c, env())).toBe(true);
  });

  test("non gate-log parent does not drop", () => {
    const c = ctx({
      webhookParentDataSourceId: "00000000-0000-0000-0000-000000000001",
    });
    expect(shouldDropGateLogEvent(c, env())).toBe(false);
    expect(gateLogBlocksForward(true, c, env())).toBe(false);
  });

  test("gateLogBlocksForward requires parseOk", () => {
    const c = ctx({ webhookParentDataSourceId: GATE_DS });
    expect(gateLogBlocksForward(true, c, env())).toBe(true);
    expect(gateLogBlocksForward(false, c, env())).toBe(false);
  });
});
