import { describe, expect, test } from "bun:test";
import { clefHardOverrideReason } from "../src/wake-gate/clef-overrides.js";
import { FLEET_LOCKS_NON_SUBMITTED_PROPERTY_ID_VALUES } from "../src/wake-gate/fleet-locks-properties.js";
import { adoptedChangeGateName } from "../src/wake-gate/adopted-change-gate.js";
import type { GateEventContext, WakeGateDecision } from "../src/wake-gate/gate-event-types.js";

const JOHN = "2e7d872b-594c-8161-92a2-00024b29e816";
const BOT = "3d87d7f5-6298-8165-8af9-0027a153ccbd";

function baseCtx(overrides: Partial<GateEventContext> = {}): GateEventContext {
  return {
    notionType: "page.properties_updated",
    rawBody: "{}",
    johnUserIds: new Set([JOHN]),
    fleetCommentsBotIds: new Set([BOT]),
    submittedPropertyIds: new Set(),
    nonSubmittedPropertyIds: new Set(FLEET_LOCKS_NON_SUBMITTED_PROPERTY_ID_VALUES),
    updatedPropertyIds: ["yDiF"],
    isCommentEvent: false,
    propertiesAvailable: false,
    properties: {},
    ...overrides,
  };
}

describe("clefHardOverrideReason", () => {
  test("properties_unavailable when page properties not enriched", () => {
    const reason = clefHardOverrideReason(baseCtx(), {}, true, []);
    expect(reason).toBe("properties_unavailable");
  });

  test("override order: john_ids_unset before properties_unavailable", () => {
    const reason = clefHardOverrideReason(
      baseCtx({ johnUserIds: new Set(), propertiesAvailable: false }),
      {},
      true,
      [],
    );
    expect(reason).toBe("john_ids_unset");
  });

  test("john_ids_unset and bot_ids_unset", () => {
    expect(clefHardOverrideReason(baseCtx({ johnUserIds: new Set() }), {}, true, [])).toBe(
      "john_ids_unset",
    );
    expect(
      clefHardOverrideReason(baseCtx({ fleetCommentsBotIds: new Set() }), {}, true, []),
    ).toBe("bot_ids_unset");
  });

  test("fleet_bot_author for bot-authored page events", () => {
    const reason = clefHardOverrideReason(
      baseCtx({ authorId: BOT, webhookAuthorIds: [BOT] }),
      {},
      true,
      [],
    );
    expect(reason).toBe("fleet_bot_author");
  });

  test("john_mention in comment rich text", () => {
    const parsed = {
      type: "comment.created",
      data: {
        rich_text: [
          {
            type: "mention",
            mention: { type: "user", user: { id: JOHN } },
          },
        ],
      },
    };
    const reason = clefHardOverrideReason(
      baseCtx({ isCommentEvent: true, propertiesAvailable: false }),
      parsed,
      true,
      [],
    );
    expect(reason).toBe("john_mention");
  });

  test("comment_content_unavailable when comment has no inspectable body", () => {
    const reason = clefHardOverrideReason(
      baseCtx({ isCommentEvent: true, authorId: "other-user", webhookAuthorIds: ["other-user"] }),
      { type: "comment.created", data: {} },
      true,
      [],
    );
    expect(reason).toBe("comment_content_unavailable");
  });

  test("adopted_change override precedes properties fetch requirements", () => {
    const decisions: WakeGateDecision[] = [
      {
        gate_name: adoptedChangeGateName,
        decision: "would_wake",
        reason: "adopted_change",
        inputs: {},
        ts: "",
        mode: "shadow",
      },
    ];
    const reason = clefHardOverrideReason(baseCtx(), {}, true, decisions);
    expect(reason).toBe("adopted_change");
  });
});
