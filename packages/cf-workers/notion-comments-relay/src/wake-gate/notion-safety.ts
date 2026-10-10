import type { GatePageInputs, WakeDecision } from "./wake-gate-types.js";
import { parseCsvIds } from "./env-parse.js";

export interface SafetyEnv {
  JOHN_NOTION_USER_IDS?: string;
  FLEET_COMMENTS_BOT_NOTION_USER_IDS?: string;
  SUBMITTED_PROPERTY_IDS?: string;
}

export interface SafetyOutcome {
  forceWake: boolean;
  reason: string | null;
  fleetEchoSkip: boolean;
}

export function evaluateSafety(
  inputs: GatePageInputs,
  env: SafetyEnv,
): SafetyOutcome {
  const submittedIds = parseCsvIds(env.SUBMITTED_PROPERTY_IDS);
  if (inputs.updatedPropertyIds.length > 0) {
    if (submittedIds.size === 0) {
      return { forceWake: true, reason: "unknown_updated_property_id", fleetEchoSkip: false };
    }
    for (const propId of inputs.updatedPropertyIds) {
      if (submittedIds.has(propId)) {
        return { forceWake: true, reason: "submitted_property_change", fleetEchoSkip: false };
      }
    }
  }

  const johnIds = parseCsvIds(env.JOHN_NOTION_USER_IDS);
  if (johnIds.size > 0) {
    for (const author of inputs.authorUserIds) {
      if (johnIds.has(author)) {
        return { forceWake: true, reason: "john_comment", fleetEchoSkip: false };
      }
    }
  }

  if (!inputs.pageId) {
    return { forceWake: true, reason: "missing_page_id", fleetEchoSkip: false };
  }

  if (inputs.needsJohn === null || inputs.sensitive === null) {
    return { forceWake: true, reason: "missing_wake_input", fleetEchoSkip: false };
  }

  const fleetIds = parseCsvIds(env.FLEET_COMMENTS_BOT_NOTION_USER_IDS);
  const isComment =
    inputs.notionEventType !== null && inputs.notionEventType.startsWith("comment.");
  let fleetEchoSkip = false;
  if (isComment && fleetIds.size > 0) {
    for (const author of inputs.authorUserIds) {
      if (fleetIds.has(author)) {
        fleetEchoSkip = true;
        break;
      }
    }
  }

  return { forceWake: false, reason: null, fleetEchoSkip };
}

export function safetyWakeDecision(reason: string): { decision: WakeDecision; reason: string } {
  return { decision: "would_wake", reason };
}
