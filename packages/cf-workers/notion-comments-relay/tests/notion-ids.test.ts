import { describe, expect, test } from "bun:test";
import {
  isFleetLocksParent,
  normalizeNotionUuid,
  notionIdsEqual,
  readWebhookParentFromBlock,
  webhookParentIsFleetLocks,
} from "../src/wake-gate/notion-ids.js";

const FLEET_DS = "6e0a45b3-eb3f-448f-b215-49e002bfeff3";

describe("notion-ids", () => {
  test("normalize and compare dashless uppercase", () => {
    const a = "6E0A45B3-EB3F-448F-B215-49E002BFEFF3";
    const b = "6e0a45b3eb3f448fb21549e002bfeff3";
    expect(notionIdsEqual(a, b)).toBe(true);
    expect(normalizeNotionUuid(a)).toBe(normalizeNotionUuid(b));
  });

  test("webhook parent fleet locks with trimmed env id", () => {
    const parent = readWebhookParentFromBlock({
      type: "data_source_id",
      data_source_id: FLEET_DS,
    });
    expect(webhookParentIsFleetLocks(parent, `  ${FLEET_DS}  `, "   ")).toBe(true);
    expect(webhookParentIsFleetLocks(parent, "   ", "   ")).toBeUndefined();
  });

  test("isFleetLocksParent matches data source", () => {
    expect(
      isFleetLocksParent({ dataSourceId: FLEET_DS }, FLEET_DS, undefined),
    ).toBe(true);
    expect(
      isFleetLocksParent({ dataSourceId: "other" }, FLEET_DS, undefined),
    ).toBe(false);
  });
});
