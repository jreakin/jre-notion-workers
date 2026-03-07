import { describe, expect, it } from "bun:test";
import { executeMonitorFleetStatus } from "../../src/workers/monitor-fleet-status.js";
import { createMockNotionClient } from "../fixtures/mock-notion.js";

describe("monitor-fleet-status", () => {
  it("returns success:false when all requested agents are invalid", async () => {
    const mockNotion = createMockNotionClient();
    const prev = process.env.DOCS_DATABASE_ID;
    const prevHome = process.env.HOME_DOCS_DATABASE_ID;
    process.env.DOCS_DATABASE_ID = "00000000000000000000000000000000";
    process.env.HOME_DOCS_DATABASE_ID = "00000000000000000000000000000001";
    try {
      const result = await executeMonitorFleetStatus(
        { agent_names: ["Not A Real Agent", "Also Fake"] },
        mockNotion
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("No valid agents");
      }
    } finally {
      if (prev !== undefined) process.env.DOCS_DATABASE_ID = prev;
      else delete process.env.DOCS_DATABASE_ID;
      if (prevHome !== undefined) process.env.HOME_DOCS_DATABASE_ID = prevHome;
      else delete process.env.HOME_DOCS_DATABASE_ID;
    }
  });

  it("returns not_found for all agents when no digests exist", async () => {
    const mockNotion = createMockNotionClient();
    const prev = process.env.DOCS_DATABASE_ID;
    const prevHome = process.env.HOME_DOCS_DATABASE_ID;
    process.env.DOCS_DATABASE_ID = "00000000000000000000000000000000";
    process.env.HOME_DOCS_DATABASE_ID = "00000000000000000000000000000001";
    try {
      const result = await executeMonitorFleetStatus(
        { agent_names: ["Inbox Manager", "Morning Briefing"] },
        mockNotion
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.agents).toHaveLength(2);
        expect(result.total_scanned).toBe(2);
        expect(result.total_missing).toBe(2);
        expect(result.total_current).toBe(0);
        expect(result.total_degraded).toBe(2);
        for (const agent of result.agents) {
          expect(agent.found).toBe(false);
          expect(agent.status).toBe("not_found");
          expect(agent.is_degraded).toBe(true);
        }
        expect(result.heartbeat_message).toContain("Fleet Monitor run complete");
        expect(result.heartbeat_message).toContain("2 missing");
      }
    } finally {
      if (prev !== undefined) process.env.DOCS_DATABASE_ID = prev;
      else delete process.env.DOCS_DATABASE_ID;
      if (prevHome !== undefined) process.env.HOME_DOCS_DATABASE_ID = prevHome;
      else delete process.env.HOME_DOCS_DATABASE_ID;
    }
  });

  it("returns found:true with correct status when digests exist", async () => {
    const now = new Date();
    const mockPage = {
      id: "mock-page-fleet",
      url: "https://www.notion.so/mock-page-fleet",
      created_time: now.toISOString(),
      properties: {
        Name: { title: [{ plain_text: "✅ Email Triage — 2026-03-06" }] },
      },
    };
    const blockLines = [
      "Sync Status: ✅ Complete",
      "Run Time: 2026-03-06 09:00 (America/Chicago)",
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
      const result = await executeMonitorFleetStatus(
        { agent_names: ["Inbox Manager"] },
        mockNotion
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.agents).toHaveLength(1);
        const entry = result.agents[0];
        expect(entry?.found).toBe(true);
        expect(entry?.status).toBe("complete");
        expect(entry?.is_degraded).toBe(false);
        expect(entry?.notice).toContain("current");
        expect(result.total_current).toBe(1);
        expect(result.total_degraded).toBe(0);
        expect(result.heartbeat_message).toContain("all agents current");
      }
    } finally {
      if (prev !== undefined) process.env.DOCS_DATABASE_ID = prev;
      else delete process.env.DOCS_DATABASE_ID;
    }
  });

  it("filters out non-monitored agent names from input", async () => {
    const mockNotion = createMockNotionClient();
    const prev = process.env.DOCS_DATABASE_ID;
    process.env.DOCS_DATABASE_ID = "00000000000000000000000000000000";
    try {
      const result = await executeMonitorFleetStatus(
        { agent_names: ["Template Freshness Watcher", "Not Real"] },
        mockNotion
      );
      // Template Freshness Watcher is suspended, "Not Real" is invalid
      expect(result.success).toBe(false);
    } finally {
      if (prev !== undefined) process.env.DOCS_DATABASE_ID = prev;
      else delete process.env.DOCS_DATABASE_ID;
    }
  });
});
