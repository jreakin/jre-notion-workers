import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { KV_MIN_TTL_SECONDS, kvTtl } from "../src/kv-ttl.js";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("kvTtl", () => {
  test("clamps to Cloudflare KV 60s minimum", () => {
    expect(KV_MIN_TTL_SECONDS).toBe(60);
    expect(kvTtl(35)).toBe(60);
    expect(kvTtl(0)).toBe(60);
    expect(kvTtl(-5)).toBe(60);
    expect(kvTtl(Number.NaN)).toBe(60);
    expect(kvTtl(59.2)).toBe(60);
  });

  test("preserves TTLs at or above the minimum (rounding up)", () => {
    expect(kvTtl(60)).toBe(60);
    expect(kvTtl(65)).toBe(65);
    expect(kvTtl(120.4)).toBe(121);
    expect(kvTtl(86_400)).toBe(86_400);
  });

  test("every expirationTtl in src goes through kvTtl()", () => {
    const srcDir = join(import.meta.dir, "../src");
    const offenders: string[] = [];
    for (const file of walk(srcDir)) {
      if (file.endsWith("kv-ttl.ts")) continue;
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        const m = line.match(/expirationTtl\s*:\s*(.+)/);
        if (m && !m[1]!.trim().startsWith("kvTtl(")) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test("integration: clef shadow ring put uses a TTL >= 60", async () => {
    const { appendClefShadowLog } = await import("../src/wake-gate/clef-wake-gate.js");
    const ttls: number[] = [];
    const env = {
      RELAY_KV: {
        get: async () => null,
        put: async (_k: string, _v: string, o?: { expirationTtl?: number }) => {
          if (o?.expirationTtl !== undefined) ttls.push(o.expirationTtl);
        },
      },
      CLEF_RING: "1",
    } as never;
    const origLog = console.log;
    console.log = () => {};
    try {
      await appendClefShadowLog(env, { item_id: "unknown" } as never);
    } finally {
      console.log = origLog;
    }
    expect(ttls.length).toBe(1);
    expect(ttls[0]!).toBeGreaterThanOrEqual(KV_MIN_TTL_SECONDS);
  });
});
