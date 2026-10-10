import type { Env } from "../env.js";
import {
  AD_DOCS_DATA_SOURCE_ID,
  type GatePageInputs,
  type ShadowGateResult,
} from "./wake-gate-types.js";
import { parseWebhookForWakeGate } from "./payload-parse.js";
import { gateInputsFromNotionPage } from "./notion-properties.js";
import {
  applyDuplicateSkip,
  evaluateAdDocsGate,
  snapshotsEqual,
  wakeRelevantSnapshot,
} from "./ad-docs-gate.js";
import { parseCsvIds } from "./env-parse.js";

const NOTION_FETCH_MS = 3_000;
const DEDUPE_TTL_SEC = 60;
const DEDUPE_KEY_PREFIX = "wake_gate:dedupe:";
const RING_KEY = "wake_gate:ring";
const RING_MAX = 50;
const RING_ENTRY_MAX = 200;

export const SHADOW_LOG_EVENT = "ad_docs_wake_gate_shadow";

function failOpen(reason: string, parsed: Record<string, unknown>): ShadowGateResult {
  const payload = parseWebhookForWakeGate(parsed);
  return {
    decision: "would_wake",
    reason,
    pageId: payload.pageId,
    dataSourceId: payload.dataSourceId,
    notionEventType: payload.notionEventType,
    inputs: { fail_open: true, parse: payload },
  };
}

async function fetchNotionPage(
  token: string,
  pageId: string,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NOTION_FETCH_MS);
  try {
    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "notion-version": "2022-06-28",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`notion_http_${res.status}`);
    }
    const json = (await res.json()) as Record<string, unknown>;
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function readDedupe(
  env: Env,
  pageId: string,
): Promise<{ at: number; snap: ReturnType<typeof wakeRelevantSnapshot> } | null> {
  try {
    const raw = await env.RELAY_KV.get(`${DEDUPE_KEY_PREFIX}${pageId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      at: number;
      snap: { needsJohn: boolean; sensitive: boolean; kind: string | null };
    };
    if (!parsed || typeof parsed.at !== "number" || !parsed.snap) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeDedupe(
  env: Env,
  pageId: string,
  snap: ReturnType<typeof wakeRelevantSnapshot>,
): Promise<void> {
  try {
    await env.RELAY_KV.put(
      `${DEDUPE_KEY_PREFIX}${pageId}`,
      JSON.stringify({ at: Date.now(), snap }),
      { expirationTtl: DEDUPE_TTL_SEC + 5 },
    );
  } catch {
    // only KV write by default besides dedupe — fail open
  }
}

async function appendRing(env: Env, line: string): Promise<void> {
  if (env.WAKE_GATE_KV_RING !== "1") return;
  try {
    const raw = await env.RELAY_KV.get(RING_KEY);
    const arr: string[] = raw ? (JSON.parse(raw) as string[]) : [];
    const entry = line.slice(0, RING_ENTRY_MAX);
    arr.unshift(entry);
    await env.RELAY_KV.put(RING_KEY, JSON.stringify(arr.slice(0, RING_MAX)));
  } catch {
    // optional ring — ignore
  }
}

function logShadow(result: ShadowGateResult): void {
  console.log(
    JSON.stringify({
      event: SHADOW_LOG_EVENT,
      decision: result.decision,
      reason: result.reason,
      page_id: result.pageId,
      data_source_id: result.dataSourceId,
      notion_type: result.notionEventType,
      inputs: result.inputs,
      at: new Date().toISOString(),
    }),
  );
}

function automationInputs(parsed: Record<string, unknown>, payload: ReturnType<typeof parseWebhookForWakeGate>): GatePageInputs {
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
  };
}

export async function runShadowWakeGates(
  env: Env,
  parsed: Record<string, unknown>,
  notionType: string | null,
): Promise<void> {
  try {
    const payload = parseWebhookForWakeGate(parsed);
    const dsId = payload.dataSourceId;
    if (!dsId || dsId !== AD_DOCS_DATA_SOURCE_ID) {
      const notAd: ShadowGateResult = {
        decision: "would_wake",
        reason: "not_ad_docs",
        pageId: payload.pageId,
        dataSourceId: dsId,
        notionEventType: payload.notionEventType ?? notionType,
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
      inputs = automationInputs(parsed, payload);
      if (inputs.needsJohn === null) {
        logShadow({
          decision: "would_wake",
          reason: "needs_property_fetch",
          pageId: inputs.pageId,
          dataSourceId: inputs.dataSourceId,
          notionEventType: inputs.notionEventType,
          inputs: inputs as unknown as Record<string, unknown>,
        });
        return;
      }
    } else {
      if (!token) {
        logShadow(failOpen("needs_property_fetch", parsed));
        return;
      }
      try {
        const page = await fetchNotionPage(token, payload.pageId);
        inputs = gateInputsFromNotionPage(page, {
          pageId: payload.pageId,
          dataSourceId: dsId,
          updatedPropertyIds: payload.updatedPropertyIds,
          notionEventType: payload.notionEventType ?? notionType,
          authorUserIds: payload.authorUserIds,
          titleFromAutomation: payload.titleFromAutomation,
          inTrashFromPayload: payload.inTrash,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const reason = msg.includes("abort") ? "error:timeout" : `error:${msg}`;
        logShadow(failOpen(reason, parsed));
        return;
      }
    }

    let result = evaluateAdDocsGate(inputs, env);
    const snap = wakeRelevantSnapshot(inputs);
    const prev = await readDedupe(env, inputs.pageId);
    const now = Date.now();
    const isDup =
      prev !== null &&
      now - prev.at < DEDUPE_TTL_SEC * 1000 &&
      snapshotsEqual(prev.snap, snap);
    result = applyDuplicateSkip(result, inputs, isDup);
    await writeDedupe(env, inputs.pageId, snap);
    logShadow(result);
    await appendRing(env, JSON.stringify({ decision: result.decision, reason: result.reason }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logShadow(failOpen(`error:${msg}`, parsed));
  }
}

export function buildGatePageInputsForTest(inputs: GatePageInputs): GatePageInputs {
  return inputs;
}

export { parseCsvIds };
