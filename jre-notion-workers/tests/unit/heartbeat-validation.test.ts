import { describe, expect, it } from "bun:test";
import {
  isHeartbeatShape,
  validateHeartbeat,
} from "../../src/shared/heartbeat-validation.js";

const empty = {
  flagged_items: [],
  needs_review: [],
  escalations: [],
  actions_taken: { created_tasks: [], updated_tasks: [], auto_closed_by_pr: [] },
};

describe("isHeartbeatShape", () => {
  it("returns true for empty shape", () => {
    expect(isHeartbeatShape(empty)).toBe(true);
  });
  it("returns false when there is any flagged item", () => {
    expect(isHeartbeatShape({ ...empty, flagged_items: [{ description: "x" }] })).toBe(false);
  });
  it("returns false when there is any created task", () => {
    expect(
      isHeartbeatShape({
        ...empty,
        actions_taken: { created_tasks: [{ name: "t", notion_url: "u" }], updated_tasks: [] },
      })
    ).toBe(false);
  });
});

describe("validateHeartbeat", () => {
  it("coerces partial+heartbeat-shape to heartbeat complete", () => {
    const r = validateHeartbeat(empty, "sync", "partial");
    expect(r.coerced).toBe(true);
    expect(r.status_type).toBe("heartbeat");
    expect(r.status_value).toBe("complete");
    expect(r.warnings.length).toBeGreaterThan(0);
  });
  it("coerces failed+heartbeat-shape to heartbeat complete", () => {
    const r = validateHeartbeat(empty, "report", "failed");
    expect(r.coerced).toBe(true);
    expect(r.status_type).toBe("heartbeat");
  });
  it("downgrades declared heartbeat with actionable items to sync", () => {
    const shape = { ...empty, flagged_items: [{ description: "x" }] };
    const r = validateHeartbeat(shape, "heartbeat", "complete");
    expect(r.coerced).toBe(true);
    expect(r.status_type).toBe("sync");
  });
  it("passes through valid (sync, complete) with non-empty shape", () => {
    const shape = { ...empty, flagged_items: [{ description: "x" }] };
    const r = validateHeartbeat(shape, "sync", "complete");
    expect(r.coerced).toBe(false);
    expect(r.status_type).toBe("sync");
    expect(r.status_value).toBe("complete");
  });
  it("passes through valid heartbeat", () => {
    const r = validateHeartbeat(empty, "heartbeat", "complete");
    expect(r.coerced).toBe(false);
    expect(r.status_type).toBe("heartbeat");
  });
});
