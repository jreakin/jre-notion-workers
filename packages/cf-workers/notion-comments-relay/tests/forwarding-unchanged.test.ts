import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";

async function signBody(body: string, token: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

describe("index fetch forwarding", () => {
  let origFetch: typeof fetch;
  const TOKEN = "secret_test_token_12345";

  beforeEach(() => {
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    mock.restore();
  });

  test("shadow gate throw does not change HTTP response or coalesce enqueue", async () => {
    mock.module("../src/wake-gate/wake-gate-shadow.js", () => ({
      runShadowWakeGates: async () => {
        throw new Error("shadow gate exploded");
      },
      SHADOW_LOG_EVENT: "ad_docs_wake_gate_shadow",
    }));

    const { default: worker } = await import("../src/index.js");

    const kvStore = new Map<string, string>();
    const env = {
      RELAY_KV: {
        get: async (k: string) => kvStore.get(k) ?? null,
        put: async (k: string, v: string) => {
          kvStore.set(k, v);
        },
        delete: async () => {},
        list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
        getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
      } as unknown as KVNamespace,
      COS_WEBHOOK_URL: "https://cos.example/hook",
      COS_WEBHOOK_AUTHORIZATION: "Bearer t",
      SETUP_SECRET: "s",
      NOTION_VERIFICATION_TOKEN: TOKEN,
    };

    await env.RELAY_KV.put("notion_verification_token", TOKEN);

    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("cos.example")) {
        return new Response("ok", { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const body = JSON.stringify({
      type: "page.created",
      entity: { id: "p1", type: "page" },
      data: { parent: { data_source_id: "other" } },
    });
    const signature = await signBody(body, TOKEN);
    const req = new Request("https://relay.test/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Notion-Signature": signature,
        "user-agent": "notion",
      },
      body,
    });

    const waitUntilTasks: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => {
        waitUntilTasks.push(p);
      },
    } as ExecutionContext;

    const res = await worker.fetch(req, env, ctx);
    if (waitUntilTasks.length > 0) {
      await Promise.allSettled([waitUntilTasks[0]]);
    }

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    const buf = await env.RELAY_KV.get("coalesce_buffer");
    expect(buf).not.toBeNull();
  });
});
