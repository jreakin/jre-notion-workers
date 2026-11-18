import { bearerOk } from "./auth.js";
export { ClefEmailBatcher } from "./batcher-do.js";
import type { Env } from "./env.js";
import { type Admission, admitEmailShadow, completeEmailShadow, emitFailure, handleOutcome } from "./shadow.js";

const READ_CAP_BYTES = 16_384;

/** Stream the body, aborting once it exceeds `cap` bytes (content-length may be absent). */
export const TOO_LARGE = Symbol("too_large");
export const UNREADABLE = Symbol("unreadable");

export async function readCapped(request: Request, cap: number): Promise<string | typeof TOO_LARGE | typeof UNREADABLE> {
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
        return TOO_LARGE;
      }
      chunks.push(value);
    }
  } catch {
    return UNREADABLE;
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
    const body = Number.isFinite(len) && len > READ_CAP_BYTES ? TOO_LARGE : await readCapped(request, READ_CAP_BYTES);
    if (body === TOO_LARGE) {
      emitFailure("rejected", "payload_too_large", null); // never parsed
      return reply(413, { logged: false, reason: "payload_too_large" });
    }
    if (body === UNREADABLE) {
      emitFailure("rejected", "unreadable_body", null);
      return reply(400, { logged: false, reason: "unreadable_body" });
    }
    try {
      if (route === "outcome") {
        const r = await handleOutcome(env, body);
        if (r.status === 202) {
          // matched:false ⇒ no decision row for this hash (wrong message id, salt, or the post never landed).
          return reply(202, { logged: true, matched: r.entry?.error_reason !== "outcome_without_decision" });
        }
        return reply(r.status, { logged: false, reason: r.entry?.error_reason });
      }
      // Admit (writes the pending row) and complete (Clef verdict, rewrites the row) are ONE promise,
      // registered with ctx.waitUntil before anything is awaited. If the client disconnects while the
      // pending-row KV write is in flight, the runtime may cancel this handler, but not a waitUntil
      // promise, so a pending row can never be stranded without its completion (2026-11-17 burst).
      // The handler only awaits `admitted`, which settles once the admission is known.
      let admit!: (a: Admission) => void;
      let admitFailed!: (e: unknown) => void;
      const admitted = new Promise<Admission>((resolve, reject) => {
        admit = resolve;
        admitFailed = reject;
      });
      admitted.catch(() => {}); // handler may be cancelled before it awaits; never an unhandled rejection
      ctx.waitUntil(
        (async (): Promise<void> => {
          let a: Admission;
          try {
            a = await admitEmailShadow(env, body);
          } catch (e) {
            admitFailed(e);
            return;
          }
          admit(a);
          // Row (triage truth) is durably stored; the Clef verdict is added afterwards and rewrites the row.
          if (a.kind === "stored") await completeEmailShadow(env, a.item, a.entry, a.mode);
        })(),
      );
      const a = await admitted;
      if (a.kind === "excluded") return reply(200, { logged: false, reason: "excluded" });
      if (a.kind === "duplicate") return reply(202, { logged: true, duplicate: true });
      if (a.kind !== "stored") return reply(a.status, { logged: false, reason: a.entry.error_reason });
      return reply(202, { logged: true, verdict: "pending" });
    } catch {
      emitFailure("store_failed", "internal_error", null);
      return reply(500, { logged: false, reason: "internal_error" });
    }
  },
} satisfies ExportedHandler<Env>;
