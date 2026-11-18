import { afterEach, describe, expect, test } from "bun:test";
import worker from "../src/index.js";
import { RING_PREFIX } from "../src/shadow.js";
import { captureLogs, HASH_NOFLASH, makeEnv, payload } from "./helpers.js";

// A client disconnect can cancel the fetch handler but not a ctx.waitUntil promise, so admit (the pending-row
// KV write) and completion are one promise registered with waitUntil before the handler awaits anything.
// SCOPE: these tests prove registration ORDER (waitUntil is called before the pending-row KV await, and the
// registered work completes). They do not exercise runtime cancellation on a real client disconnect; that
// needs a Worker-runtime HTTP test.
let cap: ReturnType<typeof captureLogs> | null = null;
afterEach((): void => {
  cap?.restore();
  cap = null;
});

const ctx = (): { p: Promise<unknown>[]; c: ExecutionContext } => {
  const p: Promise<unknown>[] = [];
  // SAFETY: the fake supplies waitUntil (records the promise) and passThroughOnException (no-op), the only
  // ExecutionContext members src/index.ts uses; the remaining members are never touched in these tests.
  return { p, c: { waitUntil: (x: Promise<unknown>) => p.push(x), passThroughOnException() {} } as unknown as ExecutionContext };
};
const decisionReq = (): Request =>
  new Request("https://w.example/clef/email-shadow", {
    method: "POST",
    headers: { authorization: "Bearer tok-123" },
    body: JSON.stringify(payload()),
  });
const rowOf = (kv: { data: Map<string, string> }): Record<string, unknown> => JSON.parse(kv.data.get(`${RING_PREFIX}${HASH_NOFLASH}`) ?? "null");

/** Hold the first KV put (the pending row) open until `release()`; `started` resolves once it is in flight. */
function gatePendingPut(kv: { put: (k: string, v: string) => Promise<void>; data: Map<string, string> }): {
  release: () => void;
  started: Promise<void>;
} {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const startedP = new Promise<void>((r) => (started = r));
  const realPut = kv.put.bind(kv);
  let first = true;
  kv.put = async (k, v): Promise<void> => {
    if (first) {
      first = false;
      started();
      await gate;
    }
    return realPut(k, v);
  };
  return { release, started: startedP };
}

describe("waitUntil is registered before admit awaits", () => {
  test("registration order: waitUntil is called while the pending-row write is still in flight, and that work finishes", async (): Promise<void> => {
    cap = captureLogs();
    const { env, kv, calls } = makeEnv();
    const g = gatePendingPut(kv);
    const k = ctx();
    const handler = worker.fetch(decisionReq(), env, k.c);
    handler.catch(() => {}); // nobody consumes this response; only the registered waitUntil work is awaited below
    await g.started; // admit is mid-KV-write, the response is not yet decided
    expect(k.p).toHaveLength(1); // already registered with waitUntil (was 0 before the fix)
    expect(kv.data.has(`${RING_PREFIX}${HASH_NOFLASH}`)).toBe(false);
    g.release();
    await Promise.all(k.p);
    const row = rowOf(kv);
    expect(row.error_reason).toBeNull(); // completed, not left as clef_pending
    expect(row.shadow_label).toBe("would_skip");
    expect(calls.length).toBe(1);
  });

  test("normal request: 202 only after the pending row is stored, response body unchanged, one waitUntil", async (): Promise<void> => {
    cap = captureLogs();
    const { env, kv, calls } = makeEnv();
    const g = gatePendingPut(kv);
    const k = ctx();
    let settled = false;
    const handler = worker.fetch(decisionReq(), env, k.c).then((r) => {
      settled = true;
      return r;
    });
    await g.started;
    await Promise.resolve();
    expect(settled).toBe(false); // no 202 before the row is durable
    g.release();
    const r = await handler;
    expect(r.status).toBe(202);
    const body: unknown = await r.json();
    expect(body).toEqual({ logged: true, verdict: "pending" });
    expect(k.p.length).toBe(1);
    await Promise.all(k.p);
    expect(rowOf(kv).error_reason).toBeNull();
    expect(calls.length).toBe(1);
  });

  test("duplicate of a finished row: 202 duplicate, Clef not re-run", async (): Promise<void> => {
    cap = captureLogs();
    const { env, calls } = makeEnv();
    const first = ctx();
    expect((await worker.fetch(decisionReq(), env, first.c)).status).toBe(202);
    await Promise.all(first.p);
    const second = ctx();
    const r = await worker.fetch(decisionReq(), env, second.c);
    expect(r.status).toBe(202);
    const body: unknown = await r.json();
    expect(body).toEqual({ logged: true, duplicate: true });
    expect(second.p).toHaveLength(1);
    await Promise.all(second.p);
    expect(calls.length).toBe(1);
  });

  test("pending-row write failure: 500, waitUntil promise settles without rejecting, no completion", async (): Promise<void> => {
    cap = captureLogs();
    const { env, kv, calls } = makeEnv();
    kv.put = async (): Promise<void> => {
      throw new Error("kv down");
    };
    const k = ctx();
    const r = await worker.fetch(decisionReq(), env, k.c);
    expect(r.status).toBe(500);
    expect(k.p).toHaveLength(1);
    await Promise.all(k.p); // must not reject
    expect(calls.length).toBe(0);
  });

  test("invalid payload: 400 and the registered promise settles", async (): Promise<void> => {
    cap = captureLogs();
    const { env, calls } = makeEnv();
    const k = ctx();
    const r = await worker.fetch(
      new Request("https://w.example/clef/email-shadow", { method: "POST", headers: { authorization: "Bearer tok-123" }, body: "{{" }),
      env,
      k.c,
    );
    expect(r.status).toBe(400);
    expect(k.p).toHaveLength(1);
    await Promise.all(k.p);
    expect(calls.length).toBe(0);
  });
});
