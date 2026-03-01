import { describe, expect, it } from "bun:test";
import { executeCreateHandoffMarker } from "../../src/workers/create-handoff-marker.js";
import { createMockNotionClient } from "../fixtures/mock-notion.js";

describe("create-handoff-marker output schema", () => {
  it("returns success:false with error string on invalid source_agent", async () => {
    const mockNotion = createMockNotionClient();
    const result = await executeCreateHandoffMarker(
      {
        source_agent: "Not A Real Agent",
        target_agent: "Client Repo Auditor",
        escalation_reason: "test",
        source_digest_url: "https://notion.so/x",
        create_task: false,
      },
      mockNotion
    );
    expect(result.success).toBe(false);
    expect("error" in result && typeof result.error).toBe("string");
  });

  it("returns success:false when create_task is true but task_priority missing", async () => {
    const mockNotion = createMockNotionClient();
    const result = await executeCreateHandoffMarker(
      {
        source_agent: "GitHub Insyncerator",
        target_agent: "Client Repo Auditor",
        escalation_reason: "test",
        source_digest_url: "https://notion.so/x",
        create_task: true,
        // task_priority omitted
      },
      mockNotion
    );
    expect(result.success).toBe(false);
    expect("error" in result && result.error).toMatch(/task_priority/);
  });

  it("returns success:true with handoff_block when create_task is false", async () => {
    const mockNotion = createMockNotionClient();
    const result = await executeCreateHandoffMarker(
      {
        source_agent: "GitHub Insyncerator",
        target_agent: "Client Repo Auditor",
        escalation_reason: "test reason",
        source_digest_url: "https://notion.so/x",
        create_task: false,
      },
      mockNotion
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(typeof result.handoff_block).toBe("string");
      expect(result.handoff_block).toContain("Escalated To: Client Repo Auditor");
      expect(result.handoff_block).toContain("Escalation Reason: test reason");
      expect(result.task_created).toBe(false);
      expect(result.duplicate_prevented).toBe(false);
      expect(result.escalation_capped).toBe(false);
      expect(result.needs_manual_review).toBe(false);
    }
  });
});
