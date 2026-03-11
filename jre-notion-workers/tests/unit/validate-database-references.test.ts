import { describe, expect, it } from "bun:test";
import { executeValidateDatabaseReferences } from "../../src/workers/validate-database-references.js";
import { createMockNotionClient, MOCK_PAGE_ID, MOCK_PAGE_URL } from "../fixtures/mock-notion.js";
import { APIResponseError } from "@notionhq/client";

describe("validate-database-references", () => {
  it("returns error for empty references array", async () => {
    const result = await executeValidateDatabaseReferences(
      { references: [] },
      createMockNotionClient()
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("references array is required");
  });

  it("returns error for missing database_id", async () => {
    const result = await executeValidateDatabaseReferences(
      { references: [{ database_id: "", label: "Test DB" }] },
      createMockNotionClient()
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("database_id is required");
  });

  it("returns error for missing label", async () => {
    const result = await executeValidateDatabaseReferences(
      { references: [{ database_id: "abc123", label: "" }] },
      createMockNotionClient()
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("label is required");
  });

  it("reports all accessible when databases exist", async () => {
    const mockNotion = createMockNotionClient({
      databasesRetrieve: async () => ({
        id: "mock-db",
        properties: { Name: { type: "title" }, Status: { type: "status" }, Date: { type: "date" } },
      }),
    });

    const result = await executeValidateDatabaseReferences(
      {
        references: [
          { database_id: "aaaa0000bbbb1111cccc2222dddd3333", label: "Docs DB" },
          { database_id: "eeee4444ffff5555aaaa6666bbbb7777", label: "Tasks DB" },
        ],
      },
      mockNotion
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.total_checked).toBe(2);
      expect(result.total_accessible).toBe(2);
      expect(result.total_broken).toBe(0);
      expect(result.broken_references.length).toBe(0);
    }
  });

  it("detects broken (404) database reference", async () => {
    let callCount = 0;
    const mockNotion = createMockNotionClient({
      databasesRetrieve: async () => {
        callCount++;
        if (callCount === 2) {
          const err = new APIResponseError({
            code: "object_not_found",
            message: "Could not find database",
            status: 404,
            headers: {},
            rawBodyText: "",
          });
          throw err;
        }
        return { id: "mock-db", properties: { Name: { type: "title" } } };
      },
    });

    const result = await executeValidateDatabaseReferences(
      {
        references: [
          { database_id: "aaaa0000bbbb1111cccc2222dddd3333", label: "Docs DB" },
          { database_id: "d125ed60c25048e2a3ff724cd952f5be", label: "Home Tasks DB", used_by: ["Personal Ops Manager"] },
        ],
      },
      mockNotion
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.total_checked).toBe(2);
      expect(result.total_accessible).toBe(1);
      expect(result.total_broken).toBe(1);
      expect(result.broken_references[0]?.label).toBe("Home Tasks DB");
      expect(result.broken_references[0]?.status_code).toBe(404);
    }
  });

  it("includes property_count when check_schema is true", async () => {
    const mockNotion = createMockNotionClient({
      databasesRetrieve: async () => ({
        id: "mock-db",
        properties: { Name: { type: "title" }, Status: { type: "status" }, Date: { type: "date" } },
      }),
    });

    const result = await executeValidateDatabaseReferences(
      {
        references: [{ database_id: "aaaa0000bbbb1111cccc2222dddd3333", label: "Docs DB" }],
        check_schema: true,
      },
      mockNotion
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.results[0]?.property_count).toBe(3);
    }
  });

  it("property_count is null when check_schema is false", async () => {
    const result = await executeValidateDatabaseReferences(
      {
        references: [{ database_id: "aaaa0000bbbb1111cccc2222dddd3333", label: "Docs DB" }],
        check_schema: false,
      },
      createMockNotionClient()
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.results[0]?.property_count).toBeNull();
    }
  });

  it("logs dead letters for broken references when enabled", async () => {
    const prev = process.env.DEAD_LETTERS_DATABASE_ID;
    process.env.DEAD_LETTERS_DATABASE_ID = "00000000000000000000000000000099";
    try {
      let createCalled = 0;
      const mockNotion = createMockNotionClient({
        databasesRetrieve: async () => {
          const err = new APIResponseError({
            code: "object_not_found",
            message: "Could not find database",
            status: 404,
            headers: {},
            rawBodyText: "",
          });
          throw err;
        },
        pagesCreate: async () => {
          createCalled++;
          return { id: MOCK_PAGE_ID, url: MOCK_PAGE_URL };
        },
      });

      const result = await executeValidateDatabaseReferences(
        {
          references: [{ database_id: "bad-id-1234", label: "Broken DB", used_by: ["Fleet Ops Agent"] }],
          log_dead_letters: true,
        },
        mockNotion
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.total_broken).toBe(1);
        expect(result.dead_letters_logged).toBe(1);
        expect(createCalled).toBe(1);
      }
    } finally {
      if (prev !== undefined) process.env.DEAD_LETTERS_DATABASE_ID = prev;
      else delete process.env.DEAD_LETTERS_DATABASE_ID;
    }
  });
});
