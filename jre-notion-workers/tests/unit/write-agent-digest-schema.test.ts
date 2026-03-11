import { describe, expect, it } from "bun:test";
import { executeWriteAgentDigest } from "../../src/workers/write-agent-digest.js";
import { createMockWriteDigestInput } from "../fixtures/mock-inputs.js";
import { createMockNotionClient } from "../fixtures/mock-notion.js";

describe("write-agent-digest output schema", () => {
  it("returns required fields on success", async () => {
    const prev = process.env.DOCS_DATABASE_ID;
    process.env.DOCS_DATABASE_ID = "00000000000000000000000000000000";
    try {
      const mockNotion = createMockNotionClient();
      const result = await executeWriteAgentDigest(
        createMockWriteDigestInput(),
        mockNotion
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result).toMatchObject({
          success: true,
          page_url: expect.any(String),
          page_id: expect.any(String),
          title: expect.any(String),
          is_error_titled: expect.any(Boolean),
          is_heartbeat: expect.any(Boolean),
        });
      }
    } finally {
      if (prev !== undefined) process.env.DOCS_DATABASE_ID = prev;
      else delete process.env.DOCS_DATABASE_ID;
    }
  });

  it("returns success:false with error string on invalid agent_name", async () => {
    const mockNotion = createMockNotionClient();
    const result = await executeWriteAgentDigest(
      createMockWriteDigestInput({ agent_name: "Not A Real Agent" }),
      mockNotion
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(typeof result.error).toBe("string");
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("returns success:false when FlaggedItem has neither task_link nor no_task_reason", async () => {
    const mockNotion = createMockNotionClient();
    const result = await executeWriteAgentDigest(
      createMockWriteDigestInput({
        flagged_items: [{ description: "orphaned item" }],
      }),
      mockNotion
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(typeof result.error).toBe("string");
      expect(result.error).toMatch(/task_link|no_task_reason|FlaggedItem/);
    }
  });

  it("uses digest_type_override when provided", async () => {
    const prev = process.env.DOCS_DATABASE_ID;
    process.env.DOCS_DATABASE_ID = "00000000000000000000000000000000";
    try {
      const mockNotion = createMockNotionClient();
      const result = await executeWriteAgentDigest(
        createMockWriteDigestInput({
          agent_name: "Docs Librarian",
          agent_emoji: "📚",
          status_type: "snapshot",
          digest_type_override: "Docs Cleanup Report",
        }),
        mockNotion
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.title).toContain("Docs Cleanup Report");
        expect(result.title).not.toContain("Docs Quick Scan");
      }
    } finally {
      if (prev !== undefined) process.env.DOCS_DATABASE_ID = prev;
      else delete process.env.DOCS_DATABASE_ID;
    }
  });

  it("returns error for invalid digest_type_override", async () => {
    const prev = process.env.DOCS_DATABASE_ID;
    process.env.DOCS_DATABASE_ID = "00000000000000000000000000000000";
    try {
      const mockNotion = createMockNotionClient();
      const result = await executeWriteAgentDigest(
        createMockWriteDigestInput({
          agent_name: "Docs Librarian",
          digest_type_override: "Not A Valid Pattern",
        }),
        mockNotion
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("digest_type_override");
        expect(result.error).toContain("Not A Valid Pattern");
      }
    } finally {
      if (prev !== undefined) process.env.DOCS_DATABASE_ID = prev;
      else delete process.env.DOCS_DATABASE_ID;
    }
  });

  it("uses correct property names for docs target", async () => {
    const prev = process.env.DOCS_DATABASE_ID;
    process.env.DOCS_DATABASE_ID = "00000000000000000000000000000000";
    try {
      let capturedProps: Record<string, unknown> = {};
      const mockNotion = createMockNotionClient({
        pagesCreate: async (args: unknown) => {
          capturedProps = (args as { properties: Record<string, unknown> }).properties;
          return { id: "test-id", url: "https://notion.so/test" };
        },
      });
      await executeWriteAgentDigest(
        createMockWriteDigestInput({ target_database: "docs" }),
        mockNotion
      );
      expect(capturedProps).toHaveProperty("Name");
      expect(capturedProps).toHaveProperty("Document Type");
      expect(capturedProps).not.toHaveProperty("Doc");
      expect(capturedProps).not.toHaveProperty("Doc Type");
    } finally {
      if (prev !== undefined) process.env.DOCS_DATABASE_ID = prev;
      else delete process.env.DOCS_DATABASE_ID;
    }
  });

  it("uses correct property names for home_docs target", async () => {
    const prev = process.env.HOME_DOCS_DATABASE_ID;
    process.env.HOME_DOCS_DATABASE_ID = "00000000000000000000000000000000";
    try {
      let capturedProps: Record<string, unknown> = {};
      const mockNotion = createMockNotionClient({
        pagesCreate: async (args: unknown) => {
          capturedProps = (args as { properties: Record<string, unknown> }).properties;
          return { id: "test-id", url: "https://notion.so/test" };
        },
      });
      await executeWriteAgentDigest(
        createMockWriteDigestInput({
          target_database: "home_docs",
          agent_name: "Home & Life Watcher",
          agent_emoji: "🏡",
          status_type: "report",
        }),
        mockNotion
      );
      expect(capturedProps).toHaveProperty("Doc");
      expect(capturedProps).toHaveProperty("Doc Type");
      expect(capturedProps).not.toHaveProperty("Name");
      expect(capturedProps).not.toHaveProperty("Document Type");
    } finally {
      if (prev !== undefined) process.env.HOME_DOCS_DATABASE_ID = prev;
      else delete process.env.HOME_DOCS_DATABASE_ID;
    }
  });

  it("uses 'Clients' (plural) for docs client relation", async () => {
    const prev = process.env.DOCS_DATABASE_ID;
    process.env.DOCS_DATABASE_ID = "00000000000000000000000000000000";
    try {
      let capturedProps: Record<string, unknown> = {};
      const mockNotion = createMockNotionClient({
        pagesCreate: async (args: unknown) => {
          capturedProps = (args as { properties: Record<string, unknown> }).properties;
          return { id: "test-id", url: "https://notion.so/test" };
        },
      });
      await executeWriteAgentDigest(
        createMockWriteDigestInput({
          target_database: "docs",
          client_relation_ids: ["client-id-1"],
        }),
        mockNotion
      );
      expect(capturedProps).toHaveProperty("Clients");
      expect(capturedProps).not.toHaveProperty("Client");
    } finally {
      if (prev !== undefined) process.env.DOCS_DATABASE_ID = prev;
      else delete process.env.DOCS_DATABASE_ID;
    }
  });

  it("omits client relation for home_docs target", async () => {
    const prev = process.env.HOME_DOCS_DATABASE_ID;
    process.env.HOME_DOCS_DATABASE_ID = "00000000000000000000000000000000";
    try {
      let capturedProps: Record<string, unknown> = {};
      const mockNotion = createMockNotionClient({
        pagesCreate: async (args: unknown) => {
          capturedProps = (args as { properties: Record<string, unknown> }).properties;
          return { id: "test-id", url: "https://notion.so/test" };
        },
      });
      await executeWriteAgentDigest(
        createMockWriteDigestInput({
          target_database: "home_docs",
          agent_name: "Home & Life Watcher",
          agent_emoji: "🏡",
          status_type: "report",
          client_relation_ids: ["client-id-1"],
        }),
        mockNotion
      );
      expect(capturedProps).not.toHaveProperty("Client");
      expect(capturedProps).not.toHaveProperty("Clients");
    } finally {
      if (prev !== undefined) process.env.HOME_DOCS_DATABASE_ID = prev;
      else delete process.env.HOME_DOCS_DATABASE_ID;
    }
  });

  it("falls through to default when digest_type_override is null/empty", async () => {
    const prev = process.env.DOCS_DATABASE_ID;
    process.env.DOCS_DATABASE_ID = "00000000000000000000000000000000";
    try {
      const mockNotion = createMockNotionClient();
      const result = await executeWriteAgentDigest(
        createMockWriteDigestInput({
          agent_name: "Docs Librarian",
          agent_emoji: "📚",
          status_type: "snapshot",
          digest_type_override: undefined,
        }),
        mockNotion
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.title).toContain("Docs Quick Scan");
      }
    } finally {
      if (prev !== undefined) process.env.DOCS_DATABASE_ID = prev;
      else delete process.env.DOCS_DATABASE_ID;
    }
  });
});
