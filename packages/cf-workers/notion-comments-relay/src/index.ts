/**
 * Notion Integration webhooks → Grok Bot CoS comments ingress relay.
 * - Drops page.deleted / page.undeleted (subscription off; defense in depth).
 * - Coalesces other signed events for ~45s into one Cos wake.
 */

export interface Env {
  RELAY_KV: KVNamespace;
  COS_WEBHOOK_URL: string;
  COS_WEBHOOK_AUTHORIZATION: string;
  SETUP_SECRET: string;
  NOTION_VERIFICATION_TOKEN?: string;
}

const TOKEN_KEY = "notion_verification_token";
const LAST_POST_KEY = "last_notion_post";
const LAST_FORWARD_KEY = "last_forward";
const COALESCE_BUF_KEY = "coalesce_buffer";
const COALESCE_LOCK_KEY = "coalesce_flush_scheduled";
const COALESCE_MS = 45_000;
const COALESCE_MAX = 40;
const FORWARD_HISTORY_KEY = "forward_history";
const FORWARD_HISTORY_MAX = 10;

type CoalesceItem = {
  at: string;
  notion_type: string | null;
  body: string;
  signature: string | null;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function findVerificationToken(parsed: Record<string, unknown>): string | null {
  const direct = parsed.verification_token;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const camel = parsed.verificationToken;
  if (typeof camel === "string" && camel.length > 0) return camel;
  const data = parsed.data;
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (typeof d.verification_token === "string" && d.verification_token.length > 0) {
      return d.verification_token;
    }
    if (typeof d.verificationToken === "string" && d.verificationToken.length > 0) {
      return d.verificationToken;
    }
  }
  for (const [k, v] of Object.entries(parsed)) {
    if (
      typeof v === "string" &&
      v.startsWith("secret_") &&
      (k.toLowerCase().includes("token") || k.toLowerCase().includes("verification"))
    ) {
      return v;
    }
  }
  return null;
}

async function verifyNotionSignature(
  rawBody: string,
  signatureHeader: string | null,
  verificationToken: string,
): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expectedHex = signatureHeader.slice("sha256=".length);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(verificationToken),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(rawBody),
  );
  const computed = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (computed.length !== expectedHex.length) return false;
  let mismatch = 0;
  for (let i = 0; i < computed.length; i++) {
    mismatch |= computed.charCodeAt(i) ^ expectedHex.charCodeAt(i);
  }
  return mismatch === 0;
}

function cosAuthHeader(env: Env): string {
  return env.COS_WEBHOOK_AUTHORIZATION.startsWith("Bearer ")
    ? env.COS_WEBHOOK_AUTHORIZATION
    : `Bearer ${env.COS_WEBHOOK_AUTHORIZATION}`;
}

async function recordForward(env: Env, result: Record<string, unknown>): Promise<void> {
  try {
    await env.RELAY_KV.put(LAST_FORWARD_KEY, JSON.stringify(result));
  } catch {}
  try {
    const raw = await env.RELAY_KV.get(FORWARD_HISTORY_KEY);
    const hist: unknown[] = raw ? (JSON.parse(raw) as unknown[]) : [];
    hist.unshift(result);
    await env.RELAY_KV.put(
      FORWARD_HISTORY_KEY,
      JSON.stringify(hist.slice(0, FORWARD_HISTORY_MAX)),
    );
  } catch {}
}

async function forwardRaw(
  env: Env,
  body: string,
  signature: string | null,
  notionType: string | null,
  meta: Record<string, unknown> = {},
): Promise<number> {
  const forwardHeaders: Record<string, string> = {
    "content-type": "application/json",
    authorization: cosAuthHeader(env),
  };
  if (signature) forwardHeaders["x-notion-signature"] = signature;

  const upstream = await fetch(env.COS_WEBHOOK_URL, {
    method: "POST",
    headers: forwardHeaders,
    body,
  });
  const upstreamText = await upstream.text();
  const result = {
    at: new Date().toISOString(),
    event: "forwarded",
    status: upstream.status,
    notion_type: notionType,
    upstream_preview: upstreamText.slice(0, 200),
    ...meta,
  };
  await recordForward(env, result);
  console.log(
    JSON.stringify({
      event: result.event,
      status: result.status,
      notion_type: result.notion_type,
      coalesce: meta.coalesce ?? false,
      count: meta.count,
    }),
  );
  return upstream.status;
}

async function readBuffer(env: Env): Promise<CoalesceItem[]> {
  try {
    const raw = await env.RELAY_KV.get(COALESCE_BUF_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CoalesceItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeBuffer(env: Env, items: CoalesceItem[]): Promise<void> {
  if (items.length === 0) {
    try {
      await env.RELAY_KV.delete(COALESCE_BUF_KEY);
    } catch {}
    return;
  }
  await env.RELAY_KV.put(COALESCE_BUF_KEY, JSON.stringify(items.slice(-COALESCE_MAX)));
}

async function flushCoalesce(env: Env): Promise<void> {
  const items = await readBuffer(env);
  await writeBuffer(env, []);
  try {
    await env.RELAY_KV.delete(COALESCE_LOCK_KEY);
  } catch {}

  if (items.length === 0) {
    console.log(JSON.stringify({ event: "coalesce_flush_empty" }));
    return;
  }

  if (!env.COS_WEBHOOK_URL || !env.COS_WEBHOOK_AUTHORIZATION) {
    await recordForward(env, {
      at: new Date().toISOString(),
      event: "relay_not_configured",
      coalesce: true,
      count: items.length,
    });
    return;
  }

  if (items.length === 1) {
    const only = items[0];
    await forwardRaw(env, only.body, only.signature, only.notion_type, {
      coalesce: false,
      count: 1,
    });
    return;
  }

  const events = items.map((it) => {
    try {
      return JSON.parse(it.body);
    } catch {
      return { raw: it.body.slice(0, 500), parseOk: false, at: it.at };
    }
  });
  const batchBody = JSON.stringify({
    coalesce: true,
    window_ms: COALESCE_MS,
    count: events.length,
    types: items.map((i) => i.notion_type),
    events,
  });
  await forwardRaw(env, batchBody, null, "coalesce.batch", {
    coalesce: true,
    count: events.length,
    sigOk: null,
  });
}

async function enqueueAndSchedule(
  env: Env,
  ctx: ExecutionContext,
  item: CoalesceItem,
): Promise<void> {
  const buf = await readBuffer(env);
  buf.push(item);
  await writeBuffer(env, buf);

  const already = await env.RELAY_KV.get(COALESCE_LOCK_KEY);
  if (already) {
    console.log(
      JSON.stringify({
        event: "coalesce_buffered",
        notion_type: item.notion_type,
        buffer_size: buf.length,
        flush_already_scheduled: true,
      }),
    );
    return;
  }

  await env.RELAY_KV.put(COALESCE_LOCK_KEY, new Date().toISOString(), {
    expirationTtl: 180,
  });
  console.log(
    JSON.stringify({
      event: "coalesce_flush_scheduled",
      notion_type: item.notion_type,
      buffer_size: buf.length,
      wait_ms: COALESCE_MS,
    }),
  );

  ctx.waitUntil(
    (async () => {
      await new Promise((r) => setTimeout(r, COALESCE_MS));
      try {
        await flushCoalesce(env);
      } catch (err) {
        console.log(JSON.stringify({ event: "coalesce_flush_failed", error: String(err) }));
        try {
          await env.RELAY_KV.delete(COALESCE_LOCK_KEY);
        } catch {}
      }
    })(),
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, service: "notion-comments-relay", coalesce_ms: COALESCE_MS });
      }

      if (request.method === "GET" && url.pathname === "/setup/verification-token") {
        const key = url.searchParams.get("key") ?? "";
        if (!env.SETUP_SECRET || key !== env.SETUP_SECRET) {
          return json({ error: "unauthorized" }, 401);
        }
        const token =
          (await env.RELAY_KV.get(TOKEN_KEY)) ?? env.NOTION_VERIFICATION_TOKEN ?? null;
        if (!token) {
          return json({
            ok: false,
            message: "No verification_token stored yet. Create the Notion subscription first.",
          });
        }
        return json({ ok: true, verification_token: token });
      }

      if (request.method === "GET" && url.pathname === "/setup/last-post") {
        const key = url.searchParams.get("key") ?? "";
        if (!env.SETUP_SECRET || key !== env.SETUP_SECRET) {
          return json({ error: "unauthorized" }, 401);
        }
        const raw = await env.RELAY_KV.get(LAST_POST_KEY);
        if (!raw) return json({ ok: false, message: "No POST captured yet." });
        return json({ ok: true, last: JSON.parse(raw) });
      }

      if (request.method === "GET" && url.pathname === "/setup/last-forward") {
        const key = url.searchParams.get("key") ?? "";
        if (!env.SETUP_SECRET || key !== env.SETUP_SECRET) {
          return json({ error: "unauthorized" }, 401);
        }
        const raw = await env.RELAY_KV.get(LAST_FORWARD_KEY);
        if (!raw) return json({ ok: false, message: "No forward attempt recorded yet." });
        return json({ ok: true, last: JSON.parse(raw) });
      }

      if (request.method === "GET" && url.pathname === "/setup/forward-history") {
        const key = url.searchParams.get("key") ?? "";
        if (!env.SETUP_SECRET || key !== env.SETUP_SECRET) {
          return json({ error: "unauthorized" }, 401);
        }
        const raw = await env.RELAY_KV.get(FORWARD_HISTORY_KEY);
        return json({ ok: true, history: raw ? JSON.parse(raw) : [] });
      }

      if (request.method === "GET" && url.pathname === "/setup/last-unsigned") {
        const key = url.searchParams.get("key") ?? "";
        if (!env.SETUP_SECRET || key !== env.SETUP_SECRET) {
          return json({ error: "unauthorized" }, 401);
        }
        const raw = await env.RELAY_KV.get(LAST_POST_KEY);
        if (!raw) return json({ ok: false, message: "No POST captured yet." });
        return json({ ok: true, last: JSON.parse(raw) });
      }

      if (request.method === "POST" && url.pathname === "/setup/flush-coalesce") {
        const key = url.searchParams.get("key") ?? "";
        if (!env.SETUP_SECRET || key !== env.SETUP_SECRET) {
          return json({ error: "unauthorized" }, 401);
        }
        await flushCoalesce(env);
        return json({ ok: true, flushed: true });
      }

      if (request.method !== "POST") {
        return json({ error: "method_not_allowed" }, 405);
      }

      const rawBody = await request.text();
      let parsed: Record<string, unknown> = {};
      let parseOk = true;
      try {
        parsed = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
      } catch {
        parseOk = false;
      }

      const signature = request.headers.get("X-Notion-Signature");
      const token = parseOk ? findVerificationToken(parsed) : null;
      const notionType =
        typeof parsed.type === "string"
          ? parsed.type
          : typeof parsed.event_name === "string"
            ? parsed.event_name
            : null;

      const debug = {
        at: new Date().toISOString(),
        parseOk,
        len: rawBody.length,
        keys: parseOk ? Object.keys(parsed) : [],
        hasVerificationToken: Boolean(token),
        hasSignature: Boolean(signature),
        contentType: request.headers.get("content-type"),
        userAgent: request.headers.get("user-agent"),
        bodyPreview: rawBody.slice(0, 500),
        notion_type: notionType,
      };
      try {
        await env.RELAY_KV.put(LAST_POST_KEY, JSON.stringify(debug));
      } catch (err) {
        console.log(JSON.stringify({ event: "debug_kv_put_failed", error: String(err) }));
      }

      const ua = (request.headers.get("user-agent") || "").toLowerCase();
      const fromNotion = ua.includes("notion") || Boolean(signature);
      if (token && fromNotion) {
        try {
          await env.RELAY_KV.put(TOKEN_KEY, token);
          console.log(
            JSON.stringify({
              event: "notion_handshake_stored",
              token_len: token.length,
              token_suffix: token.slice(-8),
              hasSignature: Boolean(signature),
            }),
          );
        } catch (err) {
          console.log(JSON.stringify({ event: "handshake_kv_put_failed", error: String(err) }));
        }
        return new Response("ok", { status: 200 });
      }
      if (token && !fromNotion) {
        console.log(JSON.stringify({ event: "ignored_non_notion_token_post", ua }));
        return new Response("ok", { status: 200 });
      }

      if (!signature) {
        console.log(
          JSON.stringify({
            event: "unsigned_post_ack",
            keys: debug.keys,
            len: debug.len,
            parseOk,
          }),
        );
        return new Response("ok", { status: 200 });
      }

      const storedToken =
        (await env.RELAY_KV.get(TOKEN_KEY)) ?? env.NOTION_VERIFICATION_TOKEN ?? "";
      let sigOk: boolean | null = null;
      if (storedToken) {
        sigOk = await verifyNotionSignature(rawBody, signature, storedToken);
        if (!sigOk) {
          const fail = {
            at: new Date().toISOString(),
            event: "signature_fail",
            notion_type: notionType,
            hasToken: true,
            token_suffix: storedToken.slice(-8),
          };
          await recordForward(env, fail);
          console.log(JSON.stringify(fail));
          return new Response("ok", { status: 200 });
        }
      } else {
        const fail = {
          at: new Date().toISOString(),
          event: "no_verification_token",
          notion_type: notionType,
        };
        await recordForward(env, fail);
        console.log(JSON.stringify(fail));
      }

      // Defense in depth: subscription should already omit these.
      if (notionType === "page.deleted" || notionType === "page.undeleted") {
        const dropped = {
          at: new Date().toISOString(),
          event: "dropped_deleted_event",
          notion_type: notionType,
          sigOk,
        };
        await recordForward(env, dropped);
        console.log(JSON.stringify(dropped));
        return new Response("ok", { status: 200 });
      }

      if (!env.COS_WEBHOOK_URL || !env.COS_WEBHOOK_AUTHORIZATION) {
        const fail = { at: new Date().toISOString(), event: "relay_not_configured" };
        await recordForward(env, fail);
        console.log(JSON.stringify(fail));
        return new Response("ok", { status: 200 });
      }

      await enqueueAndSchedule(env, ctx, {
        at: new Date().toISOString(),
        notion_type: notionType,
        body: rawBody,
        signature,
      });
      return new Response("ok", { status: 200 });
    } catch (err) {
      console.log(JSON.stringify({ event: "unhandled", error: String(err) }));
      return new Response("ok", { status: 200 });
    }
  },
};
