import { describe, expect, it } from "bun:test";
import {
  buildPageTitle,
  isHeartbeat,
  validateFlaggedItems,
} from "../../src/workers/write-agent-digest.js";

describe("buildPageTitle", () => {
  it("uses emoji prefix on normal runs", () => {
    expect(
      buildPageTitle({
        emoji: "🔄",
        digestType: "GitHub Sync",
        date: "2026-02-28",
        isError: false,
      })
    ).toBe("🔄 GitHub Sync — 2026-02-28");
  });

  it("drops emoji and adds ERROR on degraded runs", () => {
    expect(
      buildPageTitle({
        emoji: "🔄",
        digestType: "GitHub Sync",
        date: "2026-02-28",
        isError: true,
      })
    ).toBe("GitHub Sync ERROR — 2026-02-28");
  });
});

describe("isHeartbeat", () => {
  it("returns true when status_type is heartbeat", () => {
    expect(
      isHeartbeat({
        status_type: "heartbeat",
        flagged_items: [],
        actions_taken: { created_tasks: [], updated_tasks: [] },
      })
    ).toBe(true);
  });

  it("returns true when no flagged items and no tasks", () => {
    expect(
      isHeartbeat({
        status_type: "sync",
        flagged_items: [],
        actions_taken: { created_tasks: [], updated_tasks: [] },
      })
    ).toBe(true);
  });

  it("returns false when flagged items exist", () => {
    expect(
      isHeartbeat({
        status_type: "sync",
        flagged_items: [{ description: "something", task_link: "https://notion.so/x" }],
        actions_taken: { created_tasks: [], updated_tasks: [] },
      })
    ).toBe(false);
  });
});

describe("validateFlaggedItems", () => {
  it("passes when all items have task_link", () => {
    const items = [{ description: "thing", task_link: "https://notion.so/x" }];
    expect(validateFlaggedItems(items)).toBeNull();
  });

  it("passes when item has no_task_reason instead", () => {
    const items = [{ description: "thing", no_task_reason: "already tracked externally" }];
    expect(validateFlaggedItems(items)).toBeNull();
  });

  it("returns error message when item has neither", () => {
    const items = [{ description: "orphaned item" }];
    expect(validateFlaggedItems(items)).toMatch(/task_link|no_task_reason/);
  });
});
