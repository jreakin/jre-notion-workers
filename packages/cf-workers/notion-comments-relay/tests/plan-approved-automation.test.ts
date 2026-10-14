import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Env } from "../src/env.js";
import {
  AS_WAKE_TIMEOUT_MS,
  AUTOMATION_SECRET_HEADER,
  MAX_BODY_BYTES,
  bearerHeader,
  missingPinnedProperties,
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
    ["Status", { type: "status", status: { name: "approved" } }, "status_not_approved"],
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

describe("plan-approved hardening (B1/B2)", () => {
  test("missing id (no data.id and no ID) → ignored missing_page_id", async () => {
    const calls = mockFetch();
    const puts: Put[] = [];
    const b = automationBody({ ID: { type: "rich_text", rich_text: [] } });
    delete (b.data as Record<string, unknown>).id;
    const res = await post(makeEnv(new Map(), puts), b);
    expect((await res.json()) as object).toMatchObject({ ignored: true, reason: "missing_page_id" });
    expect(calls.length + puts.length).toBe(0);
  });

  test("oversize body → 413 via Content-Length before read, and via actual size", async () => {
    const calls = mockFetch();
    const res = await post(makeEnv(), "{}", { [AUTOMATION_SECRET_HEADER]: SECRET, "content-length": String(MAX_BODY_BYTES + 1) });
    expect(res.status).toBe(413);
    const big = JSON.stringify({ pad: "x".repeat(MAX_BODY_BYTES) });
    expect((await post(makeEnv(), big)).status).toBe(413);
    expect(calls.length).toBe(0);
  });

  test("array and null bodies → 400", async () => {
    mockFetch();
    expect((await post(makeEnv(), "[1,2]")).status).toBe(400);
    expect((await post(makeEnv(), "null")).status).toBe(400);
  });

  test("fetch throws → 502, no dedupe write", async () => {
    const puts: Put[] = [];
    globalThis.fetch = mock(async () => {
      throw new TypeError("network down");
    }) as unknown as typeof fetch;
    const res = await post(makeEnv(new Map(), puts), automationBody());
    expect(res.status).toBe(502);
    expect((await res.json()) as object).toMatchObject({ error: "as_wake_failed" });
    expect(puts.length).toBe(0);
  });

  test("B1: outbound wake carries an AbortSignal; timeout → 502 as_wake_timeout", async () => {
    expect(AS_WAKE_TIMEOUT_MS).toBe(10_000);
    const puts: Put[] = [];
    let signal: AbortSignal | undefined;
    globalThis.fetch = mock(async (_u: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as unknown as typeof fetch;
    const res = await post(makeEnv(new Map(), puts), automationBody());
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(res.status).toBe(502);
    expect((await res.json()) as object).toMatchObject({ error: "as_wake_timeout" });
    expect(puts.length).toBe(0);
  });

  test("B1: a hung AS is actually aborted by the signal", async () => {
    const realTimeout = AbortSignal.timeout;
    (AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout = () => realTimeout.call(AbortSignal, 20);
    try {
      globalThis.fetch = mock(
        (_u: unknown, init?: RequestInit) =>
          new Promise<Response>((_res, rej) => {
            init?.signal?.addEventListener("abort", () => rej(init.signal!.reason));
          }),
      ) as unknown as typeof fetch;
      const res = await post(makeEnv(), automationBody());
      expect(res.status).toBe(502);
      expect((await res.json()) as object).toMatchObject({ error: "as_wake_timeout" });
    } finally {
      (AbortSignal as unknown as { timeout: typeof realTimeout }).timeout = realTimeout;
    }
  });

  test("trimmed 'Approved ' status is accepted", async () => {
    const calls = mockFetch();
    await post(makeEnv(), automationBody({ Status: { type: "status", status: { name: "Approved " } } }));
    expect(calls.length).toBe(1);
  });

  test("whitespace-only secrets count as unset", async () => {
    const calls = mockFetch();
    expect((await post(makeEnv(new Map(), [], { NOTION_AUTOMATION_SECRET: "   " }), automationBody(), { [AUTOMATION_SECRET_HEADER]: "   " })).status).toBe(401);
    expect((await post(makeEnv(new Map(), [], { AS_WEBHOOK_AUTHORIZATION: "  " }), automationBody())).status).toBe(503);
    expect((await post(makeEnv(new Map(), [], { AS_WEBHOOK_URL: " " }), automationBody())).status).toBe(503);
    expect(calls.length).toBe(0);
  });

  test("bearerHeader matches prefix case-insensitively", () => {
    expect(bearerHeader("tok")).toBe("Bearer tok");
    expect(bearerHeader("Bearer tok")).toBe("Bearer tok");
    expect(bearerHeader("bearer tok")).toBe("Bearer tok");
    expect(bearerHeader("BEARER   tok ")).toBe("Bearer tok");
  });

  test("lowercase bearer in AS secret is not double-prefixed on the wire", async () => {
    const calls = mockFetch();
    await post(makeEnv(new Map(), [], { AS_WEBHOOK_AUTHORIZATION: "bearer as-token" }), automationBody());
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer as-token");
  });

  test("missing pinned properties log a warning (names only)", async () => {
    mockFetch();
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = ((l: unknown) => warns.push(String(l))) as typeof console.warn;
    try {
      const b = automationBody();
      const props = (b.data as { properties: Record<string, unknown> }).properties;
      delete props["Approved At"];
      delete props.ID;
      expect(missingPinnedProperties(b)).toEqual(["ID", "Approved At"]);
      const res = await post(makeEnv(), b);
      expect((await res.json()) as object).toMatchObject({ ignored: true, reason: "missing_approved_at" });
      expect(warns.some((w) => w.includes("plan_approved_missing_properties") && w.includes("Approved At"))).toBe(true);
      expect(warns.join("")).not.toContain(SECRET);
    } finally {
      console.warn = orig;
    }
  });

  test("end-to-end: realistic Notion Send webhook automation body", async () => {
    const calls = mockFetch();
    const store = new Map<string, string>();
    const puts: Put[] = [];
    const body = {
      source: {
        type: "automation",
        automation_id: "1557d7f5-6298-80a1-b2c3-004b1a2c3d4e",
        action_id: "1557d7f5-6298-80f0-9a8b-00c1d2e3f4a5",
        event_id: "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
        attempt: 1,
      },
      data: {
        object: "page",
        id: "28a7d7f5-6298-8011-9c2e-e1f0a1b2c3d4",
        created_time: "2026-10-12T15:04:00.000Z",
        last_edited_time: "2026-10-14T00:41:00.000Z",
        created_by: { object: "user", id: "2e7d872b-594c-8161-92a2-00024b29e816" },
        last_edited_by: { object: "user", id: "2e7d872b-594c-8161-92a2-00024b29e816" },
        cover: null,
        icon: null,
        parent: { type: "data_source_id", data_source_id: "2e97d7f5-6298-804c-b8a5-000b18b72684", database_id: "2e97d7f5-6298-8001-aaaa-c0ffee000001" },
        archived: false,
        in_trash: false,
        properties: {
          ID: { id: "%3Ax%3E", type: "unique_id", unique_id: { prefix: "LOCK", number: 61 } },
          Name: { id: "title", type: "title", title: [{ type: "text", text: { content: "Relay plan", link: null }, plain_text: "Relay plan", href: null }] },
          Kind: { id: "Kd%3F", type: "select", select: { id: "a1", name: "Plan", color: "blue" } },
          Status: { id: "St%40", type: "status", status: { id: "b2", name: "Approved", color: "green" } },
          Project: { id: "Pr%23", type: "relation", relation: [{ id: "3157d7f5-6298-8057-b079-ef0d3c48eb46" }], has_more: false },
          "Approved At": { id: "Ap%24", type: "date", date: { start: "2026-10-14T00:41:00.000+00:00", end: null, time_zone: null } },
        },
        url: "https://www.notion.so/Relay-plan-28a7d7f5629880119c2ee1f0a1b2c3d4",
        public_url: null,
      },
    };
    const res = await post(makeEnv(store, puts), body);
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toMatchObject({ ok: true, forwarded: true, status: 200 });
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://as.example/webhook");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      source: "notion-comments-relay",
      event: "notion.automation.plan_approved",
      page_id: "28a7d7f5629880119c2ee1f0a1b2c3d4",
      id: "LOCK-61",
      kind: "Plan",
      status: "Approved",
      project: "3157d7f5-6298-8057-b079-ef0d3c48eb46",
      approved_at: "2026-10-14T00:41:00.000+00:00",
    });
    expect(puts.map((p) => p.key)).toEqual(["plan_approved:v1:28a7d7f5629880119c2ee1f0a1b2c3d4:2026-10-14T00:41:00.000+00:00"]);
    // second delivery of same event → duplicate, no new wake/write
    await post(makeEnv(store, puts), body);
    expect(calls.length).toBe(1);
    expect(puts.length).toBe(1);
  });
});
