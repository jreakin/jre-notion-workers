import type { Env } from "../src/env.js";

export function memKv(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  return {
    data,
    async get(k: string) { return data.get(k) ?? null; },
    async put(k: string, v: string) { data.set(k, v); },
  };
}

export const HASH_FLASH = "a".repeat(56) + "0000000a"; // 10 % 10 = 0
export const HASH_NOFLASH = "b".repeat(56) + "00000001";

export const SECRET_SUBJECT = "Invoice for jane.doe@example.com call 512-555-0199 acct 12345678";
export const SECRET_SNIPPET = "Hi John, wire to account 987654321 by Friday — see https://pay.example.com/x?id=42";

export function payload(over: Record<string, unknown> = {}) {
  return {
    v: 1, mailbox: "personal", msg_id_hash: HASH_NOFLASH, thread_id_hash: "c".repeat(64),
    received_at: "2026-10-13T06:00:00Z", run_id: "run-1", from_domain: "example.com", from_kind: "unknown",
    to_john_direct: true, cc_count: 0, list_unsubscribe: false, has_attachment: false, gmail_category: "primary",
    existing_labels: ["Needs review"], subject: SECRET_SUBJECT, snippet: SECRET_SNIPPET, override: null,
    triage: { disposition: "escalate_john", lane: "none", labels_applied: [], escalated: true },
    ...over,
  };
}

export function answers(p: Partial<Record<string, number | string>> = {}) {
  return {
    answers: {
      q_person: { type: "noul", noul: p.person ?? 0.01 },
      q_money_sec: { type: "noul", noul: p.money ?? 0.01 },
      q_lane: { type: "choice", choice: p.lane ?? "none" },
      q_bulk: { type: "noul", noul: p.bulk ?? 0.95 },
      q_calendar: { type: "noul", noul: p.cal ?? 0.01 },
      q_urgency: { type: "score", score: 0.4 },
    },
  };
}

export function makeEnv(aiResult: unknown = answers(), kvInit: Record<string, string> = {}) {
  const calls: { slug: string; input: Record<string, unknown>; opts: Record<string, unknown> }[] = [];
  const kv = memKv(kvInit);
  const env = {
    CLEF_KV: kv as unknown as KVNamespace,
    AI_GATEWAY_ID: "clef-shadow-gate",
    CLEF_EMAIL_SHADOW_TOKEN: "tok-123",
    AI: {
      run: (async (slug: string, input: Record<string, unknown>, opts: Record<string, unknown>) => {
        calls.push({ slug, input, opts });
        return aiResult;
      }) as unknown as Ai["run"],
    } as Ai,
  } satisfies Env;
  return { env, kv, calls };
}

export function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const push = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  console.log = push; console.warn = push; console.error = push; console.info = push;
  return { lines, restore: () => Object.assign(console, orig) };
}
