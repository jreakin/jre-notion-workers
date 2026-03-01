import { describe, expect, it } from "bun:test";
import { executeCheckUpstreamStatus } from "../../src/workers/check-upstream-status.js";
import { createMockNotionClient } from "../fixtures/mock-notion.js";

describe("check-upstream-status output schema", () => {
  it("returns full output shape with found:false and degraded:true for invalid agent", async () => {
    const mockNotion = createMockNotionClient();
    const result = await executeCheckUpstreamStatus(
      { agent_name: "Not A Real Agent" },
      mockNotion
    );
    expect(result.found).toBe(false);
    expect(result.agent_name).toBe("Not A Real Agent");
    expect(result.status).toBe("not_found");
    expect(result.status_type).toBeNull();
    expect(result.run_time).toBeNull();
    expect(result.run_time_age_hours).toBeNull();
    expect(result.is_stale).toBe(true);
    expect(result.is_heartbeat).toBe(false);
    expect(result.is_error_titled).toBe(false);
    expect(result.page_url).toBeNull();
    expect(result.page_id).toBeNull();
    expect(result.degraded).toBe(true);
    expect(typeof result.data_completeness_notice).toBe("string");
    expect(result.data_completeness_notice.length).toBeGreaterThan(0);
  });

  it("returns full output shape with found:true when mock returns one page with status and run time", async () => {
    const now = new Date();
    const createdTime = now.toISOString();
    const mockPage = {
      id: "mock-page-id-upstream",
      url: "https://www.notion.so/mock-page-id-upstream",
      created_time: createdTime,
      properties: {
        Name: {
          title: [{ plain_text: "🔄 GitHub Sync — 2026-02-28" }],
        },
      },
    };
    const blockLines = [
      "Sync Status: ✅ Complete",
      "Run Time: 2026-02-28 09:00 (America/Chicago)",
      "Scope: Test",
    ];
    const mockBlocks = blockLines.map((text) => ({
      type: "paragraph",
      paragraph: { rich_text: [{ plain_text: text }] },
    }));
    const mockNotion = createMockNotionClient({
      databasesQuery: async () => ({ results: [mockPage], has_more: false }),
      blocksChildrenList: async () => ({ results: mockBlocks }),
    });
    const prev = process.env.DOCS_DATABASE_ID;
    process.env.DOCS_DATABASE_ID = "00000000000000000000000000000000";
    try {
      const result = await executeCheckUpstreamStatus(
        { agent_name: "GitHub Insyncerator", max_age_hours: 168, require_current_cycle: false },
        mockNotion
      );
      expect(result.found).toBe(true);
      expect(result.agent_name).toBe("GitHub Insyncerator");
      expect(result.page_id).toBe("mock-page-id-upstream");
      expect(result.page_url).toBe("https://www.notion.so/mock-page-id-upstream");
      expect(result.status_type).toBe("sync");
      expect(result.status).toBe("complete");
      expect(typeof result.run_time).toBe("string");
      expect(typeof result.data_completeness_notice).toBe("string");
      expect(result).toMatchObject({
        is_heartbeat: false,
        is_error_titled: false,
        degraded: false,
      });
    } finally {
      if (prev !== undefined) process.env.DOCS_DATABASE_ID = prev;
      else delete process.env.DOCS_DATABASE_ID;
    }
  });
});
