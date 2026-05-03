import { describe, expect, it } from "bun:test";
import { executeNormalizeAgentOpsOptions } from "../../src/workers/normalize-agent-ops-options.js";
import { createMockNotionClient } from "../fixtures/mock-notion.js";

function row(id: string, status: string | null) {
  const properties: Record<string, unknown> = {
    Title: { title: [{ plain_text: id }] },
    "Agent Name": { select: { name: "Inbox Manager" } },
  };
  if (status !== null) properties["Run Status"] = { select: { name: status } };
  return { id, url: `https://www.notion.so/${id}`, properties };
}

describe("normalize-agent-ops-options", () => {
  it("identifies normalizable rows in dry-run", async () => {
    const mockNotion = createMockNotionClient({
      databasesQuery: async () => ({
        results: [
          row("a", "complete"),
          row("b", "✅ Complete"),
          row("c", "warning"),
          row("d", "Random Text"),
          row("e", null),
        ],
        has_more: false,
      }),
    });
    const prev = process.env.AGENT_OPS_DATABASE_ID;
    process.env.AGENT_OPS_DATABASE_ID = "00000000000000000000000000000077";
    try {
      const r = await executeNormalizeAgentOpsOptions({ dry_run: true }, mockNotion);
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.total_scanned).toBe(5);
        expect(r.total_normalized).toBe(2); // a (complete), c (warning)
        expect(r.total_skipped).toBe(1); // b
        expect(r.total_needs_review).toBe(2); // d, e
      }
    } finally {
      if (prev !== undefined) process.env.AGENT_OPS_DATABASE_ID = prev;
      else delete process.env.AGENT_OPS_DATABASE_ID;
    }
  });

  it("calls pages.update when not dry-run", async () => {
    let updates = 0;
    const mockNotion = createMockNotionClient({
      databasesQuery: async () => ({
        results: [row("a", "complete"), row("b", "fail")],
        has_more: false,
      }),
      pagesUpdate: async () => {
        updates++;
        return {};
      },
    });
    const prev = process.env.AGENT_OPS_DATABASE_ID;
    process.env.AGENT_OPS_DATABASE_ID = "00000000000000000000000000000077";
    try {
      const r = await executeNormalizeAgentOpsOptions({ dry_run: false }, mockNotion);
      expect(r.success).toBe(true);
      expect(updates).toBe(2);
    } finally {
      if (prev !== undefined) process.env.AGENT_OPS_DATABASE_ID = prev;
      else delete process.env.AGENT_OPS_DATABASE_ID;
    }
  });

  it("returns error when AGENT_OPS_DATABASE_ID is not set", async () => {
    const mockNotion = createMockNotionClient();
    const prev = process.env.AGENT_OPS_DATABASE_ID;
    delete process.env.AGENT_OPS_DATABASE_ID;
    try {
      const r = await executeNormalizeAgentOpsOptions({ dry_run: true }, mockNotion);
      expect(r.success).toBe(false);
    } finally {
      if (prev !== undefined) process.env.AGENT_OPS_DATABASE_ID = prev;
    }
  });
});
