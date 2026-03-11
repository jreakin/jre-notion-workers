import { describe, expect, it } from "bun:test";
import { executeResolveStaleDeadLetters } from "../../src/workers/resolve-stale-dead-letters.js";
import { createMockNotionClient } from "../fixtures/mock-notion.js";

function makeMockDeadLetter(id: string, agentName: string, failureType: string, expectedDate: string) {
  return {
    id,
    url: `https://www.notion.so/${id}`,
    properties: {
      Title: { title: [{ plain_text: `${agentName} — ${expectedDate} — ${failureType}` }] },
      "Agent Name": { select: { name: agentName } },
      "Failure Type": { select: { name: failureType } },
      "Expected Run Date": { date: { start: expectedDate } },
      "Resolution Status": { select: { name: "Open" } },
    },
  };
}

describe("resolve-stale-dead-letters", () => {
  it("returns error for empty agent_name", async () => {
    const result = await executeResolveStaleDeadLetters(
      { agent_name: "", successful_run_date: "2026-03-09" },
      createMockNotionClient()
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("agent_name");
  });

  it("returns error for invalid date", async () => {
    const result = await executeResolveStaleDeadLetters(
      { agent_name: "GitHub Insyncerator", successful_run_date: "not-a-date" },
      createMockNotionClient()
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("successful_run_date");
  });

  it("returns error for invalid failure type", async () => {
    const result = await executeResolveStaleDeadLetters(
      { agent_name: "GitHub Insyncerator", successful_run_date: "2026-03-09", resolvable_failure_types: ["Not Real"] },
      createMockNotionClient()
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("Invalid failure type");
  });

  it("resolves matching open dead letters", async () => {
    const prev = process.env.DEAD_LETTERS_DATABASE_ID;
    process.env.DEAD_LETTERS_DATABASE_ID = "00000000000000000000000000000099";
    try {
      const mockRecords = [
        makeMockDeadLetter("dl-1", "GitHub Insyncerator", "Stale Snapshot", "2026-03-07"),
        makeMockDeadLetter("dl-2", "GitHub Insyncerator", "Stale Snapshot", "2026-03-08"),
        makeMockDeadLetter("dl-3", "GitHub Insyncerator", "Missing Digest", "2026-03-06"),
      ];

      const mockNotion = createMockNotionClient({
        databasesQuery: async () => ({ results: mockRecords, has_more: false }),
      });

      const result = await executeResolveStaleDeadLetters(
        { agent_name: "GitHub Insyncerator", successful_run_date: "2026-03-09" },
        mockNotion
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.total_open_found).toBe(3);
        expect(result.total_resolved).toBe(3);
        expect(result.total_errors).toBe(0);
        expect(result.records.every((r) => r.resolved)).toBe(true);
      }
    } finally {
      if (prev !== undefined) process.env.DEAD_LETTERS_DATABASE_ID = prev;
      else delete process.env.DEAD_LETTERS_DATABASE_ID;
    }
  });

  it("dry run finds but does not modify records", async () => {
    const prev = process.env.DEAD_LETTERS_DATABASE_ID;
    process.env.DEAD_LETTERS_DATABASE_ID = "00000000000000000000000000000099";
    try {
      const mockRecords = [
        makeMockDeadLetter("dl-1", "GitHub Insyncerator", "Stale Snapshot", "2026-03-07"),
      ];

      const mockNotion = createMockNotionClient({
        databasesQuery: async () => ({ results: mockRecords, has_more: false }),
      });

      const result = await executeResolveStaleDeadLetters(
        { agent_name: "GitHub Insyncerator", successful_run_date: "2026-03-09", dry_run: true },
        mockNotion
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.total_open_found).toBe(1);
        expect(result.total_resolved).toBe(0);
        expect(result.records[0]?.resolved).toBe(false);
        expect(result.summary).toContain("DRY RUN");
      }
    } finally {
      if (prev !== undefined) process.env.DEAD_LETTERS_DATABASE_ID = prev;
      else delete process.env.DEAD_LETTERS_DATABASE_ID;
    }
  });

  it("returns success with zero records when none match", async () => {
    const prev = process.env.DEAD_LETTERS_DATABASE_ID;
    process.env.DEAD_LETTERS_DATABASE_ID = "00000000000000000000000000000099";
    try {
      const result = await executeResolveStaleDeadLetters(
        { agent_name: "GitHub Insyncerator", successful_run_date: "2026-03-09" },
        createMockNotionClient()
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.total_open_found).toBe(0);
        expect(result.records.length).toBe(0);
      }
    } finally {
      if (prev !== undefined) process.env.DEAD_LETTERS_DATABASE_ID = prev;
      else delete process.env.DEAD_LETTERS_DATABASE_ID;
    }
  });

  it("accepts custom resolvable failure types", async () => {
    const prev = process.env.DEAD_LETTERS_DATABASE_ID;
    process.env.DEAD_LETTERS_DATABASE_ID = "00000000000000000000000000000099";
    try {
      const mockRecords = [
        makeMockDeadLetter("dl-1", "Docs Librarian", "Partial Run", "2026-03-07"),
      ];

      const mockNotion = createMockNotionClient({
        databasesQuery: async () => ({ results: mockRecords, has_more: false }),
      });

      const result = await executeResolveStaleDeadLetters(
        {
          agent_name: "Docs Librarian",
          successful_run_date: "2026-03-09",
          resolvable_failure_types: ["Stale Snapshot", "Missing Digest", "Partial Run"],
        },
        mockNotion
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.total_resolved).toBe(1);
      }
    } finally {
      if (prev !== undefined) process.env.DEAD_LETTERS_DATABASE_ID = prev;
      else delete process.env.DEAD_LETTERS_DATABASE_ID;
    }
  });
});
