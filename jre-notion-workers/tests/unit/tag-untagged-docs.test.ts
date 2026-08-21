import { describe, expect, it } from "bun:test";
import { executeTagUntaggedDocs } from "../../src/workers/tag-untagged-docs.js";
import { createMockNotionClient } from "../fixtures/mock-notion.js";

describe("tag-untagged-docs", () => {
  it("does not auto-tag assessment titles as Report", async () => {
    process.env.DOCS_DATABASE_ID = "docs-db-id";
    const mockNotion = createMockNotionClient({
      databasesQuery: async () => ({
        results: [
          {
            id: "page-1",
            properties: {
              Name: { title: [{ plain_text: "QR AI Codebase Assessment — repo" }] },
            },
          },
        ],
        has_more: false,
        next_cursor: null,
      }),
    });

    const result = await executeTagUntaggedDocs(
      { target_database: "docs", dry_run: true, max_pages: 10 },
      mockNotion
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.total_needs_review).toBe(1);
      expect(result.results[0]?.inferred_type).toBeNull();
      expect(result.results[0]?.inference_rule).toBe("assessment_quarantine");
    }
  });
});
