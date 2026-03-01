import { describe, expect, it } from "bun:test";
import { executeWriteAgentDigest } from "../../src/workers/write-agent-digest.js";
import { createMockWriteDigestInput } from "../fixtures/mock-inputs.js";
import { createMockNotionClient } from "../fixtures/mock-notion.js";

describe("write-agent-digest output schema", () => {
  it("returns required fields on success", async () => {
    const prev = process.env.DOCS_DATABASE_ID;
    process.env.DOCS_DATABASE_ID = "00000000000000000000000000000000";
    try {
      const mockNotion = createMockNotionClient();
      const result = await executeWriteAgentDigest(
        createMockWriteDigestInput(),
        mockNotion
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result).toMatchObject({
          success: true,
          page_url: expect.any(String),
          page_id: expect.any(String),
          title: expect.any(String),
          is_error_titled: expect.any(Boolean),
          is_heartbeat: expect.any(Boolean),
        });
      }
    } finally {
      if (prev !== undefined) process.env.DOCS_DATABASE_ID = prev;
      else delete process.env.DOCS_DATABASE_ID;
    }
  });

  it("returns success:false with error string on invalid agent_name", async () => {
    const mockNotion = createMockNotionClient();
    const result = await executeWriteAgentDigest(
      createMockWriteDigestInput({ agent_name: "Not A Real Agent" }),
      mockNotion
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(typeof result.error).toBe("string");
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("returns success:false when FlaggedItem has neither task_link nor no_task_reason", async () => {
    const mockNotion = createMockNotionClient();
    const result = await executeWriteAgentDigest(
      createMockWriteDigestInput({
        flagged_items: [{ description: "orphaned item" }],
      }),
      mockNotion
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(typeof result.error).toBe("string");
      expect(result.error).toMatch(/task_link|no_task_reason|FlaggedItem/);
    }
  });
});
