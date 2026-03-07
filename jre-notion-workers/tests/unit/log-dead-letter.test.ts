import { describe, expect, it } from "bun:test";
import { executeLogDeadLetter } from "../../src/workers/log-dead-letter.js";
import { createMockNotionClient, MOCK_PAGE_ID, MOCK_PAGE_URL } from "../fixtures/mock-notion.js";
import { createMockLogDeadLetterInput } from "../fixtures/mock-inputs.js";

describe("log-dead-letter", () => {
  it("returns error for empty agent_name", async () => {
    const mockNotion = createMockNotionClient();
    const result = await executeLogDeadLetter(
      createMockLogDeadLetterInput({ agent_name: "" }),
      mockNotion
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("agent_name");
    }
  });

  it("returns error for empty expected_run_date", async () => {
    const mockNotion = createMockNotionClient();
    const result = await executeLogDeadLetter(
      createMockLogDeadLetterInput({ expected_run_date: "" }),
      mockNotion
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("expected_run_date");
    }
  });

  it("returns error for invalid failure_type", async () => {
    const mockNotion = createMockNotionClient();
    const result = await executeLogDeadLetter(
      createMockLogDeadLetterInput({ failure_type: "Not Real" as never }),
      mockNotion
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("failure_type");
    }
  });

  it("returns error for invalid detected_by", async () => {
    const mockNotion = createMockNotionClient();
    const result = await executeLogDeadLetter(
      createMockLogDeadLetterInput({ detected_by: "Robot" as never }),
      mockNotion
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("detected_by");
    }
  });

  it("returns error for empty notes", async () => {
    const mockNotion = createMockNotionClient();
    const result = await executeLogDeadLetter(
      createMockLogDeadLetterInput({ notes: "" }),
      mockNotion
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("notes");
    }
  });

  it("creates a Dead Letter record with correct shape on success", async () => {
    const mockNotion = createMockNotionClient();
    const prev = process.env.DEAD_LETTERS_DATABASE_ID;
    process.env.DEAD_LETTERS_DATABASE_ID = "00000000000000000000000000000099";
    try {
      const result = await executeLogDeadLetter(
        createMockLogDeadLetterInput(),
        mockNotion
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.record_id).toBe(MOCK_PAGE_ID);
        expect(result.record_url).toBe(MOCK_PAGE_URL);
      }
    } finally {
      if (prev !== undefined) process.env.DEAD_LETTERS_DATABASE_ID = prev;
      else delete process.env.DEAD_LETTERS_DATABASE_ID;
    }
  });

  it("creates record with linked task when linked_task_id is provided", async () => {
    let capturedProps: Record<string, unknown> = {};
    const mockNotion = createMockNotionClient({
      pagesCreate: async (...args: unknown[]) => {
        const arg = args[0] as { properties?: Record<string, unknown> };
        capturedProps = arg?.properties ?? {};
        return { id: MOCK_PAGE_ID, url: MOCK_PAGE_URL };
      },
    });
    const prev = process.env.DEAD_LETTERS_DATABASE_ID;
    process.env.DEAD_LETTERS_DATABASE_ID = "00000000000000000000000000000099";
    try {
      const result = await executeLogDeadLetter(
        createMockLogDeadLetterInput({ linked_task_id: "task-id-123" }),
        mockNotion
      );
      expect(result.success).toBe(true);
      expect(capturedProps["Linked Task"]).toEqual({ relation: [{ id: "task-id-123" }] });
    } finally {
      if (prev !== undefined) process.env.DEAD_LETTERS_DATABASE_ID = prev;
      else delete process.env.DEAD_LETTERS_DATABASE_ID;
    }
  });
});
