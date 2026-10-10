import { isJohn, isTruthyFlag, submittedPropertyChanged } from "./gate-context-safety.js";
import type { GateEventContext, WakeGateDecision } from "./gate-event-types.js";

const LOG_ONLY_DB_HINTS = ["day log", "people", "lane"];

function wake(gateName: string, reason: string, ctx: GateEventContext): WakeGateDecision {
  return {
    gate_name: gateName,
    decision: "would_wake",
    reason,
    inputs: {
      notion_type: ctx.notionType,
      page_id: ctx.pageId,
      author_id: ctx.authorId,
    },
    ts: new Date().toISOString(),
    mode: "shadow",
  };
}

function skip(gateName: string, reason: string, ctx: GateEventContext): WakeGateDecision {
  return {
    gate_name: gateName,
    decision: "would_skip",
    reason,
    inputs: {
      notion_type: ctx.notionType,
      page_id: ctx.pageId,
      author_id: ctx.authorId,
    },
    ts: new Date().toISOString(),
    mode: "shadow",
  };
}

function logOnly(gateName: string, reason: string, ctx: GateEventContext): WakeGateDecision {
  return {
    gate_name: gateName,
    decision: "would_log_only",
    reason,
    inputs: {
      notion_type: ctx.notionType,
      page_id: ctx.pageId,
      author_id: ctx.authorId,
    },
    ts: new Date().toISOString(),
    mode: "shadow",
  };
}

export function decideCommentsEchoGate(ctx: GateEventContext): WakeGateDecision {
  const gateName = "notion_comments_echo_drop";
  try {
    if (submittedPropertyChanged(ctx)) {
      return wake(gateName, "submitted_changed", ctx);
    }
    if (isJohn(ctx)) {
      return wake(gateName, "john_authored", ctx);
    }
    const notionType = ctx.notionType || "";
    if (
      notionType.startsWith("comment.") &&
      ctx.authorId &&
      ctx.fleetCommentsBotIds.has(ctx.authorId)
    ) {
      return skip(gateName, "fleet_comments_bot_echo", ctx);
    }
    if (notionType === "page.properties_updated") {
      const db = (ctx.parentDatabaseTitle || "").toLowerCase();
      const logOnlyDb = LOG_ONLY_DB_HINTS.some((h) => db.includes(h));
      const needsJohn = isTruthyFlag(ctx.needsJohnNow);
      if (logOnlyDb && !needsJohn) {
        return logOnly(gateName, "lane_row_property_flicker", ctx);
      }
    }
    return wake(gateName, "default_wake", ctx);
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    return wake(gateName, `error:${name}`, ctx);
  }
}
