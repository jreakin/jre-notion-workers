import { afterEach, describe, expect, test } from "bun:test";
import worker from "../src/index.js";
import { RING_PREFIX } from "../src/shadow.js";
import { captureLogs, HASH_NOFLASH, makeEnv, payload } from "./helpers.js";

// A client disconnect can cancel the fetch handler but never a ctx.waitUntil promise, so admit (the pending-row
// KV write) and completion must be one promise registered with waitUntil before the handler awaits anything.
let cap: ReturnType<typeof captureLogs> | null = null;
afterEach(() => {
  cap?.restore();
  cap = null;
});

const ctx = () => {
  const p: Promise<unknown>[] = [];
  // SAFETY: the handler only calls waitUntil/passThroughOnException; the rest of ExecutionContext is unused here.
  return { p, c: { waitUntil: (x: Promise<unknown>) => p.push(x), passThroughOnException() {} } as unknown as ExecutionContext };
};
const decisionReq = (signal?: AbortSignal) =>
  new Request("https://w.example/clef/email-shadow", {
    method: "POST",
    headers: { authorization: "Bearer tok-123" },
    body: JSON.stringify(payload()),
    signal,
  });
const rowOf = (kv: { data: Map<string, string> }) => JSON.parse(kv.data.get(`${RING_PREFIX}${HASH_NOFLASH}`) ?? "null");

/** Hold the first KV put (the pending row) open until `release()`; `started` resolves once it is in flight. */
function gatePendingPut(kv: { put: (k: string, v: string) => Promise<void>; data: Map<string, string> }) {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const startedP = new Promise<void>((r) => (started = r));
  const realPut = kv.put.bind(kv);
  let first = true;
  kv.put = async (k, v) => {
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
  test("aborted request: completion is registered while the pending-row write is in flight and still finishes", async () => {
    cap = captureLogs();
    const { env, kv, calls } = makeEnv();
    const g = gatePendingPut(kv);
    const k = ctx();
    const abort = new AbortController();
    const handler = worker.fetch(decisionReq(abort.signal), env, k.c);
    handler.catch(() => {}); // the "client" is gone: nobody consumes this response
    await g.started; // admit is mid-KV-write, the response is not yet decided
    expect(k.p.length).toBe(1); // already registered with waitUntil (was 0 before the fix)
    expect(kv.data.has(`${RING_PREFIX}${HASH_NOFLASH}`)).toBe(false);
    abort.abort(); // disconnect after admit started
    g.release();
    await Promise.all(k.p); // only waitUntil work is guaranteed to run
    const row = rowOf(kv);
    expect(row.error_reason).toBeNull(); // not stranded as clef_pending
    expect(row.shadow_label).toBe("would_skip");
    expect(calls.length).toBe(1);
  });

  test("normal request: 202 only after the pending row is stored, response body unchanged, one waitUntil", async () => {
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
    expect((await r.json()) as unknown /* SAFETY: compared with toEqual, never indexed */).toEqual({ logged: true, verdict: "pending" });
    expect(k.p.length).toBe(1);
    await Promise.all(k.p);
    expect(rowOf(kv).error_reason).toBeNull();
    expect(calls.length).toBe(1);
  });

  test("duplicate of a finished row: 202 duplicate, Clef not re-run", async () => {
    cap = captureLogs();
    const { env, calls } = makeEnv();
    const first = ctx();
    expect((await worker.fetch(decisionReq(), env, first.c)).status).toBe(202);
    await Promise.all(first.p);
    const second = ctx();
    const r = await worker.fetch(decisionReq(), env, second.c);
    expect(r.status).toBe(202);
    expect((await r.json()) as unknown /* SAFETY: compared with toEqual, never indexed */).toEqual({ logged: true, duplicate: true });
    await Promise.all(second.p);
    expect(calls.length).toBe(1);
  });

  test("pending-row write failure: 500, waitUntil promise settles without rejecting, no completion", async () => {
    cap = captureLogs();
    const { env, kv, calls } = makeEnv();
    kv.put = async () => {
      throw new Error("kv down");
    };
    const k = ctx();
    const r = await worker.fetch(decisionReq(), env, k.c);
    expect(r.status).toBe(500);
    await Promise.all(k.p); // must not reject
    expect(calls.length).toBe(0);
  });

  test("invalid payload: 400 and the registered promise settles", async () => {
    cap = captureLogs();
    const { env, calls } = makeEnv();
    const k = ctx();
    const r = await worker.fetch(
      new Request("https://w.example/clef/email-shadow", { method: "POST", headers: { authorization: "Bearer tok-123" }, body: "{{" }),
      env,
      k.c,
    );
    expect(r.status).toBe(400);
    await Promise.all(k.p);
    expect(calls.length).toBe(0);
  });
});
