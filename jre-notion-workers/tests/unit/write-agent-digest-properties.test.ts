import { describe, expect, it } from "bun:test";
import { buildDocCreateProperties } from "../../src/workers/write-agent-digest.js";
import { DOC_TRIAGE_STATUS, DOC_TYPE_AI_CODEBASE_ASSESSMENT } from "../../src/shared/notion-schema.js";

describe("buildDocCreateProperties", () => {
  it("sets Needs Triage status for AI Codebase Assessment docs", () => {
    const props = buildDocCreateProperties({
      title: "QR Assessment",
      docType: DOC_TYPE_AI_CODEBASE_ASSESSMENT,
      isHomeDocs: false,
      clientRelationIds: ["client-1"],
    });

    expect(props.Status).toEqual({ status: { name: DOC_TRIAGE_STATUS } });
    expect(props.Clients).toEqual({ relation: [{ id: "client-1" }] });
  });

  it("does not set triage status for agent digests", () => {
    const props = buildDocCreateProperties({
      title: "GitHub Sync",
      docType: "Agent Digest",
      isHomeDocs: false,
    });

    expect(props.Status).toBeUndefined();
  });
});
