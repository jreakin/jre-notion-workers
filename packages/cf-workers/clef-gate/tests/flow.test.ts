import { afterEach, describe, expect, test } from "bun:test";
import worker from "../src/index.js";
import { processEmailShadow, processOutcome, RING_PREFIX } from "../src/shadow.js";
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
  test("AI error / bad output → escalate with reason", async () => {
    cap = captureLogs();
    const { env } = makeEnv({ answers: {} });
    const e = await processEmailShadow(env, JSON.stringify(payload()));
    expect(e?.error_reason).toBe("clef_bad_output");
    expect(e?.shadow_label).toBe("escalate");
  });
  test("jre@mail.grokbot.com excluded entirely: no AI, no log row, counter only", async () => {
    cap = captureLogs();
    for (const p of [payload({ override: "grokbot_inbox" }), payload({ mailbox: "grokbot" }), payload({ existing_labels: ["jre@mail.grokbot.com"] })]) {
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
    const notExcluded = makeEnv();
    expect(await processEmailShadow(notExcluded.env, JSON.stringify(payload({ from_domain: "grokbot.com.evil.io" })))).not.toBeNull();
    cap.lines.length = 0;
    const escaped = JSON.stringify(payload()).replace('"run-1"', '"jre\\u0040mail.grokbot.com"');
    const { env, calls } = makeEnv();
    expect(await processEmailShadow(env, escaped)).toBeNull();
    expect(calls.length).toBe(0);
    expect(cap.lines.length).toBe(0);
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
  test("chunked body over the read cap is dropped without processing", async () => {
    cap = captureLogs();
    const { env, calls } = makeEnv();
    const big = new TextEncoder().encode("x".repeat(20_000));
    const stream = new ReadableStream({ start(c) { c.enqueue(big); c.close(); } });
    const k = ctx();
    const r = await worker.fetch(new Request("https://w.example/clef/email-shadow", { method: "POST", headers: { authorization: "Bearer tok-123" }, body: stream, duplex: "half" } as RequestInit), env, k.c);
    expect(r.status).toBe(202);
    expect(k.p.length).toBe(0);
    expect(calls.length).toBe(0);
  });
  test("authorized → 202 {logged:true}, even for garbage; other paths 404/405", async () => {
    cap = captureLogs();
    const { env, calls } = makeEnv();
    const k = ctx();
    const r = await worker.fetch(req("/clef/email-shadow", "Bearer tok-123"), env, k.c);
    expect(r.status).toBe(202);
    expect((await r.json()) as unknown).toEqual({ logged: true });
    await Promise.all(k.p);
    expect(calls.length).toBe(1);
    expect((await worker.fetch(req("/clef/email-shadow", "Bearer tok-123", "POST", "{{"), env, ctx().c)).status).toBe(202);
    expect((await worker.fetch(req("/clef/email-shadow/outcome", "Bearer tok-123", "POST", "{}"), env, ctx().c)).status).toBe(202);
    expect((await worker.fetch(req("/clef/email-shadow/", "Bearer tok-123"), env, ctx().c)).status).toBe(404);
    expect((await worker.fetch(req("/clef/email-shadow", "Bearer tok-123", "GET"), env, ctx().c)).status).toBe(405);
  });
});
