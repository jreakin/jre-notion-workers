import { describe, expect, it } from "bun:test";
import {
  checkDocsMissingClient,
  executeValidateRelationIntegrity,
  readTitle,
} from "../../src/workers/validate-relation-integrity.js";
import { createMockNotionClient } from "../fixtures/mock-notion.js";

describe("validate-relation-integrity", () => {
  it("readTitle checks multiple property names", () => {
    expect(readTitle({ Name: { title: [{ plain_text: "Hello" }] } }, "Name", "Task Name")).toBe(
      "Hello"
    );
  });

  it("flags docs missing Clients in dry run", async () => {
    process.env.DOCS_DATABASE_ID = "docs-db-id";

    const mockNotion = createMockNotionClient({
      databasesQuery: async () => ({
        results: [
          {
            id: "doc-1",
            properties: {
              Name: { title: [{ plain_text: "Untitled assessment" }] },
              Clients: { relation: [] },
            },
          },
        ],
        has_more: false,
        next_cursor: null,
      }),
    });

    const issues = await checkDocsMissingClient(mockNotion, 10);
    expect(issues.length).toBe(1);
    expect(issues[0]?.rule).toBe("docs_missing_client");
  });

  it("returns dry-run summary without writes", async () => {
    process.env.DOCS_DATABASE_ID = "docs-db-id";
    process.env.TASKS_DATABASE_ID = "tasks-db-id";
    process.env.PROJECTS_DATABASE_ID = "projects-db-id";
    process.env.CLIENTS_DATABASE_ID = "clients-db-id";

    const mockNotion = createMockNotionClient({
      databasesQuery: async () => ({
        results: [],
        has_more: false,
        next_cursor: null,
      }),
    });

    const result = await executeValidateRelationIntegrity(
      { dry_run: true, check_parked_children: false },
      mockNotion
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.dry_run).toBe(true);
      expect(result.summary).toContain("[DRY RUN]");
    }
  });
});
