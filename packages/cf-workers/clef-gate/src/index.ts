import { bearerOk } from "./auth.js";
import type { Env } from "./env.js";
import { admitEmailShadow, completeEmailShadow, emitFailure, handleOutcome } from "./shadow.js";

const READ_CAP_BYTES = 16_384;

/** Stream the body, aborting once it exceeds `cap` bytes (content-length may be absent). */
export async function readCapped(request: Request, cap: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

const reply = (status: number, body: Record<string, unknown>) => Response.json(body, { status });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    const route =
      pathname === "/clef/email-shadow" ? "decision" : pathname === "/clef/email-shadow/outcome" ? "outcome" : null;
    if (!route) return new Response("not found", { status: 404 });
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    if (!(await bearerOk(request.headers.get("authorization"), env.CLEF_EMAIL_SHADOW_TOKEN))) {
      return new Response("unauthorized", { status: 401 });
    }
    const len = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
    const body = Number.isFinite(len) && len > READ_CAP_BYTES ? null : await readCapped(request, READ_CAP_BYTES);
    if (body === null) {
      emitFailure("store_failed", "payload_too_large", null); // oversized/unreadable: never parsed
      return reply(413, { logged: false, reason: "payload_too_large" });
    }
    try {
      if (route === "outcome") {
        const r = await handleOutcome(env, body);
        return reply(r.status, { logged: r.status === 202, reason: r.status === 202 ? undefined : r.entry?.error_reason });
      }
      const a = await admitEmailShadow(env, body);
      if (a.kind === "excluded") return reply(200, { logged: false, reason: "excluded" });
      if (a.kind !== "stored") return reply(a.status, { logged: false, reason: a.entry.error_reason });
      // Row (triage truth) is durably stored; the Clef verdict is added afterwards and rewrites the row.
      ctx.waitUntil(completeEmailShadow(env, a.item, a.entry, a.mode));
      return reply(202, { logged: true, verdict: "pending" });
    } catch {
      emitFailure("store_failed", "internal_error", null);
      return reply(500, { logged: false, reason: "internal_error" });
    }
  },
} satisfies ExportedHandler<Env>;
