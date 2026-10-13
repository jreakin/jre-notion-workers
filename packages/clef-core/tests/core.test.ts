import { describe, expect, test } from "bun:test";
import {
  buildClefRunArguments,
  clefDailyCapKey,
  clefErrorReason,
  parseDailyCap,
  readChoice,
  readScore,
  resolveClefModeFromKv,
  runClefModel,
  tryConsumeDailyCall,
  type KvLike,
} from "../src/index.js";

function memKv(init: Record<string, string> = {}): KvLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return {
    data,
    async get(k) { return data.get(k) ?? null; },
    async put(k, v) { data.set(k, v); },
  };
}

describe("clef-core", () => {
  test("cap keys: legacy and per-gate", () => {
    const d = new Date("2026-10-13T12:00:00Z");
    expect(clefDailyCapKey(undefined, d)).toBe("clef:calls:2026-10-13");
    expect(clefDailyCapKey("clef_email", d)).toBe("clef:calls:clef_email:2026-10-13");
    expect(parseDailyCap("abc", 7)).toBe(7);
    expect(parseDailyCap(" 12 ", 7)).toBe(12);
  });
  test("cap consumes then refuses", async () => {
    const kv = memKv();
    expect(await tryConsumeDailyCall(kv, "k", 1)).toEqual({ ok: true, count: 1 });
    expect(await tryConsumeDailyCall(kv, "k", 1)).toEqual({ ok: false, reason: "clef_daily_cap" });
    kv.data.set("k", "x");
    expect(await tryConsumeDailyCall(kv, "k", 5)).toEqual({ ok: false, reason: "clef_cap_invalid" });
  });
  test("mode: global off wins; default shadow", async () => {
    expect((await resolveClefModeFromKv(memKv(), undefined, "g")).allowClefCall).toBe(true);
    const off = await resolveClefModeFromKv(memKv({ "clef:mode:global": "off", "clef:mode:g": "shadow" }), undefined, "g");
    expect(off).toEqual({ allowClefCall: false, modeLabel: "off", reason: "clef_global_off" });
    const gateOff = await resolveClefModeFromKv(memKv({ "clef:mode:g": "off" }), undefined, "g");
    expect(gateOff.reason).toBe("clef_mode_off");
  });
  test("choice/score readers", () => {
    const a = { c: { type: "choice", choice: "x" }, s: { type: "score", score: 2.5 } };
    expect(readChoice(a, "c", ["x", "y"] as const)).toBe("x");
    expect(readChoice(a, "c", ["y"] as const)).toBeNull();
    expect(readScore(a, "s", 3)).toBe(2.5);
    expect(readScore(a, "s", 2)).toBeNull();
  });
  test("timeout yields clef_timeout", async () => {
    const ai = { run: () => new Promise<unknown>(() => {}) };
    let reason = "";
    try { await runClefModel(ai, "gw", "@cf/cloudflare/clef", "clef", "s", {}, 10); } catch (e) { reason = clefErrorReason(e); }
    expect(reason).toBe("clef_timeout");
  });
  test("gateway options are opt-in; plain id unchanged", () => {
    expect(buildClefRunArguments("gw", "clef", "s", {}).runOptions).toEqual({ gateway: { id: "gw" } });
    expect(buildClefRunArguments(undefined, "clef", "s", {}).runOptions).toEqual({});
    expect(
      buildClefRunArguments({ id: "gw", collectLog: false, skipCache: true }, "clef", "s", {}).runOptions,
    ).toEqual({ gateway: { id: "gw", collectLog: false, skipCache: true } });
  });
});
