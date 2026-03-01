import { describe, expect, it } from "bun:test";
import {
  VALID_AGENT_NAMES,
  AGENT_DIGEST_PATTERNS,
  AGENT_TARGET_DB,
  isValidAgentName,
  getDefaultDigestType,
} from "../../../src/shared/agent-config.js";

describe("agent-config", () => {
  it("VALID_AGENT_NAMES includes all 11 agents", () => {
    expect(VALID_AGENT_NAMES).toContain("GitHub Insyncerator");
    expect(VALID_AGENT_NAMES).toContain("Morning Briefing");
    expect(VALID_AGENT_NAMES.length).toBe(11);
  });

  it("AGENT_DIGEST_PATTERNS maps agent to title pattern", () => {
    expect(AGENT_DIGEST_PATTERNS["GitHub Insyncerator"]).toEqual(["GitHub Sync"]);
    expect(AGENT_DIGEST_PATTERNS["Docs Librarian"]).toEqual(["Docs Quick Scan", "Docs Cleanup Report"]);
  });

  it("AGENT_TARGET_DB maps home_docs for Personal Ops and Home & Life", () => {
    expect(AGENT_TARGET_DB["Personal Ops Manager"]).toBe("home_docs");
    expect(AGENT_TARGET_DB["Home & Life Watcher"]).toBe("home_docs");
    expect(AGENT_TARGET_DB["GitHub Insyncerator"]).toBe("docs");
  });

  it("isValidAgentName", () => {
    expect(isValidAgentName("GitHub Insyncerator")).toBe(true);
    expect(isValidAgentName("Not A Real Agent")).toBe(false);
  });

  it("getDefaultDigestType returns first pattern", () => {
    expect(getDefaultDigestType("GitHub Insyncerator")).toBe("GitHub Sync");
    expect(getDefaultDigestType("Docs Librarian")).toBe("Docs Quick Scan");
  });
});
