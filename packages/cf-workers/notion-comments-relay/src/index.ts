/**
 * notion-comments-relay — Cloudflare Worker
 *
 * Accepts Notion Integration webhooks, verifies signatures, coalesces events
 * for ~45s, and forwards a batch to the CoS Grok Bot webhook ingress.
 */

export interface Env {
  RELAY_KV: KVNamespace;
  COS_WEBHOOK_URL: string;
  COS_WEBHOOK_AUTHORIZATION: string;
  SETUP_SECRET: string;
  NOTION_VERIFICATION_TOKEN?: string;
}

const SERVICE_NAME = "notion-comments-relay";
const COALESCE_MS = 45_000;

const KV_VERIFICATION_TOKEN = "notion:verification_token";
const KV_PENDING = "relay:pending";
const KV_FLUSH_AT = "relay:flush_at";
const KV_FLUSH_LOCK = "relay:flush_lock";
const KV_LAST_FLUSH = "relay:last_flush";

const DROPPED_EVENT_TYPES = new Set(["page.deleted", "page.undeleted"]);

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;
const TEXT_OK = new Response("ok", { status: 200 });

interface PendingEvent {
  received_at: string;
  type: string;
  body: unknown;
}

interface PendingState {
  events: PendingEvent[];
  window_started_at: string;
}

interface LastFlushMeta {
  at: string;
  count: number;
  types: string[];
  cos_status: number;
}

interface CoalesceForwardBody {
  coalesce: true;
  window_ms: number;
  count: number;
  types: string[];
  events: unknown[];
}

interface HandshakeBody {
  verification_token?: string;
}

interface NotionWebhookBody {
  type?: string;
  verification_token?: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function methodNotAllowed(): Response {
  return jsonResponse({ error: "method_not_allowed" }, 405);
}

function unauthorized(): Response {
  return jsonResponse({ error: "unauthorized" }, 401);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyNotionSignature(
  rawBody: string,
  signatureHeader: string | null,
  verificationToken: string,
): Promise<boolean> {
  if (!signatureHeader || !verificationToken) {
    return false;
  }
  const digest = await hmacSha256Hex(verificationToken, rawBody);
  const expected = `sha256=${digest}`;
  return timingSafeEqual(expected, signatureHeader);
}

function isHandshakeBody(parsed: NotionWebhookBody): boolean {
  return typeof parsed.verification_token === "string" && parsed.verification_token.length > 0;
}

function shouldDropEvent(eventType: string | undefined): boolean {
  if (!eventType) {
    return false;
  }
  return DROPPED_EVENT_TYPES.has(eventType);
}

function uniqueTypes(events: PendingEvent[]): string[] {
  const seen = new Set<string>();
  for (const event of events) {
    seen.add(event.type);
  }
  return [...seen].sort();
}

async function readVerificationToken(env: Env): Promise<string | null> {
  const fromKv = await env.RELAY_KV.get(KV_VERIFICATION_TOKEN);
  if (fromKv) {
    return fromKv;
  }
  if (env.NOTION_VERIFICATION_TOKEN) {
    return env.NOTION_VERIFICATION_TOKEN;
  }
  return null;
}

async function storeVerificationToken(env: Env, token: string): Promise<void> {
  await env.RELAY_KV.put(KV_VERIFICATION_TOKEN, token);
}

async function readPending(env: Env): Promise<PendingState> {
  const raw = await env.RELAY_KV.get(KV_PENDING, "json");
  if (!raw || typeof raw !== "object") {
    return { events: [], window_started_at: new Date().toISOString() };
  }
  const candidate = raw as Partial<PendingState>;
  if (!Array.isArray(candidate.events)) {
    return { events: [], window_started_at: new Date().toISOString() };
  }
  return {
    events: candidate.events as PendingEvent[],
    window_started_at:
      typeof candidate.window_started_at === "string"
        ? candidate.window_started_at
        : new Date().toISOString(),
  };
}

async function writePending(env: Env, pending: PendingState): Promise<void> {
  await env.RELAY_KV.put(KV_PENDING, JSON.stringify(pending));
}

async function clearPending(env: Env): Promise<void> {
  await env.RELAY_KV.delete(KV_PENDING);
  await env.RELAY_KV.delete(KV_FLUSH_AT);
}

async function readFlushAt(env: Env): Promise<number | null> {
  const raw = await env.RELAY_KV.get(KV_FLUSH_AT);
  if (!raw) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

async function writeFlushAt(env: Env, flushAtMs: number): Promise<void> {
  await env.RELAY_KV.put(KV_FLUSH_AT, String(flushAtMs));
}

async function acquireFlushLock(env: Env): Promise<boolean> {
  const existing = await env.RELAY_KV.get(KV_FLUSH_LOCK);
  if (existing) {
    return false;
  }
  await env.RELAY_KV.put(KV_FLUSH_LOCK, new Date().toISOString(), { expirationTtl: 120 });
  return true;
}

async function releaseFlushLock(env: Env): Promise<void> {
  await env.RELAY_KV.delete(KV_FLUSH_LOCK);
}

async function writeLastFlush(env: Env, meta: LastFlushMeta): Promise<void> {
  await env.RELAY_KV.put(KV_LAST_FLUSH, JSON.stringify(meta));
}

async function readLastFlush(env: Env): Promise<LastFlushMeta | null> {
  const raw = await env.RELAY_KV.get(KV_LAST_FLUSH, "json");
  if (!raw || typeof raw !== "object") {
    return null;
  }
  return raw as LastFlushMeta;
}

async function enqueueEvent(env: Env, eventType: string, body: unknown): Promise<void> {
  const pending = await readPending(env);
  if (pending.events.length === 0) {
    pending.window_started_at = new Date().toISOString();
  }
  pending.events.push({
    received_at: new Date().toISOString(),
    type: eventType,
    body,
  });
  await writePending(env, pending);

  const existingFlushAt = await readFlushAt(env);
  if (existingFlushAt === null) {
    const flushAt = Date.now() + COALESCE_MS;
    await writeFlushAt(env, flushAt);
  }
}

async function forwardBatch(env: Env, pending: PendingState): Promise<LastFlushMeta> {
  const types = uniqueTypes(pending.events);
  const payload: CoalesceForwardBody = {
    coalesce: true,
    window_ms: COALESCE_MS,
    count: pending.events.length,
    types,
    events: pending.events.map((event) => event.body),
  };

  const response = await fetch(env.COS_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: env.COS_WEBHOOK_AUTHORIZATION,
    },
    body: JSON.stringify(payload),
  });

  const meta: LastFlushMeta = {
    at: new Date().toISOString(),
    count: pending.events.length,
    types,
    cos_status: response.status,
  };
  await writeLastFlush(env, meta);
  return meta;
}

async function flushPending(env: Env): Promise<LastFlushMeta | null> {
  const locked = await acquireFlushLock(env);
  if (!locked) {
    return null;
  }

  try {
    const pending = await readPending(env);
    if (pending.events.length === 0) {
      await clearPending(env);
      return null;
    }

    const meta = await forwardBatch(env, pending);
    await clearPending(env);
    return meta;
  } finally {
    await releaseFlushLock(env);
  }
}

async function scheduleFlush(env: Env, flushAtMs: number): Promise<void> {
  const delay = Math.max(0, flushAtMs - Date.now());
  await sleep(delay);

  const currentFlushAt = await readFlushAt(env);
  if (currentFlushAt === null || currentFlushAt > Date.now()) {
    return;
  }

  await flushPending(env);
}

function setupSecretFromRequest(request: Request): string | null {
  const url = new URL(request.url);
  const fromQuery = url.searchParams.get("secret");
  if (fromQuery) {
    return fromQuery;
  }
  const fromHeader = request.headers.get("x-setup-secret");
  if (fromHeader) {
    return fromHeader;
  }
  return null;
}

function requireSetupSecret(request: Request, env: Env): boolean {
  if (!env.SETUP_SECRET) {
    return false;
  }
  const provided = setupSecretFromRequest(request);
  return provided !== null && timingSafeEqual(provided, env.SETUP_SECRET);
}

function secretStatus(env: Env): Record<string, boolean> {
  return {
    COS_WEBHOOK_URL: Boolean(env.COS_WEBHOOK_URL),
    COS_WEBHOOK_AUTHORIZATION: Boolean(env.COS_WEBHOOK_AUTHORIZATION),
    SETUP_SECRET: Boolean(env.SETUP_SECRET),
    NOTION_VERIFICATION_TOKEN: Boolean(env.NOTION_VERIFICATION_TOKEN),
  };
}

async function handleHealth(): Promise<Response> {
  return jsonResponse({
    ok: true,
    service: SERVICE_NAME,
    coalesce_ms: COALESCE_MS,
  });
}

async function handleSetupRoot(request: Request, env: Env): Promise<Response> {
  if (!requireSetupSecret(request, env)) {
    return unauthorized();
  }
  const token = await readVerificationToken(env);
  const pending = await readPending(env);
  const lastFlush = await readLastFlush(env);
  const flushAt = await readFlushAt(env);
  return jsonResponse({
    ok: true,
    service: SERVICE_NAME,
    coalesce_ms: COALESCE_MS,
    secrets: secretStatus(env),
    notion_verification_token_present: Boolean(token),
    pending_count: pending.events.length,
    flush_at: flushAt ? new Date(flushAt).toISOString() : null,
    last_flush: lastFlush,
  });
}

async function handleSetupStatus(request: Request, env: Env): Promise<Response> {
  if (!requireSetupSecret(request, env)) {
    return unauthorized();
  }
  const pending = await readPending(env);
  const flushAt = await readFlushAt(env);
  const lastFlush = await readLastFlush(env);
  return jsonResponse({
    ok: true,
    pending_count: pending.events.length,
    window_started_at: pending.window_started_at,
    flush_at: flushAt ? new Date(flushAt).toISOString() : null,
    last_flush: lastFlush,
    types: uniqueTypes(pending.events),
  });
}

async function handleSetupPending(request: Request, env: Env): Promise<Response> {
  if (!requireSetupSecret(request, env)) {
    return unauthorized();
  }
  const pending = await readPending(env);
  return jsonResponse({
    ok: true,
    count: pending.events.length,
    events: pending.events,
  });
}

async function handleSetupVerify(request: Request, env: Env): Promise<Response> {
  if (!requireSetupSecret(request, env)) {
    return unauthorized();
  }

  const token = await readVerificationToken(env);
  const checks = {
    cos_webhook_url: Boolean(env.COS_WEBHOOK_URL),
    cos_webhook_authorization: Boolean(env.COS_WEBHOOK_AUTHORIZATION),
    setup_secret: Boolean(env.SETUP_SECRET),
    notion_verification_token: Boolean(token),
    kv_bound: Boolean(env.RELAY_KV),
  };

  let cosProbeStatus: number | null = null;
  let cosProbeError: string | null = null;

  if (env.COS_WEBHOOK_URL && env.COS_WEBHOOK_AUTHORIZATION) {
    try {
      const probe = await fetch(env.COS_WEBHOOK_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: env.COS_WEBHOOK_AUTHORIZATION,
        },
        body: JSON.stringify({
          coalesce: true,
          window_ms: COALESCE_MS,
          count: 0,
          types: [],
          events: [],
          probe: true,
        }),
      });
      cosProbeStatus = probe.status;
    } catch (error: unknown) {
      cosProbeError = error instanceof Error ? error.message : "unknown_error";
    }
  }

  return jsonResponse({
    ok: Object.values(checks).every(Boolean),
    checks,
    cos_probe_status: cosProbeStatus,
    cos_probe_error: cosProbeError,
  });
}

async function handleSetupFlush(request: Request, env: Env): Promise<Response> {
  if (!requireSetupSecret(request, env)) {
    return unauthorized();
  }
  const meta = await flushPending(env);
  return jsonResponse({
    ok: true,
    flushed: meta !== null,
    last_flush: meta,
  });
}

async function handleSetup(request: Request, env: Env, pathname: string): Promise<Response> {
  if (request.method !== "GET") {
    return methodNotAllowed();
  }

  if (pathname === "/setup" || pathname === "/setup/") {
    return handleSetupRoot(request, env);
  }
  if (pathname === "/setup/status") {
    return handleSetupStatus(request, env);
  }
  if (pathname === "/setup/pending") {
    return handleSetupPending(request, env);
  }
  if (pathname === "/setup/verify") {
    return handleSetupVerify(request, env);
  }
  if (pathname === "/setup/flush") {
    return handleSetupFlush(request, env);
  }

  return jsonResponse({ error: "not_found" }, 404);
}

async function handleNotionWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const rawBody = await request.text();
  let parsed: NotionWebhookBody = {};
  try {
    parsed = JSON.parse(rawBody) as NotionWebhookBody;
  } catch {
    // Notion expects 200 after accept; malformed payloads are ignored.
    return TEXT_OK;
  }

  const signature = request.headers.get("x-notion-signature");

  if (isHandshakeBody(parsed)) {
    const token = parsed.verification_token;
    if (token) {
      await storeVerificationToken(env, token);
    }
    return TEXT_OK;
  }

  const verificationToken = await readVerificationToken(env);
  if (verificationToken) {
    const trusted = await verifyNotionSignature(rawBody, signature, verificationToken);
    if (!trusted) {
      console.warn("[notion-comments-relay] signature verification failed");
      return TEXT_OK;
    }
  } else if (signature) {
    console.warn("[notion-comments-relay] signature present but no verification token configured");
    return TEXT_OK;
  }

  const eventType = typeof parsed.type === "string" ? parsed.type : "unknown";
  if (shouldDropEvent(eventType)) {
    console.log(`[notion-comments-relay] dropped ${eventType}`);
    return TEXT_OK;
  }

  await enqueueEvent(env, eventType, parsed);

  const flushAt = await readFlushAt(env);
  if (flushAt !== null) {
    ctx.waitUntil(scheduleFlush(env, flushAt));
  }

  return TEXT_OK;
}

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;

  if (pathname === "/health") {
    if (request.method !== "GET") {
      return methodNotAllowed();
    }
    return handleHealth();
  }

  if (pathname === "/setup" || pathname.startsWith("/setup/")) {
    return handleSetup(request, env, pathname);
  }

  if (pathname === "/" || pathname === "") {
    if (request.method !== "POST") {
      return methodNotAllowed();
    }
    return handleNotionWebhook(request, env, ctx);
  }

  if (request.method === "POST") {
    // Non-root POST paths acknowledge without side effects (compat with ad-hoc probes).
    return TEXT_OK;
  }

  return methodNotAllowed();
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
};
