import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it, afterEach } from "bun:test";
import { Client } from "@notionhq/client";
import { executeWriteAgentDigest } from "../../src/workers/write-agent-digest.js";
import { createMockWriteDigestInput } from "../fixtures/mock-inputs.js";

// Load .env.local when running integration tests so vars are set even if bun test didn't pass --env-file
if (!process.env.TEST_DOCS_DATABASE_ID) {
  try {
    const cwd = resolve(import.meta.dir, "../..");
    const raw = readFileSync(resolve(cwd, ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
    }
  } catch {
    // ignore missing .env.local
  }
}

const TEST_DB = process.env.TEST_DOCS_DATABASE_ID;
const createdPageIds: string[] = [];

describe.skipIf(!TEST_DB)("write-agent-digest (integration)", () => {
  const notion = new Client({ auth: process.env.TEST_NOTION_TOKEN });

  afterEach(async () => {
    for (const pageId of createdPageIds) {
      try {
        await notion.pages.update({ page_id: pageId, archived: true });
      } catch {
        // ignore cleanup errors
      }
    }
    createdPageIds.length = 0;
  });

  it("returns structured output when called with valid input", async () => {
    const result = await executeWriteAgentDigest(
      createMockWriteDigestInput({ target_database: "docs" }),
      notion
    );
    if (result.success) {
      expect(result.page_id).toBeDefined();
      expect(result.page_url).toContain("notion");
      expect(typeof result.title).toBe("string");
      expect(typeof result.is_heartbeat).toBe("boolean");
      expect(typeof result.is_error_titled).toBe("boolean");
      if (result.page_id) createdPageIds.push(result.page_id);
    } else {
      expect(typeof result.error).toBe("string");
    }
  });
});
