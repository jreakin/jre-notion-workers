import type {
  GatePageInputs,
  ShadowGateResult,
  WakeDecision,
  WakeRelevantSnapshot,
} from "./wake-gate-types.js";
import { evaluateSafety } from "./notion-safety.js";
import type { SafetyEnv } from "./notion-safety.js";
import { isTemplateLikeTitle } from "./title-match.js";

const ADE_SOURCE_REPO = "jre-agent-dev-cli";
const AGENT_DIGEST_DOC_TYPE = "Agent Digest";

function sourceRepoIsSet(sourceRepo: string | null): boolean {
  return sourceRepo !== null && sourceRepo.trim().length > 0;
}

export function wakeRelevantSnapshot(inputs: GatePageInputs): WakeRelevantSnapshot {
  const title = inputs.title ?? "";
  return {
    needsJohn: inputs.needsJohn === true,
    sensitive: inputs.sensitive === true,
    kind: inputs.kind,
    titleMatchedTemplate: isTemplateLikeTitle(title),
    sourceRepo: inputs.sourceRepo,
    documentType: inputs.documentType,
    inTrash: inputs.inTrash,
  };
}

export function snapshotsEqual(a: WakeRelevantSnapshot, b: WakeRelevantSnapshot): boolean {
  return (
    a.needsJohn === b.needsJohn &&
    a.sensitive === b.sensitive &&
    a.kind === b.kind &&
    a.titleMatchedTemplate === b.titleMatchedTemplate &&
    a.sourceRepo === b.sourceRepo &&
    a.documentType === b.documentType &&
    a.inTrash === b.inTrash
  );
}

function result(
  decision: WakeDecision,
  reason: string,
  inputs: GatePageInputs,
): ShadowGateResult {
  return {
    decision,
    reason,
    pageId: inputs.pageId,
    dataSourceId: inputs.dataSourceId,
    notionEventType: inputs.notionEventType,
    inputs: gateLogInputs(inputs, { decision, reason }),
  };
}

export function gateLogInputs(
  inputs: GatePageInputs,
  result?: Pick<ShadowGateResult, "decision" | "reason">,
): Record<string, unknown> {
  const title = inputs.title ?? "";
  return {
    title_length: title.length,
    title_matched_template: isTemplateLikeTitle(title),
    needsJohn: inputs.needsJohn,
    sensitive: inputs.sensitive,
    kind: inputs.kind,
    sourceRepo: inputs.sourceRepo,
    documentType: inputs.documentType,
    inTrash: inputs.inTrash,
    hasClientsRelation: inputs.hasClientsRelation,
    hasProjectRelation: inputs.hasProjectRelation,
    updated_property_count: inputs.updatedPropertyIds.length,
    ...(result ? { decision: result.decision, gate_reason: result.reason } : {}),
  };
}

export function evaluateAdDocsGate(inputs: GatePageInputs, env: SafetyEnv): ShadowGateResult {
  const safety = evaluateSafety(inputs, env);
  if (safety.forceWake && safety.reason) {
    return result("would_wake", safety.reason, inputs);
  }

  if (inputs.needsJohn === true) {
    return result("would_wake", "needs_john", inputs);
  }
  if (inputs.sensitive === true) {
    return result("would_wake", "sensitive", inputs);
  }
  if (inputs.kind === "Decision") {
    return result("would_wake", "kind_decision", inputs);
  }
  if (inputs.kind === "Brief") {
    return result("would_wake", "kind_brief", inputs);
  }

  if (inputs.sourceRepo === ADE_SOURCE_REPO && inputs.documentType === AGENT_DIGEST_DOC_TYPE) {
    return result("would_log_only", "ade_agent_digest", inputs);
  }
  if (inputs.sourceRepo === ADE_SOURCE_REPO) {
    return result("would_skip", "ade_source_repo", inputs);
  }
  if (inputs.documentType === AGENT_DIGEST_DOC_TYPE) {
    return result("would_wake", "agent_digest_needs_review", inputs);
  }

  const title = inputs.title ?? "";
  if (inputs.inTrash) {
    return result("would_skip", "in_trash", inputs);
  }
  if (isTemplateLikeTitle(title) && !sourceRepoIsSet(inputs.sourceRepo)) {
    return result("would_skip", "template_or_test_title", inputs);
  }

  if (safety.fleetEchoSkip) {
    return result("would_skip", "fleet_bot_echo", inputs);
  }

  return result("would_wake", "default_wake", inputs);
}

export function applyDuplicateSkip(
  base: ShadowGateResult,
  inputs: GatePageInputs,
  isDuplicate: boolean,
  priorReason: string | null,
): ShadowGateResult {
  const isPageEvent = inputs.notionEventType?.startsWith("page.") ?? false;
  if (!isPageEvent || !isDuplicate) {
    return base;
  }
  if (
    priorReason === "default_wake" &&
    base.decision === "would_wake" &&
    base.reason === "default_wake"
  ) {
    return result("would_skip", "duplicate_within_60s", inputs);
  }
  return base;
}
