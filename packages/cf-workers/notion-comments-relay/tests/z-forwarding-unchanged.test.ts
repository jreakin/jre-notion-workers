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

  test("shadow gate failure does not change HTTP response, signature, or coalesce body", async () => {
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
      NOTION_API_TOKEN: "notion-token",
    };

    await env.RELAY_KV.put("notion_verification_token", TOKEN);

    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("cos.example")) {
        return new Response("ok", { status: 200 });
      }
      if (url.includes("api.notion.com")) {
        return new Response("notion down", { status: 503 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const body = JSON.stringify({
      type: "page.created",
      entity: { id: "p1", type: "page" },
      data: {
        parent: { data_source_id: "2e97d7f5-6298-804c-b8a5-000b18b72684" },
      },
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

    const ctx = {
      waitUntil: (_p: Promise<unknown>) => {
        // Coalesce flush is scheduled here; buffer is written before waitUntil returns.
      },
    } as ExecutionContext;

    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");

    const bufRaw = await env.RELAY_KV.get("coalesce_buffer");
    expect(bufRaw).not.toBeNull();
    const buf = JSON.parse(bufRaw ?? "[]") as Array<{
      body: string;
      signature: string | null;
      notion_type: string | null;
    }>;
    expect(buf).toHaveLength(1);
    expect(buf[0]?.body).toBe(body);
    expect(buf[0]?.signature).toBe(signature);
    expect(buf[0]?.notion_type).toBe("page.created");
    expect(new TextEncoder().encode(buf[0]?.body ?? "")).toEqual(new TextEncoder().encode(body));
  });
});
