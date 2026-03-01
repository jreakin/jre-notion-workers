import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "bun:test";
import { Client } from "@notionhq/client";
import { executeCheckUpstreamStatus } from "../../src/workers/check-upstream-status.js";

if (!process.env.TEST_DOCS_DATABASE_ID) {
  try {
    const cwd = resolve(import.meta.dir, "../..");
    const raw = readFileSync(resolve(cwd, ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
    }
  } catch {}
}
const TEST_DB = process.env.TEST_DOCS_DATABASE_ID;

describe.skipIf(!TEST_DB)("check-upstream-status (integration)", () => {
  const notion = new Client({ auth: process.env.TEST_NOTION_TOKEN });

  it("returns structured output for valid agent name", async () => {
    const result = await executeCheckUpstreamStatus(
      { agent_name: "GitHub Insyncerator", max_age_hours: 48, require_current_cycle: false },
      notion
    );
    expect(typeof result.found).toBe("boolean");
    expect(result.agent_name).toBe("GitHub Insyncerator");
    expect(typeof result.status).toBe("string");
    expect(typeof result.degraded).toBe("boolean");
    expect(typeof result.data_completeness_notice).toBe("string");
  });
});
