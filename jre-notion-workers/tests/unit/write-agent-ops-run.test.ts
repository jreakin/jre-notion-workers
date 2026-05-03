import { describe, expect, it } from "bun:test";
import { executeWriteAgentOpsRun } from "../../src/workers/write-agent-ops-run.js";
import { createMockNotionClient, MOCK_PAGE_ID, MOCK_PAGE_URL } from "../fixtures/mock-notion.js";
import { RUN_STATUS } from "../../src/shared/agent-ops-status.js";

const validInput = {
  agent_name: "Inbox Manager",
  run_date: "2026-04-15",
  status_type: "sync" as const,
  status_value: "complete" as const,
};

describe("write-agent-ops-run", () => {
  it("writes Complete and returns canonical run_status", async () => {
    let capturedProps: Record<string, unknown> = {};
    const mockNotion = createMockNotionClient({
      pagesCreate: async (...args: unknown[]) => {
        const arg = args[0] as { properties?: Record<string, unknown> };
        capturedProps = arg.properties ?? {};
        return { id: MOCK_PAGE_ID, url: MOCK_PAGE_URL };
      },
    });
    const prev = process.env.AGENT_OPS_DATABASE_ID;
    process.env.AGENT_OPS_DATABASE_ID = "00000000000000000000000000000077";
    try {
      const r = await executeWriteAgentOpsRun(validInput, mockNotion);
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.run_status).toBe(RUN_STATUS.COMPLETE);
        expect(r.coerced_to_heartbeat).toBe(false);
      }
      const status = capturedProps["Run Status"] as { select: { name: string } };
      expect(status.select.name).toBe(RUN_STATUS.COMPLETE);
    } finally {
      if (prev !== undefined) process.env.AGENT_OPS_DATABASE_ID = prev;
      else delete process.env.AGENT_OPS_DATABASE_ID;
    }
  });

  it("coerces zero-actionable Partial input to Heartbeat (Complete)", async () => {
    let capturedProps: Record<string, unknown> = {};
    const mockNotion = createMockNotionClient({
      pagesCreate: async (...args: unknown[]) => {
        const arg = args[0] as { properties?: Record<string, unknown> };
        capturedProps = arg.properties ?? {};
        return { id: MOCK_PAGE_ID, url: MOCK_PAGE_URL };
      },
    });
    const prev = process.env.AGENT_OPS_DATABASE_ID;
    process.env.AGENT_OPS_DATABASE_ID = "00000000000000000000000000000077";
    try {
      const r = await executeWriteAgentOpsRun(
        {
          ...validInput,
          status_value: "partial",
          flagged_count: 0,
          needs_review_count: 0,
          escalation_count: 0,
        },
        mockNotion
      );
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.run_status).toBe(RUN_STATUS.HEARTBEAT);
        expect(r.coerced_to_heartbeat).toBe(true);
        expect(r.warnings.length).toBeGreaterThan(0);
      }
      const status = capturedProps["Run Status"] as { select: { name: string } };
      expect(status.select.name).toBe(RUN_STATUS.HEARTBEAT);
    } finally {
      if (prev !== undefined) process.env.AGENT_OPS_DATABASE_ID = prev;
      else delete process.env.AGENT_OPS_DATABASE_ID;
    }
  });

  it("does NOT coerce when there are flagged items and status is partial", async () => {
    const mockNotion = createMockNotionClient();
    const prev = process.env.AGENT_OPS_DATABASE_ID;
    process.env.AGENT_OPS_DATABASE_ID = "00000000000000000000000000000077";
    try {
      const r = await executeWriteAgentOpsRun(
        { ...validInput, status_value: "partial", flagged_count: 3 },
        mockNotion
      );
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.run_status).toBe(RUN_STATUS.PARTIAL);
        expect(r.coerced_to_heartbeat).toBe(false);
      }
    } finally {
      if (prev !== undefined) process.env.AGENT_OPS_DATABASE_ID = prev;
      else delete process.env.AGENT_OPS_DATABASE_ID;
    }
  });

  it("rejects unknown agent_name", async () => {
    const mockNotion = createMockNotionClient();
    const r = await executeWriteAgentOpsRun(
      { ...validInput, agent_name: "Robot 9000" },
      mockNotion
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain("Unknown agent_name");
  });

  it("rejects bad run_date", async () => {
    const mockNotion = createMockNotionClient();
    const r = await executeWriteAgentOpsRun(
      { ...validInput, run_date: "tomorrow" },
      mockNotion
    );
    expect(r.success).toBe(false);
  });
});
