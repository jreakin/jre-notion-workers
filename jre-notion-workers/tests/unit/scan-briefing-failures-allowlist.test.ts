import { describe, expect, it } from "bun:test";
import {
  parseFailureLine,
  isValidBriefingAgentCandidate,
} from "../../src/workers/scan-briefing-failures.js";

describe("parser-artifact rejection", () => {
  it("rejects 'Report Status' as an agent name", () => {
    expect(parseFailureLine("Report Status: ❌ Failed")).toBeNull();
    expect(parseFailureLine("- Report Status — ❌ Failed")).toBeNull();
    expect(isValidBriefingAgentCandidate("Report Status")).toBe(false);
  });
  it("rejects 'Sync Status' and 'Snapshot Status'", () => {
    expect(parseFailureLine("- Sync Status — ⚠️ Partial")).toBeNull();
    expect(parseFailureLine("- Snapshot Status — ❌ Failed")).toBeNull();
  });
  it("accepts known agent names", () => {
    expect(isValidBriefingAgentCandidate("Inbox Manager")).toBe(true);
    expect(isValidBriefingAgentCandidate("Docs Librarian")).toBe(true);
    const r = parseFailureLine("- GitHub Insyncerator — ❌ Failed");
    expect(r?.agent_name).toBe("GitHub Insyncerator");
    expect(r?.failure_type).toBe("Failed Run");
  });
  it("rejects unknown free-form names", () => {
    expect(isValidBriefingAgentCandidate("Some Random Agent Name")).toBe(false);
    expect(parseFailureLine("⚠️ Some Random Agent Name — no digest found")).toBeNull();
  });
});
