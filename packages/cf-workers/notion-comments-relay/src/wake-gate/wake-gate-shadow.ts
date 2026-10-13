import type { Env } from "../env.js";
import { runHarnessRuleShadowGates } from "./gate-orchestration.js";
import {
  AD_DOCS_DATA_SOURCE_ID,
  type GatePageInputs,
  type ShadowGateResult,
  type WakeRelevantSnapshot,
} from "./wake-gate-types.js";
import { parseWebhookForWakeGate } from "./payload-parse.js";
import { gateInputsFromNotionPage } from "./notion-properties.js";
import {
  applyDuplicateSkip,
  evaluateAdDocsGate,
  gateLogInputs,
  snapshotsEqual,
  wakeRelevantSnapshot,
} from "./ad-docs-gate.js";
import {
  fetchNotionPage,
  pageBelongsToAdDocs,
  readPageParentIds,
} from "./notion-page-fetch.js";
import {
  getCachedCommentParentResolution,
  setCachedCommentParentResolution,
} from "./page-fetch-cache.js";
import { kvTtl } from "../kv-ttl.js";

const DEDUPE_TTL_SEC = 60;
const DEDUPE_KEY_PREFIX = "wake_gate:dedupe:";
const RING_KEY = "wake_gate:ring";
const RING_MAX = 50;
const RING_ENTRY_MAX = 200;
const RING_TTL_SEC = 86_400;
const NOT_AD_DOCS_SAMPLE = 64;

export const SHADOW_LOG_EVENT = "ad_docs_wake_gate_shadow";

let notAdDocsCounter = 0;

function failOpen(reason: string, parsed: Record<string, unknown>): ShadowGateResult {
  const payload = parseWebhookForWakeGate(parsed);
  return {
    decision: "would_wake",
    reason,
    pageId: payload.pageId,
    dataSourceId: payload.dataSourceId,
    notionEventType: payload.notionEventType,
    inputs: { fail_open: true },
  };
}

function errorReasonFromUnknown(err: unknown): string {
  if (err instanceof Error) {
    return `error:${err.name}`;
  }
  return "error:Error";
}

interface DedupeRecord {
  at: number;
  snap: WakeRelevantSnapshot;
  reason: string;
}

async function readDedupe(env: Env, pageId: string): Promise<DedupeRecord | null> {
  if (env.WAKE_GATE_DEDUPE !== "1") {
    return null;
  }
  try {
    const raw = await env.RELAY_KV.get(`${DEDUPE_KEY_PREFIX}${pageId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DedupeRecord;
    if (!parsed || typeof parsed.at !== "number" || !parsed.snap) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeDedupe(
  env: Env,
  pageId: string,
  snap: WakeRelevantSnapshot,
  reason: string,
): Promise<void> {
  if (env.WAKE_GATE_DEDUPE !== "1") {
    return;
  }
  try {
    await env.RELAY_KV.put(
      `${DEDUPE_KEY_PREFIX}${pageId}`,
      JSON.stringify({ at: Date.now(), snap, reason }),
      { expirationTtl: kvTtl(DEDUPE_TTL_SEC + 5) },
    );
  } catch {
    // fail open — optional KV write
  }
}

async function appendRing(env: Env, line: string): Promise<void> {
  if (env.WAKE_GATE_KV_RING !== "1") return;
  try {
    const raw = await env.RELAY_KV.get(RING_KEY);
    const arr: string[] = raw ? (JSON.parse(raw) as string[]) : [];
    const entry = line.slice(0, RING_ENTRY_MAX);
    arr.unshift(entry);
    await env.RELAY_KV.put(RING_KEY, JSON.stringify(arr.slice(0, RING_MAX)), {
      expirationTtl: kvTtl(RING_TTL_SEC),
    });
  } catch {
    // optional ring — ignore
  }
}

function logShadow(result: ShadowGateResult, logIds?: { database_id?: string }): void {
  if (result.reason === "not_ad_docs") {
    notAdDocsCounter += 1;
    if (notAdDocsCounter % NOT_AD_DOCS_SAMPLE !== 1) {
      return;
    }
    console.log(
      JSON.stringify({
        event: SHADOW_LOG_EVENT,
        decision: result.decision,
        reason: result.reason,
        notion_type: result.notionEventType,
        not_ad_docs_sampled: true,
        not_ad_docs_total: notAdDocsCounter,
        at: new Date().toISOString(),
      }),
    );
    return;
  }

  console.log(
    JSON.stringify({
      event: SHADOW_LOG_EVENT,
      decision: result.decision,
      reason: result.reason,
      data_source_id: result.dataSourceId,
      ...(logIds?.database_id ? { database_id: logIds.database_id } : {}),
      notion_type: result.notionEventType,
      inputs: result.inputs,
      at: new Date().toISOString(),
    }),
  );
}

function automationInputs(
  payload: ReturnType<typeof parseWebhookForWakeGate>,
): GatePageInputs {
  return {
    pageId: payload.pageId ?? "",
    dataSourceId: payload.dataSourceId,
    title: payload.titleFromAutomation,
    inTrash: payload.inTrash ?? false,
    needsJohn: null,
    sensitive: null,
    kind: null,
    sourceRepo: null,
    documentType: null,
    hasClientsRelation: null,
    hasProjectRelation: null,
    updatedPropertyIds: payload.updatedPropertyIds,
    notionEventType: payload.notionEventType,
    authorUserIds: payload.authorUserIds,
    schemaNeedsPropertyFetch: true,
  };
}

function isPageEvent(notionType: string | null): boolean {
  return notionType !== null && notionType.startsWith("page.");
}

function isAdDocsDataSourceId(dsId: string | null): boolean {
  return dsId !== null && dsId === AD_DOCS_DATA_SOURCE_ID;
}

async function resolveCommentParentForAdDocs(
  env: Env,
  token: string,
  pageId: string,
): Promise<
  | { adDocs: true; dataSourceId: string; databaseId: string | null; matchedVia: "data_source_id" | "database_id" }
  | { adDocs: false }
> {
  const cached = getCachedCommentParentResolution(pageId);
  if (cached === "not_ad_docs") {
    return { adDocs: false };
  }
  if (cached === "ad_docs") {
    return {
      adDocs: true,
      dataSourceId: AD_DOCS_DATA_SOURCE_ID,
      databaseId: null,
      matchedVia: "data_source_id",
    };
  }

  const page = await fetchNotionPage(token, pageId);
  const membership = pageBelongsToAdDocs(page, env);
  if (!membership.isAdDocs) {
    setCachedCommentParentResolution(pageId, "not_ad_docs");
    return { adDocs: false };
  }
  setCachedCommentParentResolution(pageId, "ad_docs");
  return {
    adDocs: true,
    dataSourceId: AD_DOCS_DATA_SOURCE_ID,
    databaseId: membership.databaseId,
    matchedVia: membership.matchedVia ?? "data_source_id",
  };
}

async function runAdDocsWakeGateShadow(
  env: Env,
  parsed: Record<string, unknown>,
  notionType: string | null,
): Promise<void> {
  try {
    const payload = parseWebhookForWakeGate(parsed);
    const eventType = payload.notionEventType ?? notionType;
    let dsId = payload.dataSourceId;
    let parentDatabaseIdForLog: string | undefined;

    if (!isAdDocsDataSourceId(dsId) && payload.isCommentEvent) {
      if (!payload.pageId) {
        logShadow(failOpen("missing_page_id", parsed));
        return;
      }
      const token = env.NOTION_API_TOKEN;
      if (!token) {
        logShadow({
          decision: "would_wake",
          reason: "comment_unresolved",
          pageId: payload.pageId,
          dataSourceId: dsId,
          notionEventType: eventType,
          inputs: { comment_unresolved: true },
        });
        return;
      }
      try {
        const resolved = await resolveCommentParentForAdDocs(env, token, payload.pageId);
        if (!resolved.adDocs) {
          logShadow({
            decision: "would_wake",
            reason: "comment_unresolved",
            pageId: payload.pageId,
            dataSourceId: dsId,
            notionEventType: eventType,
            inputs: { comment_unresolved: true },
          });
          return;
        }
        dsId = resolved.dataSourceId;
        if (resolved.matchedVia === "database_id" && resolved.databaseId) {
          parentDatabaseIdForLog = resolved.databaseId;
        }
      } catch (err) {
        logShadow(failOpen(errorReasonFromUnknown(err), parsed));
        return;
      }
    } else if (!isAdDocsDataSourceId(dsId)) {
      const notAd: ShadowGateResult = {
        decision: "would_wake",
        reason: "not_ad_docs",
        pageId: payload.pageId,
        dataSourceId: dsId,
        notionEventType: eventType,
        inputs: { data_source_id: dsId },
      };
      logShadow(notAd);
      return;
    }

    if (!payload.pageId) {
      logShadow(failOpen("missing_page_id", parsed));
      return;
    }

    const token = env.NOTION_API_TOKEN;
    let inputs: GatePageInputs;

    if (payload.isAutomationPageObject) {
      inputs = automationInputs(payload);
      logShadow({
        decision: "would_wake",
        reason: "needs_property_fetch",
        pageId: inputs.pageId,
        dataSourceId: inputs.dataSourceId,
        notionEventType: inputs.notionEventType,
        inputs: gateLogInputs(inputs),
      });
      return;
    }

    if (!token) {
      logShadow(failOpen("needs_property_fetch", parsed));
      return;
    }

    try {
      const page = await fetchNotionPage(token, payload.pageId);
      const parentIds = readPageParentIds(page);
      const membership = pageBelongsToAdDocs(page, env);
      const resolvedDs =
        dsId ??
        (membership.isAdDocs ? AD_DOCS_DATA_SOURCE_ID : parentIds.dataSourceId);
      if (membership.matchedVia === "database_id" && membership.databaseId) {
        parentDatabaseIdForLog = membership.databaseId;
      }
      inputs = gateInputsFromNotionPage(page, {
        pageId: payload.pageId,
        dataSourceId: resolvedDs,
        updatedPropertyIds: payload.updatedPropertyIds,
        updatedPropertiesKnown: payload.updatedPropertiesKnown,
        notionEventType: eventType,
        authorUserIds: payload.authorUserIds,
        titleFromAutomation: payload.titleFromAutomation,
        inTrashFromPayload: payload.inTrash,
      });
    } catch (err) {
      logShadow(failOpen(errorReasonFromUnknown(err), parsed));
      return;
    }

    if (inputs.schemaNeedsPropertyFetch) {
      logShadow({
        decision: "would_wake",
        reason: "needs_property_fetch",
        pageId: inputs.pageId,
        dataSourceId: inputs.dataSourceId,
        notionEventType: inputs.notionEventType,
        inputs: gateLogInputs(inputs),
      });
      return;
    }

    let result = evaluateAdDocsGate(inputs, env);
    const snap = wakeRelevantSnapshot(inputs);
    let isDup = false;
    let priorReason: string | null = null;
    if (isPageEvent(inputs.notionEventType)) {
      const prev = await readDedupe(env, inputs.pageId);
      const now = Date.now();
      if (prev !== null && now - prev.at < DEDUPE_TTL_SEC * 1000 && snapshotsEqual(prev.snap, snap)) {
        isDup = true;
        priorReason = prev.reason;
      }
      result = applyDuplicateSkip(result, inputs, isDup, priorReason);
      if (
        !isDup &&
        result.decision === "would_wake" &&
        result.reason === "default_wake"
      ) {
        await writeDedupe(env, inputs.pageId, snap, result.reason);
      }
    }

    const logged = {
      ...result,
      inputs: gateLogInputs(inputs, result),
    };
    logShadow(
      logged,
      parentDatabaseIdForLog ? { database_id: parentDatabaseIdForLog } : undefined,
    );
    await appendRing(env, JSON.stringify({ decision: result.decision, reason: result.reason }));
  } catch (err) {
    logShadow(failOpen(errorReasonFromUnknown(err), parsed));
  }
}

export async function runShadowWakeGates(
  env: Env,
  parsed: Record<string, unknown>,
  notionType: string | null,
  rawBody = "",
  parseOk = true,
): Promise<void> {
  await runAdDocsWakeGateShadow(env, parsed, notionType);
  await runHarnessRuleShadowGates(env, parsed, notionType, rawBody, parseOk);
}
