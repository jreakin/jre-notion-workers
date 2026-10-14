import { afterEach, describe, expect, test } from "bun:test";
import worker from "../src/index.js";
import { gradeJoined, OUTCOME_PREFIX, processEmailShadow, processOutcome, RING_PREFIX, type EmailShadowLogEntry } from "../src/shadow.js";
import { resolveOverride } from "../src/overrides.js";
import { parseEmailShadowBody } from "../src/payload.js";
import { answers, captureLogs, HASH_FLASH, HASH_NOFLASH, makeEnv, payload, SECRET_SNIPPET, SECRET_SUBJECT } from "./helpers.js";

let cap: ReturnType<typeof captureLogs> | null = null;
afterEach(() => { cap?.restore(); cap = null; });

function noSecretsIn(lines: string[]) {
  const all = lines.join("\n");
  for (const frag of ["Invoice", "jane.doe", "555-0199", "12345678", "wire to", "987654321", "pay.example.com", "Needs review", SECRET_SUBJECT, SECRET_SNIPPET]) {
    expect(all).not.toContain(frag);
  }
}

describe("flow", () => {
  test("clef path: one full call with 6 questions via gateway; log has flags and no subject/snippet", async () => {
    cap = captureLogs();
    const { env, calls, kv } = makeEnv(answers());
    const e = await processEmailShadow(env, JSON.stringify(payload()));
    expect(calls.length).toBe(1);
    expect(calls[0].slug).toBe("@cf/cloudflare/clef");
    expect(Object.keys(calls[0].input).sort()).toEqual(["model", "questions", "state"]);
    expect(Object.keys(calls[0].input.questions as object).length).toBe(6);
    expect(calls[0].opts.gateway).toEqual({ id: "clef-shadow-gate", collectLog: false, skipCache: true });
    expect((calls[0].opts.gateway as Record<string, unknown>).collectLog).toBe(false);
    expect("metadata" in (calls[0].opts.gateway as object)).toBe(false);
    expect(String(calls[0].input.state)).not.toContain("jane.doe");
    expect(e?.shadow_label).toBe("would_skip");
    expect(e?.false_skip).toBe(true);
    expect(e?.clef_called).toBe(true);
    const line = JSON.parse(cap.lines[0]);
    expect(line.stream).toBe("clef_email_shadow");
    expect("subject" in line || "snippet" in line).toBe(false);
    noSecretsIn(cap.lines);
    noSecretsIn([...kv.data.values()]);
    expect(kv.data.has(`${RING_PREFIX}${HASH_NOFLASH}`)).toBe(true);
  });
  test("flash sample makes a second call and records flash_agree", async () => {
    cap = captureLogs();
    const { env, calls } = makeEnv(answers());
    const e = await processEmailShadow(env, JSON.stringify(payload({ msg_id_hash: HASH_FLASH })));
    expect(calls.map((c) => c.slug)).toEqual(["@cf/cloudflare/clef", "@cf/cloudflare/clef-flash"]);
    expect(e?.flash_sample).toBe(true);
    expect(e?.flash_agree).toBe(true);
  });
  test("overrides: no Clef call, clef_called false, escalate", async () => {
    cap = captureLogs();
    for (const p of [payload({ override: "money" }), payload({ from_domain: "mail.quorumreport.com" }), payload({ from_kind: "known_person" }), payload({ from_domain: "tesla.com" })]) {
      const { env, calls } = makeEnv();
      const e = await processEmailShadow(env, JSON.stringify(p));
      expect(calls.length).toBe(0);
      expect(e?.clef_called).toBe(false);
      expect(e?.override).not.toBeNull();
      expect(e?.shadow_label).toBe("escalate");
    }
    const r = parseEmailShadowBody(JSON.stringify(payload({ from_domain: "notrove.com" })));
    expect(r.ok && resolveOverride(r.item)).toBeNull();
    noSecretsIn(cap.lines);
  });
  test("daily cap: per-gate key, refuses at cap, no AI call", async () => {
    cap = captureLogs();
    const day = new Date().toISOString().slice(0, 10);
    const { env, calls, kv } = makeEnv(answers(), { [`clef:calls:clef_email:${day}`]: "1000" });
    const e = await processEmailShadow(env, JSON.stringify(payload()));
    expect(calls.length).toBe(0);
    expect(e?.error_reason).toBe("clef_daily_cap");
    expect(e?.clef_called).toBe(false);
    expect(kv.data.has(`clef:calls:${day}`)).toBe(false);
    const ok = makeEnv(answers());
    await processEmailShadow(ok.env, JSON.stringify(payload()));
    expect(ok.kv.data.get(`clef:calls:clef_email:${day}`)).toBe("1");
  });
  test("kill switch: global off and gate off", async () => {
    cap = captureLogs();
    for (const kvInit of [{ "clef:mode:global": "off" }, { "clef:mode:clef_email": "off" }] as Record<string, string>[]) {
      const { env, calls } = makeEnv(answers(), kvInit);
      const e = await processEmailShadow(env, JSON.stringify(payload()));
      expect(calls.length).toBe(0);
      expect(e?.mode).toBe("off");
    }
  });
  test("unknown mailbox (e.g. grokbot) is rejected by validation, never sent to Clef", async () => {
    cap = captureLogs();
    const { env, calls } = makeEnv();
    const e = await processEmailShadow(env, JSON.stringify(payload({ mailbox: "grokbot" })));
    expect(e?.event).toBe("rejected");
    expect(e?.error_reason).toBe("invalid_mailbox");
    expect(calls.length).toBe(0);
  });
  test("gateway id unset → no model call, clef_gateway_unset", async () => {
    cap = captureLogs();
    const { env, calls } = makeEnv(answers());
    env.AI_GATEWAY_ID = " ";
    const e = await processEmailShadow(env, JSON.stringify(payload()));
    expect(calls.length).toBe(0);
    expect(e?.error_reason).toBe("clef_gateway_unset");
    expect(e?.shadow_label).toBe("escalate");
  });
  test("AI error / bad output → escalate with reason", async () => {
    cap = captureLogs();
    const { env } = makeEnv({ answers: {} });
    const e = await processEmailShadow(env, JSON.stringify(payload()));
    expect(e?.error_reason).toBe("clef_bad_output");
    expect(e?.shadow_label).toBe("escalate");
  });
  test("jre@mail.grokbot.com excluded entirely: no AI, no stored row, counter + masked drop log", async () => {
    cap = captureLogs();
    for (const p of [payload({ override: "grokbot_inbox" }), payload({ existing_labels: ["jre@mail.grokbot.com"] })]) {
      const { env, calls, kv } = makeEnv();
      const e = await processEmailShadow(env, JSON.stringify(p));
      expect(e).toBeNull();
      expect(calls.length).toBe(0);
      expect([...kv.data.keys()].some((k) => k.startsWith("clef_email:excluded:"))).toBe(true);
      expect([...kv.data.keys()].some((k) => k.startsWith(RING_PREFIX))).toBe(false);
    }
    for (const p of [
      payload({ existing_labels: ["JRE+foo@Mail.GrokBot.com"] }),
      payload({ existing_labels: ["jre+x.y@mail.grokbot.com"] }),
      payload({ from_domain: "mail.grokbot.com" }),
      payload({ existing_labels: ["jre%40mail.grokbot.com"] }),
      payload({ existing_labels: ["jre%2Bx%40mail.grokbot.com"] }),
      payload({ from_domain: "MAIL.GROKBOT.COM" }),
      payload({ from_domain: "eu.mail.grokbot.com" }),
    ]) {
      const { env, calls } = makeEnv();
      expect(await processEmailShadow(env, JSON.stringify(p))).toBeNull();
      expect(calls.length).toBe(0);
    }
    for (const p of [
      payload({ existing_labels: ["jre@mail.grokbot.com.attacker"] }),
      payload({ existing_labels: ["jre@mail.grokbot.community"] }),
      payload({ existing_labels: ["notjre@mail.grokbot.com"] }),
      payload({ existing_labels: ["jre@notmail.grokbot.com"] }),
      payload({ existing_labels: ["jre@evilmail.grokbot.com.attacker"] }),
      payload({ from_domain: "notmail.grokbot.com" }),
      payload({ from_domain: "evilmail.grokbot.com.attacker" }),
      payload({ subject: "fwd to jre@mail.grokbot.com", snippet: "cc JRE+x@mail.grokbot.com" }),
    ]) {
      const { env, calls } = makeEnv(answers());
      expect(await processEmailShadow(env, JSON.stringify(p))).not.toBeNull();
      expect(calls.length).toBe(1);
    }
    const notExcluded = makeEnv();
    expect(await processEmailShadow(notExcluded.env, JSON.stringify(payload({ from_domain: "grokbot.com.evil.io" })))).not.toBeNull();
    cap.lines.length = 0;
    const escaped = JSON.stringify(payload()).replace('"run-1"', '"jre\\u0040mail.grokbot.com"');
    const { env, calls } = makeEnv();
    expect(await processEmailShadow(env, escaped)).toBeNull();
    expect(calls.length).toBe(0);
    expect(cap.lines.length).toBe(1);
    const drop = JSON.parse(cap.lines[0]);
    expect(drop.event).toBe("excluded");
    expect(drop.error_reason).toBe("excluded_grokbot");
    expect(drop.msg_id_hash).toBeNull();
    expect(cap.lines[0]).not.toContain("grokbot.com");
    noSecretsIn(cap.lines);
  });
  test("outcome: TrainSpam rescue turns a would_skip into a false skip", async () => {
    cap = captureLogs();
    const { env } = makeEnv(answers());
    await processEmailShadow(env, JSON.stringify(payload({ triage: { disposition: "spam", lane: "none", labels_applied: [], escalated: false } })));
    const o = await processOutcome(env, JSON.stringify({ msg_id_hash: HASH_NOFLASH, disposition: "spam", source: "trainspam_rescue" }));
    expect(o?.event).toBe("outcome");
    expect(o?.false_skip).toBe(true);
    expect(o?.shadow_label).toBe("would_skip");
    const o2 = await processOutcome(env, JSON.stringify({ msg_id_hash: "d".repeat(64), disposition: "escalate_john", subject: "leak me" }));
    expect(o2?.error_reason).toBe("outcome_without_decision");
    expect(o2?.mode).toBe("n/a");
    expect(cap.lines.join("\n")).not.toContain("leak me");
    noSecretsIn(cap.lines);
  });
});

describe("http", () => {
  const ctx = () => {
    const p: Promise<unknown>[] = [];
    return { p, c: { waitUntil: (x: Promise<unknown>) => p.push(x), passThroughOnException() {} } as unknown as ExecutionContext };
  };
  const req = (path: string, auth?: string, method = "POST", body = JSON.stringify(payload())) =>
    new Request(`https://w.example${path}`, { method, headers: auth ? { authorization: auth } : {}, body: method === "POST" ? body : undefined });

  test("auth: missing/wrong/unset secret → 401, no AI", async () => {
    cap = captureLogs();
    const { env, calls } = makeEnv();
    for (const a of [undefined, "Bearer nope", "tok-123", "Basic tok-123", "Bearer tok-1234", "Bearer  "]) {
      const { c } = ctx();
      expect((await worker.fetch(req("/clef/email-shadow", a), env, c)).status).toBe(401);
    }
    const unset = makeEnv();
    unset.env.CLEF_EMAIL_SHADOW_TOKEN = "" as string;
    expect((await worker.fetch(req("/clef/email-shadow", "Bearer "), unset.env, ctx().c)).status).toBe(401);
    expect(calls.length).toBe(0);
  });
  test("chunked body over the read cap → 413, never processed", async () => {
    cap = captureLogs();
    const { env, calls } = makeEnv();
    const big = new TextEncoder().encode("x".repeat(20_000));
    const stream = new ReadableStream({ start(c) { c.enqueue(big); c.close(); } });
    const k = ctx();
    const r = await worker.fetch(new Request("https://w.example/clef/email-shadow", { method: "POST", headers: { authorization: "Bearer tok-123" }, body: stream, duplex: "half" } as RequestInit), env, k.c);
    expect(r.status).toBe(413);
    expect(k.p.length).toBe(0);
    expect(calls.length).toBe(0);
  });
  test("small chunked body with no content-length is read and processed", async () => {
    cap = captureLogs();
    const { env, calls } = makeEnv();
    const bytes = new TextEncoder().encode(JSON.stringify(payload()));
    const stream = new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 50)); c.enqueue(bytes.slice(50)); c.close(); } });
    const r0 = new Request("https://w.example/clef/email-shadow", { method: "POST", headers: { authorization: "Bearer tok-123" }, body: stream, duplex: "half" } as RequestInit);
    expect(r0.headers.get("content-length")).toBeNull();
    const k = ctx();
    expect((await worker.fetch(r0, env, k.c)).status).toBe(202);
    await Promise.all(k.p);
    expect(calls.length).toBe(1);
  });
  test("authorized → 202 only once stored; garbage → 400; other paths 404/405", async () => {
    cap = captureLogs();
    const { env, calls } = makeEnv();
    const k = ctx();
    const r = await worker.fetch(req("/clef/email-shadow", "Bearer tok-123"), env, k.c);
    expect(r.status).toBe(202);
    expect((await r.json()) as unknown).toEqual({ logged: true, verdict: "pending" });
    await Promise.all(k.p);
    expect(calls.length).toBe(1);
    expect((await worker.fetch(req("/clef/email-shadow", "Bearer tok-123", "POST", "{{"), env, ctx().c)).status).toBe(400);
    expect((await worker.fetch(req("/clef/email-shadow/outcome", "Bearer tok-123", "POST", "{}"), env, ctx().c)).status).toBe(400);
    expect((await worker.fetch(req("/clef/email-shadow/", "Bearer tok-123"), env, ctx().c)).status).toBe(404);
    expect((await worker.fetch(req("/clef/email-shadow", "Bearer tok-123", "GET"), env, ctx().c)).status).toBe(405);
  });

  test("202 means the row is in KV before the response (pending verdict), then Clef rewrites it", async () => {
    cap = captureLogs();
    const { env, kv } = makeEnv();
    const k = ctx();
    const r = await worker.fetch(req("/clef/email-shadow", "Bearer tok-123"), env, k.c);
    expect(r.status).toBe(202);
    const pending = JSON.parse(kv.data.get(`${RING_PREFIX}${HASH_NOFLASH}`) ?? "null");
    expect(pending.event).toBe("decision");
    expect(pending.triage_disposition).toBe("escalate_john");
    expect(pending.shadow_label).toBeNull();
    expect(pending.error_reason).toBe("clef_pending");
    await Promise.all(k.p);
    const done = JSON.parse(kv.data.get(`${RING_PREFIX}${HASH_NOFLASH}`) ?? "null");
    expect(done.shadow_label).toBe("would_skip");
    expect(done.error_reason).toBeNull();
    noSecretsIn([...kv.data.values()]);
  });
  test("invalid payload → 400 with masked rejected log, nothing stored", async () => {
    cap = captureLogs();
    const { env, kv, calls } = makeEnv();
    const r = await worker.fetch(req("/clef/email-shadow", "Bearer tok-123", "POST", JSON.stringify(payload({ v: 2 }))), env, ctx().c);
    expect(r.status).toBe(400);
    expect([...kv.data.keys()].some((x) => x.startsWith(RING_PREFIX))).toBe(false);
    expect(calls.length).toBe(0);
    expect(JSON.parse(cap.lines[0]).event).toBe("rejected");
    noSecretsIn(cap.lines);
  });
  test("oversized by content-length → 413 and a masked log line", async () => {
    cap = captureLogs();
    const { env } = makeEnv();
    const r = await worker.fetch(new Request("https://w.example/clef/email-shadow", { method: "POST", headers: { authorization: "Bearer tok-123", "content-length": "99999" }, body: "{}" }), env, ctx().c);
    expect(r.status).toBe(413);
    expect(JSON.parse(cap.lines[0]).error_reason).toBe("payload_too_large");
  });
  test("grokbot exclusion → 200 logged:false (not 202)", async () => {
    cap = captureLogs();
    const { env } = makeEnv();
    const r = await worker.fetch(req("/clef/email-shadow", "Bearer tok-123", "POST", JSON.stringify(payload({ override: "grokbot_inbox" }))), env, ctx().c);
    expect(r.status).toBe(200);
    expect((await r.json()) as unknown).toEqual({ logged: false, reason: "excluded" });
  });
  test("KV write failure → 500 + masked store_failed log, no background work", async () => {
    cap = captureLogs();
    const { env, calls } = makeEnv();
    (env.CLEF_KV as unknown as { put: () => Promise<void> }).put = async () => { throw new Error("KV PUT failed: 429"); };
    const k = ctx();
    const r = await worker.fetch(req("/clef/email-shadow", "Bearer tok-123"), env, k.c);
    expect(r.status).toBe(500);
    expect(k.p.length).toBe(0);
    expect(calls.length).toBe(0);
    const line = JSON.parse(cap.lines.at(-1) ?? "{}");
    expect(line.event).toBe("store_failed");
    expect(line.error_reason).toBe("kv_put_failed");
    noSecretsIn(cap.lines);
    const o = await worker.fetch(req("/clef/email-shadow/outcome", "Bearer tok-123", "POST", JSON.stringify({ msg_id_hash: HASH_NOFLASH, disposition: "spam" })), env, ctx().c);
    expect(o.status).toBe(500);
  });
  test("outcome stored inline → 202; oversized outcome → 413", async () => {
    cap = captureLogs();
    const { env, kv } = makeEnv();
    const o = await worker.fetch(req("/clef/email-shadow/outcome", "Bearer tok-123", "POST", JSON.stringify({ msg_id_hash: HASH_NOFLASH, disposition: "spam" })), env, ctx().c);
    expect(o.status).toBe(202);
    expect(JSON.parse(kv.data.get(`${OUTCOME_PREFIX}${HASH_NOFLASH}`) ?? "{}").event).toBe("outcome");
    expect(kv.data.has(`${RING_PREFIX}${HASH_NOFLASH}`)).toBe(false);
    const big = JSON.stringify({ msg_id_hash: HASH_NOFLASH, disposition: "spam", pad: "x".repeat(2000) });
    expect((await worker.fetch(req("/clef/email-shadow/outcome", "Bearer tok-123", "POST", big), env, ctx().c)).status).toBe(413);
  });
  test("outcome landing inside the race window (between Clef start and verdict put) is never clobbered", async () => {
    cap = captureLogs();
    const { env, kv } = makeEnv();
    const ai = env.AI.run;
    // Outcome is written while the Clef call is in flight, i.e. after admit and before the verdict put.
    env.AI.run = (async (...a: unknown[]) => {
      await worker.fetch(req("/clef/email-shadow/outcome", "Bearer tok-123", "POST", JSON.stringify({ msg_id_hash: HASH_NOFLASH, disposition: "spam", escalated: false })), env, ctx().c);
      return (ai as (...x: unknown[]) => Promise<unknown>)(...a);
    }) as unknown as Ai["run"];
    const k = ctx();
    expect((await worker.fetch(req("/clef/email-shadow", "Bearer tok-123"), env, k.c)).status).toBe(202);
    await Promise.all(k.p);
    const decision = JSON.parse(kv.data.get(`${RING_PREFIX}${HASH_NOFLASH}`) ?? "{}") as EmailShadowLogEntry;
    const outcome = JSON.parse(kv.data.get(`${OUTCOME_PREFIX}${HASH_NOFLASH}`) ?? "{}") as EmailShadowLogEntry;
    expect(decision.event).toBe("decision");
    expect(decision.shadow_label).toBe("would_skip");
    expect(outcome.event).toBe("outcome");
    expect(outcome.triage_disposition).toBe("spam");
    const g = gradeJoined(decision, outcome);
    expect(g?.triage_disposition).toBe("spam");
    expect(g?.agree).toBe(true);
    expect(g?.false_skip).toBe(false);
    expect(gradeJoined({ ...decision, shadow_label: null, error_reason: "clef_pending" }, outcome)).toBeNull();
  });
  test("resend after a completed 202 is idempotent: 202 duplicate, no rewrite, no Clef call", async () => {
    cap = captureLogs();
    const { env, kv, calls } = makeEnv();
    const k = ctx();
    expect((await worker.fetch(req("/clef/email-shadow", "Bearer tok-123"), env, k.c)).status).toBe(202);
    await Promise.all(k.p);
    const before = kv.data.get(`${RING_PREFIX}${HASH_NOFLASH}`);
    const k2 = ctx();
    const r = await worker.fetch(req("/clef/email-shadow", "Bearer tok-123"), env, k2.c);
    expect(r.status).toBe(202);
    expect((await r.json()) as unknown).toEqual({ logged: true, duplicate: true });
    expect(k2.p.length).toBe(0);
    expect(calls.length).toBe(1);
    expect(kv.data.get(`${RING_PREFIX}${HASH_NOFLASH}`)).toBe(before);
  });
  test("500 on KV failure, then a successful retry stores and completes", async () => {
    cap = captureLogs();
    const { env, kv, calls } = makeEnv();
    const put = kv.put.bind(kv);
    let fail = true;
    (env.CLEF_KV as unknown as { put: typeof put }).put = async (key: string, v: string) => {
      if (fail) throw new Error("KV PUT failed: 429");
      return put(key, v);
    };
    expect((await worker.fetch(req("/clef/email-shadow", "Bearer tok-123"), env, ctx().c)).status).toBe(500);
    fail = false;
    const k = ctx();
    expect((await worker.fetch(req("/clef/email-shadow", "Bearer tok-123"), env, k.c)).status).toBe(202);
    await Promise.all(k.p);
    expect(calls.length).toBe(1);
    expect(JSON.parse(kv.data.get(`${RING_PREFIX}${HASH_NOFLASH}`) ?? "{}").shadow_label).toBe("would_skip");
  });
  test("clef_completion_failed: background crash logs masked line, row stays pending, resend re-admits", async () => {
    cap = captureLogs();
    const { env, kv } = makeEnv();
    const realAi = env.AI;
    // Unexpected throw inside the background step only (admit never touches env.AI).
    Object.defineProperty(env, "AI", { configurable: true, get() { throw new Error("binding gone"); } });
    const k = ctx();
    expect((await worker.fetch(req("/clef/email-shadow", "Bearer tok-123"), env, k.c)).status).toBe(202);
    await Promise.all(k.p);
    const row = JSON.parse(kv.data.get(`${RING_PREFIX}${HASH_NOFLASH}`) ?? "{}");
    expect(row.error_reason).toBe("clef_pending");
    const fail = cap.lines.map((l) => JSON.parse(l)).find((l) => l.error_reason === "clef_completion_failed");
    expect(fail?.event).toBe("store_failed");
    expect(fail?.msg_id_hash).toBe(HASH_NOFLASH);
    noSecretsIn(cap.lines);
    Object.defineProperty(env, "AI", { configurable: true, writable: true, value: realAi });
    const k2 = ctx();
    const r = await worker.fetch(req("/clef/email-shadow", "Bearer tok-123"), env, k2.c);
    expect((await r.json()) as unknown).toEqual({ logged: true, verdict: "pending" });
    await Promise.all(k2.p);
    expect(JSON.parse(kv.data.get(`${RING_PREFIX}${HASH_NOFLASH}`) ?? "{}").shadow_label).toBe("would_skip");
  });
  test("413 logs rejected/payload_too_large (not store_failed); unreadable body → 400", async () => {
    cap = captureLogs();
    const { env } = makeEnv();
    const r = await worker.fetch(new Request("https://w.example/clef/email-shadow", { method: "POST", headers: { authorization: "Bearer tok-123", "content-length": "99999" }, body: "{}" }), env, ctx().c);
    expect(r.status).toBe(413);
    const l = JSON.parse(cap.lines[0]);
    expect(l.event).toBe("rejected");
    expect(l.error_reason).toBe("payload_too_large");
    const broken = new ReadableStream({ pull() { throw new Error("socket reset"); } });
    const r2 = await worker.fetch(new Request("https://w.example/clef/email-shadow", { method: "POST", headers: { authorization: "Bearer tok-123" }, body: broken, duplex: "half" } as RequestInit), env, ctx().c);
    expect(r2.status).toBe(400);
    expect((await r2.json()) as unknown).toEqual({ logged: false, reason: "unreadable_body" });
  });
  test("outcome KV failure → 500 with reason kv_put_failed", async () => {
    cap = captureLogs();
    const { env } = makeEnv();
    (env.CLEF_KV as unknown as { put: () => Promise<void> }).put = async () => { throw new Error("x"); };
    const o = await worker.fetch(req("/clef/email-shadow/outcome", "Bearer tok-123", "POST", JSON.stringify({ msg_id_hash: HASH_NOFLASH, disposition: "spam" })), env, ctx().c);
    expect(o.status).toBe(500);
    expect((await o.json()) as unknown).toEqual({ logged: false, reason: "kv_put_failed" });
  });
});
