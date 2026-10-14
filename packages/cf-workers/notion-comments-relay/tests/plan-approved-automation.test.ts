import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Env } from "../src/env.js";
import {
  AUTOMATION_SECRET_HEADER,
  PLAN_APPROVED_PATH,
  extractFields,
  secretMatches,
  validatePlanApproved,
} from "../src/plan-approved-automation.js";

const SECRET = "automation-secret-value";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Put = { key: string; ttl?: number };
function makeEnv(store = new Map<string, string>(), puts: Put[] = [], over: Partial<Env> = {}): Env {
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string, o?: { expirationTtl?: number }) => {
      puts.push({ key: k, ttl: o?.expirationTtl });
      store.set(k, v);
    },
    delete: async (k: string) => void store.delete(k),
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace;
  return {
    RELAY_KV: kv,
    COS_WEBHOOK_URL: "https://cos.example/webhook",
    COS_WEBHOOK_AUTHORIZATION: "Bearer cos",
    SETUP_SECRET: "setup",
    NOTION_AUTOMATION_SECRET: SECRET,
    AS_WEBHOOK_URL: "https://as.example/webhook",
    AS_WEBHOOK_AUTHORIZATION: "as-token",
    ...over,
  };
}

function automationBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: { type: "automation", automation_id: "a1" },
    data: {
      object: "page",
      id: "1234abcd-0000-0000-0000-00000000beef",
      properties: {
        ID: { type: "unique_id", unique_id: { prefix: "PLAN", number: 7 } },
        Kind: { type: "select", select: { name: "Plan" } },
        Status: { type: "status", status: { name: "Approved" } },
        Project: { type: "relation", relation: [{ id: "proj-1" }] },
        "Approved At": { type: "date", date: { start: "2026-10-13T19:00:00.000-05:00" } },
        ...over,
      },
    },
  };
}

async function post(env: Env, body: unknown, headers: Record<string, string> = { [AUTOMATION_SECRET_HEADER]: SECRET }, method = "POST") {
  const { default: worker } = await import("../src/index.js");
  const ctx = { waitUntil() {} } as unknown as ExecutionContext;
  return worker.fetch(
    new Request(`https://relay.example${PLAN_APPROVED_PATH}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
    }),
    env,
    ctx,
  );
}

function mockFetch(status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response("ok", { status });
  }) as unknown as typeof fetch;
  return calls;
}

describe("plan-approved automation route", () => {
  test("missing / wrong / unset secret → 401, no fetch, no KV", async () => {
    const calls = mockFetch();
    const puts: Put[] = [];
    expect((await post(makeEnv(new Map(), puts), automationBody(), {})).status).toBe(401);
    expect((await post(makeEnv(new Map(), puts), automationBody(), { [AUTOMATION_SECRET_HEADER]: "nope" })).status).toBe(401);
    expect((await post(makeEnv(new Map(), puts), automationBody(), { [AUTOMATION_SECRET_HEADER]: SECRET + "x" })).status).toBe(401);
    expect((await post(makeEnv(new Map(), puts, { NOTION_AUTOMATION_SECRET: "" }), automationBody(), { [AUTOMATION_SECRET_HEADER]: "" })).status).toBe(401);
    expect(calls.length).toBe(0);
    expect(puts.length).toBe(0);
  });

  test("non-POST → 405", async () => {
    expect((await post(makeEnv(), null, {}, "GET")).status).toBe(405);
  });

  test("valid approval wakes AS (not CoS) with bearer auth, one KV write with TTL ≥ 60", async () => {
    const calls = mockFetch();
    const puts: Put[] = [];
    const res = await post(makeEnv(new Map(), puts), automationBody());
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://as.example/webhook");
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.authorization).toBe("Bearer as-token");
    const sent = JSON.parse(String(calls[0]!.init.body));
    expect(sent).toMatchObject({ kind: "Plan", status: "Approved", project: "proj-1", id: "PLAN-7", page_id: "1234abcd00000000000000000000beef" });
    expect(puts.length).toBe(1);
    expect(puts[0]!.ttl!).toBeGreaterThanOrEqual(60);
    expect(puts[0]!.key).toBe("plan_approved:v1:1234abcd00000000000000000000beef:2026-10-13T19:00:00.000-05:00");
  });

  test("duplicate (same page + Approved At) is not re-forwarded and writes nothing", async () => {
    const store = new Map<string, string>();
    const puts: Put[] = [];
    const calls = mockFetch();
    await post(makeEnv(store, puts), automationBody());
    const res = await post(makeEnv(store, puts), automationBody());
    expect((await res.json()) as object).toMatchObject({ duplicate: true });
    expect(calls.length).toBe(1);
    expect(puts.length).toBe(1);
    // New Approved At → re-approval wakes again.
    await post(makeEnv(store, puts), automationBody({ "Approved At": { type: "date", date: { start: "2026-10-14" } } }));
    expect(calls.length).toBe(2);
  });

  test.each([
    ["Kind", { type: "select", select: { name: "Task" } }, "kind_not_plan"],
    ["Status", { type: "status", status: { name: "Draft" } }, "status_not_approved"],
    ["Project", { type: "relation", relation: [] }, "project_empty"],
    ["Approved At", { type: "date", date: null }, "missing_approved_at"],
  ])("ignores %s mismatch", async (prop, value, reason) => {
    const calls = mockFetch();
    const puts: Put[] = [];
    const res = await post(makeEnv(new Map(), puts), automationBody({ [prop as string]: value }));
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toMatchObject({ ignored: true, reason });
    expect(calls.length).toBe(0);
    expect(puts.length).toBe(0);
  });

  test("invalid JSON → 400", async () => {
    mockFetch();
    expect((await post(makeEnv(), "{nope")).status).toBe(400);
    expect((await post(makeEnv(), "[]")).status).toBe(400);
  });

  test("AS not configured → 503, no KV write", async () => {
    const calls = mockFetch();
    const puts: Put[] = [];
    const res = await post(makeEnv(new Map(), puts, { AS_WEBHOOK_URL: undefined }), automationBody());
    expect(res.status).toBe(503);
    expect(calls.length).toBe(0);
    expect(puts.length).toBe(0);
  });

  test("AS non-2xx → 502 and not deduped (retry allowed)", async () => {
    const store = new Map<string, string>();
    const puts: Put[] = [];
    mockFetch(500);
    expect((await post(makeEnv(store, puts), automationBody())).status).toBe(502);
    expect(puts.length).toBe(0);
    const calls = mockFetch(200);
    expect((await post(makeEnv(store, puts), automationBody())).status).toBe(200);
    expect(calls.length).toBe(1);
  });
});

describe("helpers", () => {
  test("secretMatches", async () => {
    expect(await secretMatches("abc", "abc")).toBe(true);
    expect(await secretMatches("abc", "abd")).toBe(false);
    expect(await secretMatches("", "abc")).toBe(false);
  });

  test("flat payload shape and case-insensitive names", () => {
    const f = extractFields({ id: "p1", kind: "Plan", STATUS: "Approved", project: "X", approved_at: "2026-10-13" });
    expect(f).toMatchObject({ pageId: "p1", kind: "Plan", status: "Approved", project: "X", approvedAt: "2026-10-13" });
    expect(validatePlanApproved(f).ok).toBe(true);
  });

  test("rich_text / title project", () => {
    const f = extractFields(automationBody({ Project: { type: "rich_text", rich_text: [{ plain_text: "  " }] } }));
    expect(validatePlanApproved(f)).toEqual({ ok: false, reason: "project_empty" });
  });
});
