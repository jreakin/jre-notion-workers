import { adoptedChangeGateName, decideAdoptedChangeGate } from "./adopted-change-gate.js";
import { opaqueLogItemId, runClefShadowWakeGate } from "./clef-wake-gate.js";
import { decideCommentsEchoGate } from "./comments-echo-gate.js";
import type { Env } from "../env.js";
import {
  GATE_LOG_DROP_REASON,
  shouldDropGateLogEvent,
} from "./gate-log-filter.js";
import {
  isFleetLocksParent,
  readPageParentIds,
  readWebhookParentFromBlock,
  webhookParentIsFleetLocks,
} from "./notion-ids.js";
import { fetchNotionPage } from "./notion-page-fetch.js";
import {
  FLEET_LOCKS_NON_SUBMITTED_PROPERTY_ID_VALUES,
  parseAdDocsPropertiesFromNotionPage,
  parseFleetLocksFieldsFromNotionPage,
  readPageAuthorId,
  readPageUserIds,
} from "./fleet-locks-properties.js";
import { submittedPropertyChanged } from "./gate-context-safety.js";
import type {
  ClefShadowLogEntry,
  GateEventContext,
  NotionPageProperties,
  WakeGateDecision,
} from "./gate-event-types.js";
import { kvTtl } from "../kv-ttl.js";
import { enqueueGateLogRow } from "../gate-log-ring.js";

const RECENT_PAGE_KEY_PREFIX = "wake_gate_recent_page:";
const ADOPTED_AT_KEY_PREFIX = "wake_gate_adopted_at:";
const ADOPTED_AT_DEDUPE_TTL_SECONDS = 60 * 60 * 24 * 90;
const DUPLICATE_WINDOW_MS = 60_000;
const MAX_FIELD_LEN = 200;

function parseIdSet(raw: unknown): Set<string> {
  if (typeof raw !== "string" || !raw.trim()) {
    return new Set();
  }
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function trimOptionalEnvId(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

function buildNonSubmittedPropertyIds(env: Env): Set<string> {
  const fromEnv = parseIdSet(env.NON_SUBMITTED_PROPERTY_IDS);
  if (fromEnv.size > 0) {
    return fromEnv;
  }
  return new Set(FLEET_LOCKS_NON_SUBMITTED_PROPERTY_ID_VALUES);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function truncate(value: unknown): unknown {
  if (typeof value === "string" && value.length > MAX_FIELD_LEN) {
    return `${value.slice(0, MAX_FIELD_LEN)}…`;
  }
  return value;
}

function sanitizeDecision(decision: WakeGateDecision): WakeGateDecision {
  const inputs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(decision.inputs)) {
    if (k === "page_id" || k === "author_id") {
      continue;
    }
    inputs[k] = truncate(v);
  }
  return {
    ...decision,
    reason:
      typeof decision.reason === "string"
        ? decision.reason.slice(0, MAX_FIELD_LEN)
        : decision.reason,
    inputs,
  };
}

function wakeRelevantHash(ctx: GateEventContext): string {
  const props = ctx.properties;
  const payload = JSON.stringify({
    needs_john: props?.needsJohn,
    sensitive: props?.sensitive,
    kind: props?.kind || "",
    submitted: submittedPropertyChanged(ctx),
  });
  let hash = 0;
  for (let i = 0; i < payload.length; i += 1) {
    hash = (hash * 31 + payload.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}

function readEnrichedProperties(parsed: Record<string, unknown>): NotionPageProperties | undefined {
  const block = asRecord(parsed.properties) ?? asRecord(parsed.page_properties);
  if (!block) {
    return undefined;
  }
  return {
    title: typeof block.title === "string" ? block.title : undefined,
    needsJohn: block.needs_john === true || block.needsJohn === true,
    sensitive: block.sensitive === true,
    kind: typeof block.kind === "string" ? block.kind : undefined,
    sourceRepo: typeof block.source_repo === "string" ? block.source_repo : undefined,
    documentType: typeof block.document_type === "string" ? block.document_type : undefined,
    inTrash: block.in_trash === true,
    adDocsParseOk: true,
  };
}

function readWebhookParent(data: Record<string, unknown> | null): ReturnType<typeof readWebhookParentFromBlock> {
  const parentBlock = asRecord(data?.parent);
  if (!parentBlock) {
    return {};
  }
  return readWebhookParentFromBlock(parentBlock);
}

/** Opaque, deterministic key for one webhook delivery: the Notion event id when present, else the raw body. */
export function opaqueEventKey(parsed: Record<string, unknown>, rawBody: string): string {
  const src = typeof parsed.id === "string" && parsed.id ? `id:${parsed.id}` : `body:${rawBody}`;
  let h1 = 0x811c9dc5;
  let h2 = 0;
  for (let i = 0; i < src.length; i += 1) {
    const c = src.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = (h2 * 31 + c) >>> 0;
  }
  return `ev:${h1.toString(16)}${h2.toString(16)}`;
}

export function buildGateContext(
  parsed: Record<string, unknown>,
  notionType: string | null,
  rawBody: string,
  env: Env,
): GateEventContext {
  const data = asRecord(parsed.data);
  const entity = asRecord(parsed.entity) ?? asRecord(data?.entity);

  const webhookAuthorIds: string[] = [];
  const authors = parsed.authors;
  if (Array.isArray(authors)) {
    for (const entry of authors) {
      const rec = asRecord(entry);
      if (typeof rec?.id === "string") {
        webhookAuthorIds.push(rec.id);
      }
    }
  }
  const authorId = webhookAuthorIds[0];

  const isCommentEvent =
    notionType === "comment.created" ||
    notionType === "comment.updated" ||
    notionType === "comment.deleted";

  let pageId = typeof entity?.id === "string" ? entity.id : undefined;
  if (isCommentEvent && typeof data?.page_id === "string" && data.page_id.length > 0) {
    pageId = data.page_id;
  }

  const updatedPropertyIds: string[] = [];
  const rawUpdated = data?.updated_properties ?? data?.updated_property_ids;
  if (Array.isArray(rawUpdated)) {
    for (const p of rawUpdated) {
      if (typeof p === "string") {
        updatedPropertyIds.push(p);
      }
    }
  }

  const enriched = readEnrichedProperties(parsed);
  const propertiesAvailable = Boolean(enriched);
  const properties: NotionPageProperties = enriched ?? {};

  const webhookParent = readWebhookParent(data);
  const webhookParentKnown = webhookParentIsFleetLocks(
    webhookParent,
    trimOptionalEnvId(env.FLEET_LOCKS_DATA_SOURCE_ID),
    trimOptionalEnvId(env.FLEET_LOCKS_DATABASE_ID),
  );

  const ctx: GateEventContext = {
    notionType,
    rawBody,
    eventKey: opaqueEventKey(parsed, rawBody),
    pageId,
    authorId,
    webhookAuthorIds,
    authorName: undefined,
    isCommentEvent,
    properties,
    propertiesAvailable,
    parentDatabaseTitle:
      typeof data?.parent_database_title === "string" ? data.parent_database_title : undefined,
    webhookParentDataSourceId: webhookParent.dataSourceId,
    webhookParentDatabaseId: webhookParent.databaseId,
    needsJohnNow: properties.needsJohn === true,
    duplicateWithin60s: false,
    johnUserIds: parseIdSet(env.JOHN_NOTION_USER_IDS),
    fleetCommentsBotIds: parseIdSet(env.FLEET_COMMENTS_BOT_NOTION_USER_IDS),
    submittedPropertyIds: parseIdSet(env.SUBMITTED_PROPERTY_IDS),
    needsJohnPropertyIds: parseIdSet(env.NEEDS_JOHN_PROPERTY_IDS),
    commentId: isCommentEvent && typeof entity?.id === "string" && entity.id ? entity.id : undefined,
    nonSubmittedPropertyIds: buildNonSubmittedPropertyIds(env),
    updatedPropertyIds,
    fleetLocksDataSourceId: trimOptionalEnvId(env.FLEET_LOCKS_DATA_SOURCE_ID),
    fleetLocksDatabaseId: trimOptionalEnvId(env.FLEET_LOCKS_DATABASE_ID),
    fleetLocksParentKnown: webhookParentKnown,
    webhookIndicatedFleetLocks: webhookParentKnown === true,
  };
  properties.submittedChanged = submittedPropertyChanged(ctx);
  return ctx;
}

function pageEventNeedsNotionFetch(ctx: GateEventContext, notionType: string | null): boolean {
  const adDocsTypes = new Set(["page.created", "page.added", "page_created"]);
  const needsAdDocs = Boolean(
    notionType && adDocsTypes.has(notionType) && !ctx.propertiesAvailable,
  );
  const fleetPage =
    notionType === "page.properties_updated" ||
    notionType === "page.created" ||
    notionType === "page.added" ||
    notionType === "page_created";
  if (!fleetPage) {
    return needsAdDocs;
  }
  if (ctx.fleetLocksParentKnown === false) {
    return needsAdDocs;
  }
  if (ctx.fleetLocksParentKnown === true) {
    return true;
  }
  return needsAdDocs || Boolean(ctx.fleetLocksDataSourceId || ctx.fleetLocksDatabaseId);
}

async function loadAdoptedAtDedupe(env: Env, ctx: GateEventContext): Promise<void> {
  if (!ctx.pageId) {
    return;
  }
  try {
    const prior = await env.RELAY_KV.get(`${ADOPTED_AT_KEY_PREFIX}${ctx.pageId}`);
    if (prior) {
      ctx.adoptedAtAlreadyWoken = prior;
    }
  } catch {
    // fail-open
  }
}

async function storeAdoptedAtDedupe(
  env: Env,
  ctx: GateEventContext,
  adoptedAt: string,
): Promise<void> {
  if (!ctx.pageId) {
    return;
  }
  try {
    await env.RELAY_KV.put(`${ADOPTED_AT_KEY_PREFIX}${ctx.pageId}`, adoptedAt, {
      expirationTtl: kvTtl(ADOPTED_AT_DEDUPE_TTL_SECONDS),
    });
  } catch {
    // ignore
  }
}

export async function fetchNotionPageOutcome(
  pageId: string,
  env: Env,
): Promise<{ ok: true; page: Record<string, unknown> } | { ok: false; reason: string }> {
  const token = env.NOTION_API_TOKEN?.trim();
  if (!token) {
    return { ok: false, reason: "notion_token_missing" };
  }
  try {
    const page = await fetchNotionPage(token, pageId);
    return { ok: true, page };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, reason: "notion_fetch_timeout" };
    }
    return { ok: false, reason: "notion_fetch_failed" };
  }
}

export async function enrichContextFromNotionPage(
  env: Env,
  ctx: GateEventContext,
  notionType: string | null,
): Promise<void> {
  if (!ctx.pageId) {
    return;
  }
  if (!pageEventNeedsNotionFetch(ctx, notionType)) {
    return;
  }

  const fetched = await fetchNotionPageOutcome(ctx.pageId, env);
  if (!fetched.ok) {
    ctx.notionFetchFailReason = fetched.reason;
    return;
  }

  const page = fetched.page;
  const parent = readPageParentIds(page);
  const fleetDs = ctx.fleetLocksDataSourceId;
  const fleetDb = ctx.fleetLocksDatabaseId;
  if (fleetDs || fleetDb) {
    const fetchedParentKnown = isFleetLocksParent(parent, fleetDs, fleetDb);
    if (ctx.webhookIndicatedFleetLocks && !fetchedParentKnown) {
      ctx.fleetLocksParentKnown = false;
      ctx.notionFetchFailReason = "notion_page_unreadable";
      console.log(
        JSON.stringify({
          event: "wake_gate_parent_mismatch",
          sub_reason: "parent_mismatch",
          notion_type: notionType,
        }),
      );
    } else {
      ctx.fleetLocksParentKnown = fetchedParentKnown;
      if (ctx.fleetLocksParentKnown) {
        const fields = parseFleetLocksFieldsFromNotionPage(page);
        ctx.fleetLocksFields = fields;
        ctx.fleetLocksAdoptedAt = fields.adoptedAt;
        const userIds = readPageUserIds(page);
        ctx.pageCreatedById = userIds.createdById;
        ctx.pageLastEditedById = userIds.lastEditedById;
        ctx.pageAuthorId = readPageAuthorId(page, notionType, ctx.authorId);
        if (fields.parseOk) {
          await loadAdoptedAtDedupe(env, ctx);
        }
      }
    }
  }

  const adDocsTypes = new Set(["page.created", "page.added", "page_created"]);
  if (notionType && adDocsTypes.has(notionType) && !ctx.propertiesAvailable) {
    const parsed = parseAdDocsPropertiesFromNotionPage(page);
    if (!parsed.ok) {
      ctx.properties = { ...(ctx.properties ?? {}), adDocsParseOk: false };
      ctx.propertiesAvailable = false;
    } else {
      ctx.properties = { ...parsed.properties, adDocsParseOk: true };
      ctx.propertiesAvailable = true;
      ctx.needsJohnNow = parsed.properties.needsJohn === true;
      propertiesSubmittedRefresh(ctx);
    }
  }
}

function propertiesSubmittedRefresh(ctx: GateEventContext): void {
  if (!ctx.properties) {
    ctx.properties = {};
  }
  ctx.properties.submittedChanged = submittedPropertyChanged(ctx);
}

async function markDuplicateIfNeeded(env: Env, ctx: GateEventContext): Promise<void> {
  if (env.WAKE_GATE_DEDUPE !== "1" || !ctx.pageId) {
    return;
  }
  try {
    const key = `${RECENT_PAGE_KEY_PREFIX}${ctx.pageId}`;
    const now = Date.now();
    const hash = wakeRelevantHash(ctx);
    const prevRaw = await env.RELAY_KV.get(key);
    if (prevRaw) {
      try {
        const prev = JSON.parse(prevRaw) as { ts?: number; hash?: string };
        if (
          typeof prev.ts === "number" &&
          now - prev.ts < DUPLICATE_WINDOW_MS &&
          prev.hash === hash
        ) {
          ctx.duplicateWithin60s = true;
          ctx.priorWakeHash = prev.hash;
        }
      } catch {
        // ignore corrupt KV
      }
    }
    await env.RELAY_KV.put(key, JSON.stringify({ ts: now, hash }), { expirationTtl: kvTtl(120) });
  } catch {
    // KV failure must not block shadow decisions
  }
}

export async function appendShadowLog(env: Env, decision: WakeGateDecision): Promise<void> {
  const sanitized = sanitizeDecision(decision);
  console.log(JSON.stringify({ event: "wake_gate_shadow", ...sanitized }));
  await enqueueGateLogRow(env, { stream: "wake_gate_shadow", ...sanitized });
}

function shadowRunnerErrorDecision(err: unknown): WakeGateDecision {
  const name = err instanceof Error ? err.name : "Error";
  return {
    gate_name: "wake_gate_shadow_runner",
    decision: "would_wake",
    reason: `error:${name}`,
    inputs: {},
    ts: new Date().toISOString(),
    mode: "shadow",
  };
}

async function logGateLogDrop(
  _env: Env,
  ctx: GateEventContext,
  notionType: string | null,
): Promise<void> {
  const entry: ClefShadowLogEntry = {
    ts: new Date().toISOString(),
    gate: "clef_wake",
    item_id: opaqueLogItemId(ctx.pageId ?? "unknown"),
    source: "notion_page",
    event: notionType,
    rule_decision: "would_skip",
    clef_decision: "would_skip",
    p_action: null,
    p_dup: null,
    q_when: null,
    confidence: null,
    model: null,
    latency_ms: null,
    sampled_full: null,
    mode: "shadow",
    actually_ran: "coalesce_enqueued",
    reason: GATE_LOG_DROP_REASON,
  };
  console.log(JSON.stringify({ stream: "clef_wake_shadow", ...entry }));
}

async function runGateDecisions(
  env: Env,
  ctx: GateEventContext,
  notionType: string | null,
  parsed: Record<string, unknown>,
  parseOk: boolean,
): Promise<WakeGateDecision[]> {
  const decisions: WakeGateDecision[] = [];
  decisions.push(decideCommentsEchoGate(ctx));

  const fleetPage =
    notionType === "page.properties_updated" ||
    notionType === "page.created" ||
    notionType === "page.added" ||
    notionType === "page_created";
  if (fleetPage) {
    decisions.push(decideAdoptedChangeGate(ctx));
  }

  for (const decision of decisions) {
    await appendShadowLog(env, decision);
    if (
      decision.gate_name === adoptedChangeGateName &&
      decision.decision === "would_wake" &&
      decision.reason === "adopted_change" &&
      ctx.fleetLocksAdoptedAt
    ) {
      await storeAdoptedAtDedupe(env, ctx, ctx.fleetLocksAdoptedAt);
    }
  }
  await runClefShadowWakeGate(env, ctx, notionType, parsed, parseOk, decisions);
  return decisions;
}

export async function runHarnessRuleShadowGates(
  env: Env,
  parsed: Record<string, unknown>,
  notionType: string | null,
  rawBody: string,
  parseOk = true,
): Promise<void> {
  try {
    const ctx = buildGateContext(parsed, notionType, rawBody, env);
    if (shouldDropGateLogEvent(ctx, env)) {
      await logGateLogDrop(env, ctx, notionType);
      return;
    }
    try {
      await markDuplicateIfNeeded(env, ctx);
    } catch {
      // fail-open
    }
    try {
      await enrichContextFromNotionPage(env, ctx, notionType);
    } catch (err) {
      ctx.notionFetchFailReason = `error:${err instanceof Error ? err.name : "Error"}`;
    }
    await runGateDecisions(env, ctx, notionType, parsed, parseOk);
  } catch (err) {
    await appendShadowLog(env, shadowRunnerErrorDecision(err));
  }
}
