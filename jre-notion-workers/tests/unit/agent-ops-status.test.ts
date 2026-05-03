import { describe, expect, it } from "bun:test";
import {
  RUN_STATUS,
  isCanonicalRunStatus,
  mapToRunStatus,
  normalizeStoredStatus,
} from "../../src/shared/agent-ops-status.js";

describe("mapToRunStatus", () => {
  it("maps heartbeat status_type to Heartbeat regardless of value", () => {
    expect(mapToRunStatus("heartbeat", "complete")).toBe(RUN_STATUS.HEARTBEAT);
    expect(mapToRunStatus("heartbeat", "partial")).toBe(RUN_STATUS.HEARTBEAT);
    expect(mapToRunStatus("heartbeat", "failed")).toBe(RUN_STATUS.HEARTBEAT);
  });
  it("maps complete and full_report to ✅ Complete", () => {
    expect(mapToRunStatus("sync", "complete")).toBe(RUN_STATUS.COMPLETE);
    expect(mapToRunStatus("report", "full_report")).toBe(RUN_STATUS.COMPLETE);
  });
  it("maps partial and stub to ⚠️ Partial", () => {
    expect(mapToRunStatus("sync", "partial")).toBe(RUN_STATUS.PARTIAL);
    expect(mapToRunStatus("report", "stub")).toBe(RUN_STATUS.PARTIAL);
  });
  it("maps failed to ❌ Failed", () => {
    expect(mapToRunStatus("sync", "failed")).toBe(RUN_STATUS.FAILED);
    expect(mapToRunStatus("snapshot", "failed")).toBe(RUN_STATUS.FAILED);
  });
});

describe("normalizeStoredStatus", () => {
  it("returns canonical strings unchanged", () => {
    expect(normalizeStoredStatus("✅ Complete")).toBe(RUN_STATUS.COMPLETE);
    expect(normalizeStoredStatus("⚠️ Partial")).toBe(RUN_STATUS.PARTIAL);
    expect(normalizeStoredStatus("❌ Failed")).toBe(RUN_STATUS.FAILED);
    expect(normalizeStoredStatus("Heartbeat")).toBe(RUN_STATUS.HEARTBEAT);
  });
  it("normalizes lowercase and emoji-less variants", () => {
    expect(normalizeStoredStatus("complete")).toBe(RUN_STATUS.COMPLETE);
    expect(normalizeStoredStatus("ok")).toBe(RUN_STATUS.COMPLETE);
    expect(normalizeStoredStatus("partial")).toBe(RUN_STATUS.PARTIAL);
    expect(normalizeStoredStatus("WARNING")).toBe(RUN_STATUS.PARTIAL);
    expect(normalizeStoredStatus("Failed")).toBe(RUN_STATUS.FAILED);
    expect(normalizeStoredStatus("error")).toBe(RUN_STATUS.FAILED);
    expect(normalizeStoredStatus("heartbeat")).toBe(RUN_STATUS.HEARTBEAT);
  });
  it("returns null for unknown values and empty strings", () => {
    expect(normalizeStoredStatus("")).toBeNull();
    expect(normalizeStoredStatus(null)).toBeNull();
    expect(normalizeStoredStatus("Sync Status")).toBeNull();
  });
});

describe("isCanonicalRunStatus", () => {
  it("accepts only canonical strings", () => {
    expect(isCanonicalRunStatus("✅ Complete")).toBe(true);
    expect(isCanonicalRunStatus("complete")).toBe(false);
    expect(isCanonicalRunStatus("Heartbeat")).toBe(true);
    expect(isCanonicalRunStatus("Partial")).toBe(false);
  });
});
