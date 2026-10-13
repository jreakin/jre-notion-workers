import { bearerOk } from "./auth.js";
import type { Env } from "./env.js";
import { processEmailShadow, processOutcome } from "./shadow.js";

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

const LOGGED = () => Response.json({ logged: true }, { status: 202 });

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
    if (Number.isFinite(len) && len > READ_CAP_BYTES) {
      return LOGGED(); // oversized: dropped, never read
    }
    const body = await readCapped(request, READ_CAP_BYTES);
    if (body === null) {
      return LOGGED(); // oversized (e.g. chunked) or unreadable: dropped
    }
    const work = route === "decision" ? processEmailShadow(env, body) : processOutcome(env, body);
    ctx.waitUntil(work.then(() => undefined).catch(() => undefined));
    return LOGGED();
  },
} satisfies ExportedHandler<Env>;
