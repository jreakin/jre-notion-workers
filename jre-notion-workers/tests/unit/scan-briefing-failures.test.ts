import { describe, expect, it } from "bun:test";
import { executeScanBriefingFailures } from "../../src/workers/scan-briefing-failures.js";
import { parseFailureLine } from "../../src/workers/scan-briefing-failures.js";
import { createMockNotionClient } from "../fixtures/mock-notion.js";

describe("parseFailureLine", () => {
  it("detects missing digest signal", () => {
    const result = parseFailureLine("⚠️ GitHub Insyncerator — no digest found");
    expect(result).not.toBeNull();
    expect(result?.agent_name).toBe("GitHub Insyncerator");
    expect(result?.failure_type).toBe("Missing Digest");
  });

  it("detects partial run signal", () => {
    const result = parseFailureLine("- Inbox Manager — ⚠️ Partial");
    expect(result).not.toBeNull();
    expect(result?.agent_name).toBe("Inbox Manager");
    expect(result?.failure_type).toBe("Partial Run");
  });

  it("detects failed run signal", () => {
    const result = parseFailureLine("- Docs Librarian — ❌ Failed");
    expect(result).not.toBeNull();
    expect(result?.agent_name).toBe("Docs Librarian");
    expect(result?.failure_type).toBe("Failed Run");
  });

  it("detects stale snapshot signal", () => {
    const result = parseFailureLine("- Client Health Scorecard — snapshot stale for current cycle");
    expect(result).not.toBeNull();
    expect(result?.agent_name).toBe("Client Health Scorecard");
    expect(result?.failure_type).toBe("Stale Snapshot");
  });

  it("returns null for clean lines", () => {
    expect(parseFailureLine("✅ All agents current")).toBeNull();
    expect(parseFailureLine("Inbox Manager — ✅ Complete")).toBeNull();
    expect(parseFailureLine("## Agent Run Summary")).toBeNull();
    expect(parseFailureLine("")).toBeNull();
  });
});

describe("scan-briefing-failures", () => {
  it("returns briefing_found:false when no Morning Briefing exists", async () => {
    const mockNotion = createMockNotionClient();
    const prev = process.env.DOCS_DATABASE_ID;
    process.env.DOCS_DATABASE_ID = "00000000000000000000000000000000";
    try {
      const result = await executeScanBriefingFailures(
        { briefing_date: "2026-03-06" },
        mockNotion
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.briefing_found).toBe(false);
        expect(result.failures).toHaveLength(0);
        expect(result.total_failures).toBe(0);
      }
    } finally {
      if (prev !== undefined) process.env.DOCS_DATABASE_ID = prev;
      else delete process.env.DOCS_DATABASE_ID;
    }
  });

  it("extracts failures from Morning Briefing blocks", async () => {
    const mockPage = {
      id: "mock-briefing-page",
      url: "https://www.notion.so/mock-briefing-page",
    };
    const blockTexts = [
      "Report Status: ✅ Complete",
      "## Agent Run Summary",
      "⚠️ GitHub Insyncerator — no digest found",
      "- Docs Librarian — ❌ Failed",
      "✅ Inbox Manager — current",
      "- Time Log Auditor — ⚠️ Partial",
    ];
    const mockBlocks = blockTexts.map((text) => ({
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
      const result = await executeScanBriefingFailures(
        { briefing_date: "2026-03-06" },
        mockNotion
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.briefing_found).toBe(true);
        expect(result.briefing_page_url).toBe("https://www.notion.so/mock-briefing-page");
        expect(result.total_failures).toBe(3);
        expect(result.failures).toHaveLength(3);

        const missing = result.failures.find((f) => f.failure_type === "Missing Digest");
        expect(missing?.agent_name).toBe("GitHub Insyncerator");

        const failed = result.failures.find((f) => f.failure_type === "Failed Run");
        expect(failed?.agent_name).toBe("Docs Librarian");

        const partial = result.failures.find((f) => f.failure_type === "Partial Run");
        expect(partial?.agent_name).toBe("Time Log Auditor");
      }
    } finally {
      if (prev !== undefined) process.env.DOCS_DATABASE_ID = prev;
      else delete process.env.DOCS_DATABASE_ID;
    }
  });

  it("returns zero failures for a clean briefing", async () => {
    const mockPage = {
      id: "mock-clean-briefing",
      url: "https://www.notion.so/mock-clean-briefing",
    };
    const blockTexts = [
      "Report Status: ✅ Complete",
      "## Agent Run Summary",
      "✅ All agents current, no issues",
    ];
    const mockBlocks = blockTexts.map((text) => ({
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
      const result = await executeScanBriefingFailures(
        { briefing_date: "2026-03-06" },
        mockNotion
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.briefing_found).toBe(true);
        expect(result.total_failures).toBe(0);
        expect(result.failures).toHaveLength(0);
      }
    } finally {
      if (prev !== undefined) process.env.DOCS_DATABASE_ID = prev;
      else delete process.env.DOCS_DATABASE_ID;
    }
  });
});
