import { describe, expect, it, mock } from "bun:test";
import { executeLogDeadLetter } from "../../src/workers/log-dead-letter.js";
import { createMockNotionClient, MOCK_PAGE_ID, MOCK_PAGE_URL } from "../fixtures/mock-notion.js";
import { createMockLogDeadLetterInput } from "../fixtures/mock-inputs.js";

describe("log-dead-letter dedupe", () => {
  it("returns existing record when an Open duplicate is found and does NOT create a new one", async () => {
    const existingId = "existing-open-page";
    const existingUrl = "https://www.notion.so/existing-open-page";

    let createCalls = 0;
    let queryCalls = 0;

    const mockNotion = createMockNotionClient({
      databasesQuery: async () => {
        queryCalls++;
        return { results: [{ id: existingId, url: existingUrl }], has_more: false };
      },
      pagesCreate: async () => {
        createCalls++;
        return { id: MOCK_PAGE_ID, url: MOCK_PAGE_URL };
      },
    });

    const prev = process.env.DEAD_LETTERS_DATABASE_ID;
    process.env.DEAD_LETTERS_DATABASE_ID = "00000000000000000000000000000099";
    try {
      const result = await executeLogDeadLetter(createMockLogDeadLetterInput(), mockNotion);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.deduped).toBe(true);
        expect(result.record_id).toBe(existingId);
        expect(result.record_url).toBe(existingUrl);
      }
      expect(queryCalls).toBe(1);
      expect(createCalls).toBe(0);
    } finally {
      if (prev !== undefined) process.env.DEAD_LETTERS_DATABASE_ID = prev;
      else delete process.env.DEAD_LETTERS_DATABASE_ID;
    }
  });

  it("creates a new record when no duplicate exists, returning deduped=false", async () => {
    let createCalls = 0;
    const mockNotion = createMockNotionClient({
      databasesQuery: async () => ({ results: [], has_more: false }),
      pagesCreate: async () => {
        createCalls++;
        return { id: MOCK_PAGE_ID, url: MOCK_PAGE_URL };
      },
    });

    const prev = process.env.DEAD_LETTERS_DATABASE_ID;
    process.env.DEAD_LETTERS_DATABASE_ID = "00000000000000000000000000000099";
    try {
      const result = await executeLogDeadLetter(createMockLogDeadLetterInput(), mockNotion);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.deduped).toBe(false);
        expect(result.record_id).toBe(MOCK_PAGE_ID);
      }
      expect(createCalls).toBe(1);
    } finally {
      if (prev !== undefined) process.env.DEAD_LETTERS_DATABASE_ID = prev;
      else delete process.env.DEAD_LETTERS_DATABASE_ID;
    }
  });

  it("falls back to create when dedupe query throws", async () => {
    let createCalls = 0;
    const mockNotion = createMockNotionClient({
      databasesQuery: async () => {
        throw new Error("filter shape mismatch");
      },
      pagesCreate: async () => {
        createCalls++;
        return { id: MOCK_PAGE_ID, url: MOCK_PAGE_URL };
      },
    });

    const prev = process.env.DEAD_LETTERS_DATABASE_ID;
    process.env.DEAD_LETTERS_DATABASE_ID = "00000000000000000000000000000099";
    try {
      const result = await executeLogDeadLetter(createMockLogDeadLetterInput(), mockNotion);
      expect(result.success).toBe(true);
      if (result.success) expect(result.deduped).toBe(false);
      expect(createCalls).toBe(1);
    } finally {
      if (prev !== undefined) process.env.DEAD_LETTERS_DATABASE_ID = prev;
      else delete process.env.DEAD_LETTERS_DATABASE_ID;
    }
  });
});
