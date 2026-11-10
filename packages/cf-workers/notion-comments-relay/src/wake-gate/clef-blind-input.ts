import type { GateEventContext } from "./gate-event-types.js";
import { isClefPageCreatedEvent } from "./clef-decision-logic.js";
import { buildClefStateString } from "./clef-state.js";
import { clefPageCreatedHonorJohnAuthored } from "./clef-page-created-env.js";
import { isJohn } from "./gate-context-safety.js";
import type { Env } from "../env.js";
import { isLaunchScopeTaskPageCreated } from "./launch-scope-task.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** Same Clef state with title, snippet, kind and status cleared (non-reversible baseline). */
export function buildClefBaselineStateString(
  ctx: GateEventContext,
  notionType: string | null,
  parsed: Record<string, unknown>,
  pageEventsLast60s: number,
  isBotEcho: boolean,
): string {
  const data = asRecord(parsed.data) ?? {};
  const strippedData = { ...data, text: undefined, rich_text: undefined, content: undefined };
  const baselineCtx: GateEventContext = {
    ...ctx,
    properties: {
      ...(ctx.properties ?? {}),
      title: undefined,
      kind: undefined,
      authorLane: undefined,
      clefMasked: undefined,
      scopeLabel: undefined,
      statusLabel: undefined,
    },
    fleetLocksFields: ctx.fleetLocksFields
      ? { ...ctx.fleetLocksFields, statusName: undefined }
      : undefined,
  };
  return buildClefStateString(
    baselineCtx,
    notionType,
    { ...parsed, data: strippedData },
    pageEventsLast60s,
    isBotEcho,
  );
}

export function parentDbNameKnown(ctx: GateEventContext): boolean {
  const name = ctx.parentDbConfigName ?? ctx.parentDatabaseTitle;
  return typeof name === "string" && name.trim().length > 0 && name !== "unknown";
}

/** Field names missing for a non-blind page.created Clef skip. */
export function clefBlindInputMissingFields(
  ctx: GateEventContext,
  state: string,
  baselineState: string,
): string[] {
  const missing: string[] = [];
  const title = (ctx.properties?.title ?? "").trim();
  if (!title) missing.push("title");
  if (!parentDbNameKnown(ctx)) missing.push("parent_db");
  if (state === baselineState) missing.push("baseline");
  return missing;
}

export type PageCreatedSkipGate = {
  allowed: boolean;
  forceReason: string | null;
};

/** Live / shadow Option 1 skip allowed only with real signal (not blind, not launch, honor John when configured). */
export function pageCreatedLiveSkipGate(
  ctx: GateEventContext,
  notionType: string | null,
  parsed: Record<string, unknown>,
  modeReason: string | null,
  state: string,
  baselineState: string,
  env: Env,
  baseRuleEligible: boolean,
): PageCreatedSkipGate {
  if (!isClefPageCreatedEvent(notionType) || !baseRuleEligible) {
    return { allowed: false, forceReason: null };
  }
  if (isLaunchScopeTaskPageCreated(ctx, env)) {
    return { allowed: false, forceReason: "launch_scope_task" };
  }
  if (clefPageCreatedHonorJohnAuthored(env) && isJohn(ctx)) {
    return { allowed: false, forceReason: "john_authored" };
  }
  const missing = clefBlindInputMissingFields(ctx, state, baselineState);
  if (missing.length > 0) {
    return { allowed: false, forceReason: `clef_blind_input:${missing.join(",")}` };
  }
  return { allowed: true, forceReason: null };
}
