import { bearerOk } from "./auth.js";
import type { Env } from "./env.js";
import { processEmailShadow, processOutcome } from "./shadow.js";

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
    if (Number.isFinite(len) && len > 16_384) {
      return LOGGED(); // oversized: dropped, never read
    }
    let body = "";
    try {
      body = await request.text();
    } catch {
      return LOGGED();
    }
    const work = route === "decision" ? processEmailShadow(env, body) : processOutcome(env, body);
    ctx.waitUntil(work.then(() => undefined).catch(() => undefined));
    return LOGGED();
  },
} satisfies ExportedHandler<Env>;
