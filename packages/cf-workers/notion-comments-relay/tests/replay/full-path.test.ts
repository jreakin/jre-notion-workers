/**
 * Mode B replay: masked fixtures (fixtures/replay, fake ids only) through the real Worker fetch handler
 * with a stubbed env.AI. Pins today's shadow behavior per fixture; shadow only, never forwards.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { formatFixtureResult, runFixture, type FixtureResult, type ReplayFixture } from "./replay-pipeline.js";

const DIR = join(import.meta.dir, "../../fixtures/replay");

function load(name: string): ReplayFixture {
  return JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")) as ReplayFixture;
}

async function run(name: string): Promise<FixtureResult> {
  return runFixture(load(name));
}

describe("replay Mode B (full path, stub AI)", () => {
  test("fixtures contain only fake ids and masked titles", () => {
    for (const f of readdirSync(DIR)) {
      const text = readFileSync(join(DIR, f), "utf8");
      const uuids = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f{}i]+/g) ?? [];
      for (const u of uuids) {
        expect(/^(1{8}|2{8}|3{8}|7aac0000|0dd00000|fa4e0000|c0aa0000)-/.test(u)).toBe(true);
      }
      for (const m of text.matchAll(/"plain_text":\s*"([^"]*)"/g)) expect(m[1]).toBe("[masked]");
    }
  });

  test("page.created by John: no comment override, Clef consulted (stub wake)", async () => {
    const r = await run("01-john-page-created");
    expect(r.statuses).toEqual([200]);
    expect(r.cos_calls).toBe(0);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]?.reason).toBe("clef_ok");
    expect(r.rows[0]?.clef_decision).toBe("would_wake");
  });

  test("burst of non-John page.created under one parent: one Clef row per event", async () => {
    const r = await run("02-burst-page-created");
    expect(r.statuses).toEqual([200, 200, 200, 200, 200, 200]);
    expect(r.buffered).toBe(6);
    expect(r.rows.length).toBe(6);
    expect(new Set(r.rows.map((x) => x.item_id)).size).toBe(6);
    expect(r.rows.every((x) => x.clef_decision === "would_batch" && x.q_when === "ignore")).toBe(true);
  });

  test("page.created under an untracked parent still reaches Clef", async () => {
    const r = await run("03-untracked-parent-page-created");
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]?.reason).toBe("clef_ok");
  });

  test("properties_updated of an untracked property: echo drop, not forwarded, unscored at 0%", async () => {
    const r = await run("04-untracked-property-edit");
    expect(r.statuses).toEqual([200]);
    expect(r.buffered).toBe(0);
    expect(r.notion_fetches).toBe(0);
    expect(r.ai_calls).toBe(0);
    expect(r.rows.map((x) => [x.source, x.echo_reason, x.scored])).toEqual([["echo_filter", "untracked_property_edit", false]]);
  });

  test("tracked-parent edit: properties available ⇒ Clef; fetch failing ⇒ forced wake", async () => {
    const ok = await run("05-tracked-edit-props-ok");
    expect(ok.rows[0]?.reason).toBe("clef_ok");
    expect(ok.rows[0]?.p_action).toBe(0.9);
    const fail = await run("06-tracked-edit-fetch-fail");
    expect(fail.ai_calls).toBe(0);
    expect(fail.rows[0]?.reason).toBe("notion_fetch_failed");
    expect(fail.rows[0]?.clef_decision).toBe("would_wake");
    expect(fail.buffered).toBe(1);
  });

  test("comment own_echo: dropped live, sampled shadow score row added", async () => {
    const r = await run("07-comment-own-echo");
    expect(r.statuses).toEqual([200]);
    expect(r.buffered).toBe(0);
    expect(r.rows.map((x) => [x.reason, x.scored])).toEqual([
      ["rule_skip:own_echo", false],
      ["rule_skip:clef_ok", true],
    ]);
  });

  test("summaries carry labels and opaque ids only", async () => {
    const text = formatFixtureResult(await run("05-tracked-edit-props-ok"));
    expect(text).not.toContain("[masked]");
    expect(text).not.toContain("fa4e0000");
  });
});
