import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "bun:test";
import { Client } from "@notionhq/client";
import { executeCreateHandoffMarker } from "../../src/workers/create-handoff-marker.js";

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

describe.skipIf(!TEST_DB)("create-handoff-marker (integration)", () => {
  const notion = new Client({ auth: process.env.TEST_NOTION_TOKEN });

  it("returns success and handoff_block when create_task is false", async () => {
    const result = await executeCreateHandoffMarker(
      {
        source_agent: "GitHub Insyncerator",
        target_agent: "Client Repo Auditor",
        escalation_reason: "Integration test",
        source_digest_url: "https://notion.so/test",
        create_task: false,
        task_priority: "🟢 Low",
        client_relation_ids: [],
        project_relation_ids: [],
      },
      notion
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.handoff_block).toContain("Escalated To: Client Repo Auditor");
    }
  });
});
