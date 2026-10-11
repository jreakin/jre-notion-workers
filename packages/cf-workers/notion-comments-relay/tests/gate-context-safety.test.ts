import { describe, expect, test } from "bun:test";
import { submittedPropertyChanged } from "../src/wake-gate/gate-context-safety.js";
import type { GateEventContext } from "../src/wake-gate/gate-event-types.js";

describe("submittedPropertyChanged", () => {
  test("page.properties_updated with empty updated list wakes", () => {
    const ctx: GateEventContext = {
      notionType: "page.properties_updated",
      rawBody: "{}",
      johnUserIds: new Set(),
      fleetCommentsBotIds: new Set(),
      submittedPropertyIds: new Set(),
      nonSubmittedPropertyIds: new Set(["]GbO"]),
      updatedPropertyIds: [],
      isCommentEvent: false,
      propertiesAvailable: false,
      properties: {},
    };
    expect(submittedPropertyChanged(ctx)).toBe(true);
  });
});
