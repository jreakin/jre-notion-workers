/**
 * Unit tests for sync-time-log worker.
 * Mocks Notion client and GitHub fetch to test the full sync flow.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { executeSyncTimeLog, parseGitHubUrl } from "../../src/workers/sync-time-log.js";
import type { SyncTimeLogInput } from "../../src/shared/types.js";

/* ── Env helpers ────────────────────────────────────────────────────── */

let savedEnv: Record<string, string | undefined>;

function setupEnv() {
  savedEnv = {
    GITHUB_ITEMS_DATABASE_ID: process.env.GITHUB_ITEMS_DATABASE_ID,
    TIME_LOG_DATABASE_ID: process.env.TIME_LOG_DATABASE_ID,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  };
  process.env.GITHUB_ITEMS_DATABASE_ID = "gh-items-db-id";
  process.env.TIME_LOG_DATABASE_ID = "time-log-db-id";
  process.env.GITHUB_TOKEN = "ghp_test_token_123";
}

function restoreEnv() {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/* ── Fetch mock ─────────────────────────────────────────────────────── */

const originalFetch = globalThis.fetch;

function mockFetch(
  handler: (url: string, opts?: RequestInit) => Promise<Response>
) {
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    handler as typeof fetch;
}

function restoreFetch() {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/* ── Notion page factories ──────────────────────────────────────────── */

interface MockGitHubItem {
  id: string;
  title: string;
  type: "Issue" | "PR";
  status: string;
  githubUrl: string;
  repo: string;
  created: string;
  updated: string;
  labels?: string[];
  clientIds?: string[];
  projectIds?: string[];
  taskIds?: string[];
}

function makeGitHubItemPage(item: MockGitHubItem): Record<string, unknown> {
  return {
    id: item.id,
    properties: {
      Title: {
        title: [{ plain_text: item.title }],
      },
      Type: { select: { name: item.type } },
      Status: { select: { name: item.status } },
      "GitHub URL": { url: item.githubUrl },
      Repo: { rich_text: [{ plain_text: item.repo }] },
      Created: { date: { start: item.created } },
      Updated: { date: { start: item.updated } },
      Labels: {
        multi_select: (item.labels ?? []).map((l) => ({ name: l })),
      },
      Client: {
        relation: (item.clientIds ?? []).map((id) => ({ id })),
      },
      Project: {
        relation: (item.projectIds ?? []).map((id) => ({ id })),
      },
      Task: {
        relation: (item.taskIds ?? []).map((id) => ({ id })),
      },
    },
  };
}

interface MockTimeLogEntry {
  id: string;
  description: string;
  githubItemIds: string[];
}

function makeTimeLogPage(entry: MockTimeLogEntry): Record<string, unknown> {
  return {
    id: entry.id,
    properties: {
      Description: {
        title: [{ plain_text: entry.description }],
      },
      "GitHub Item": {
        relation: entry.githubItemIds.map((id) => ({ id })),
      },
    },
  };
}

/* ── Mock Notion client ─────────────────────────────────────────────── */

function mockNotionClient(
  ghItems: MockGitHubItem[],
  timeLogEntries: MockTimeLogEntry[]
) {
  const createdPages: Array<Record<string, unknown>> = [];
  const updatedPages: Array<{ page_id: string; properties: Record<string, unknown> }> = [];

  const client = {
    databases: {
      query: async (args: { database_id: string; filter?: unknown }) => {
        if (args.database_id === "gh-items-db-id") {
          return {
            results: ghItems.map(makeGitHubItemPage),
            has_more: false,
            next_cursor: null,
          };
        }
        if (args.database_id === "time-log-db-id") {
          return {
            results: timeLogEntries.map(makeTimeLogPage),
            has_more: false,
            next_cursor: null,
          };
        }
        return { results: [], has_more: false, next_cursor: null };
      },
    },
    pages: {
      create: async (args: { parent: unknown; properties: unknown }) => {
        const props = args.properties as Record<string, unknown>;
        createdPages.push(props);
        return { id: `created-${createdPages.length}` };
      },
      update: async (args: { page_id: string; properties: unknown }) => {
        const props = args.properties as Record<string, unknown>;
        updatedPages.push({ page_id: args.page_id, properties: props });
        return { id: args.page_id };
      },
    },
    _createdPages: createdPages,
    _updatedPages: updatedPages,
  };

  return client;
}

/** Default GitHub API mock: returns sensible PR/issue data for estimation. */
function setupDefaultGitHubMock() {
  mockFetch(async (url: string) => {
    // PR detail endpoint
    if (url.includes("/pulls/") && !url.includes("/files")) {
      return jsonResponse({
        additions: 80,
        deletions: 20,
        changed_files: 3,
        title: "Fix bug",
        body: "Fix a critical bug",
        labels: [{ name: "bug" }],
      });
    }
    // PR files endpoint
    if (url.includes("/files")) {
      return jsonResponse([
        { filename: "src/a.ts", additions: 40, deletions: 10, changes: 50 },
        { filename: "src/b.ts", additions: 30, deletions: 5, changes: 35 },
        { filename: "src/c.ts", additions: 10, deletions: 5, changes: 15 },
      ]);
    }
    // Issue endpoint
    if (url.includes("/issues/")) {
      return jsonResponse({
        title: "Add feature",
        body: "We need a new feature. This involves multiple changes to the system.",
        labels: [{ name: "feature" }],
      });
    }
    return jsonResponse({}, 404);
  });
}

/* ── Tests ─────────────────────────────────────────────────────────── */

describe("sync-time-log", () => {
  beforeEach(() => {
    setupEnv();
    setupDefaultGitHubMock();
  });

  afterEach(() => {
    restoreEnv();
    restoreFetch();
  });

  /* ── parseGitHubUrl ──────────────────────────────────────────────── */

  describe("parseGitHubUrl", () => {
    test("parses issue URL", () => {
      const result = parseGitHubUrl(
        "https://github.com/Abstract-Data/my-app/issues/42"
      );
      expect(result).toEqual({
        owner: "Abstract-Data",
        repo: "my-app",
        number: 42,
        type: "issue",
      });
    });

    test("parses PR URL", () => {
      const result = parseGitHubUrl(
        "https://github.com/JREakin/personal-repo/pull/10"
      );
      expect(result).toEqual({
        owner: "JREakin",
        repo: "personal-repo",
        number: 10,
        type: "pr",
      });
    });

    test("returns null for repo URL (no number)", () => {
      expect(
        parseGitHubUrl("https://github.com/Abstract-Data/my-app")
      ).toBeNull();
    });

    test("returns null for malformed URL", () => {
      expect(parseGitHubUrl("not-a-url")).toBeNull();
    });
  });

  /* ── Main sync flow ──────────────────────────────────────────────── */

  test("creates Time Log entry for new issue", async () => {
    const notion = mockNotionClient(
      [
        {
          id: "issue-page-1",
          title: "Fix login bug",
          type: "Issue",
          status: "Open",
          githubUrl: "https://github.com/Abstract-Data/app/issues/15",
          repo: "Abstract-Data/app",
          created: "2026-03-05",
          updated: "2026-03-05",
          labels: ["bug"],
          clientIds: ["client-abc"],
          projectIds: ["project-xyz"],
        },
      ],
      [] // no existing time log entries
    );

    const result = await executeSyncTimeLog({}, notion as never);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.entries[0]!.action).toBe("created");
    expect(result.entries[0]!.hours).toBeGreaterThan(0);

    // Verify Notion page was created with correct properties
    const created = notion._createdPages[0]!;
    expect(created["GitHub Item"]).toEqual({ relation: [{ id: "issue-page-1" }] });
    expect(created.Client).toEqual({ relation: [{ id: "client-abc" }] });
    expect(created.Project).toEqual({ relation: [{ id: "project-xyz" }] });
    expect(created.Billable).toEqual({ checkbox: false });
  });

  test("creates Time Log entry for new PR with [EST] prefix", async () => {
    const notion = mockNotionClient(
      [
        {
          id: "pr-page-1",
          title: "Add auth module",
          type: "PR",
          status: "Open",
          githubUrl: "https://github.com/Abstract-Data/app/pull/22",
          repo: "Abstract-Data/app",
          created: "2026-03-06",
          updated: "2026-03-06",
          labels: ["enhancement"],
        },
      ],
      []
    );

    const result = await executeSyncTimeLog({}, notion as never);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.created).toBe(1);
    expect(result.entries[0]!.description_prefix).toMatch(/^\[EST/);
    expect(result.total_estimated_hours).toBeGreaterThan(0);
  });

  test("creates [EST-FINAL] entry for merged PR with no prior entry", async () => {
    const notion = mockNotionClient(
      [
        {
          id: "pr-merged-1",
          title: "Deploy fix",
          type: "PR",
          status: "Merged",
          githubUrl: "https://github.com/Abstract-Data/app/pull/30",
          repo: "Abstract-Data/app",
          created: "2026-03-04",
          updated: "2026-03-07",
        },
      ],
      []
    );

    const result = await executeSyncTimeLog({}, notion as never);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.created).toBe(1);
    expect(result.entries[0]!.description_prefix).toBe("[EST-FINAL]");
  });

  test("updates existing [EST] entry to [EST-FINAL] when PR merges", async () => {
    const notion = mockNotionClient(
      [
        {
          id: "pr-page-2",
          title: "Refactor DB layer",
          type: "PR",
          status: "Merged",
          githubUrl: "https://github.com/Abstract-Data/app/pull/25",
          repo: "Abstract-Data/app",
          created: "2026-03-03",
          updated: "2026-03-08",
        },
      ],
      [
        {
          id: "tl-entry-existing",
          description: "[EST] PR: Refactor DB layer (#25) \u2014 Abstract-Data/app",
          githubItemIds: ["pr-page-2"],
        },
      ]
    );

    const result = await executeSyncTimeLog({}, notion as never);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.updated).toBe(1);
    expect(result.created).toBe(0);
    expect(result.entries[0]!.action).toBe("updated");
    expect(result.entries[0]!.description_prefix).toBe("[EST-FINAL]");

    // Verify the update targeted the existing entry
    expect(notion._updatedPages[0]!.page_id).toBe("tl-entry-existing");
  });

  test("skips manual entry (no [EST*] prefix)", async () => {
    const notion = mockNotionClient(
      [
        {
          id: "issue-manual",
          title: "Custom work",
          type: "Issue",
          status: "Closed",
          githubUrl: "https://github.com/Abstract-Data/app/issues/5",
          repo: "Abstract-Data/app",
          created: "2026-03-02",
          updated: "2026-03-07",
        },
      ],
      [
        {
          id: "tl-manual",
          description: "Manual time entry for custom work",
          githubItemIds: ["issue-manual"],
        },
      ]
    );

    const result = await executeSyncTimeLog({}, notion as never);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.skipped).toBe(1);
    expect(result.created).toBe(0);
    expect(result.entries[0]!.action).toBe("skipped");
    expect(result.entries[0]!.reason).toContain("Manual entry");
  });

  test("skips existing [EST] entry for non-merged PR", async () => {
    const notion = mockNotionClient(
      [
        {
          id: "pr-open",
          title: "WIP feature",
          type: "PR",
          status: "Open",
          githubUrl: "https://github.com/Abstract-Data/app/pull/40",
          repo: "Abstract-Data/app",
          created: "2026-03-06",
          updated: "2026-03-08",
        },
      ],
      [
        {
          id: "tl-existing-est",
          description: "[EST] PR: WIP feature (#40) \u2014 Abstract-Data/app",
          githubItemIds: ["pr-open"],
        },
      ]
    );

    const result = await executeSyncTimeLog({}, notion as never);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.skipped).toBe(1);
    expect(result.entries[0]!.reason).toContain("Already estimated");
  });

  test("copies Client/Project/Task relations from GitHub Item", async () => {
    const notion = mockNotionClient(
      [
        {
          id: "issue-with-rels",
          title: "Task-linked issue",
          type: "Issue",
          status: "Open",
          githubUrl: "https://github.com/Abstract-Data/app/issues/50",
          repo: "Abstract-Data/app",
          created: "2026-03-07",
          updated: "2026-03-07",
          clientIds: ["client-1", "client-2"],
          projectIds: ["proj-1"],
          taskIds: ["task-1"],
        },
      ],
      []
    );

    const result = await executeSyncTimeLog({}, notion as never);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.created).toBe(1);

    const created = notion._createdPages[0]!;
    expect(created.Client).toEqual({
      relation: [{ id: "client-1" }, { id: "client-2" }],
    });
    expect(created.Project).toEqual({ relation: [{ id: "proj-1" }] });
    expect(created.Task).toEqual({ relation: [{ id: "task-1" }] });
  });

  test("uses fallback when estimation fails", async () => {
    // Override fetch to return 404 for all GitHub API calls
    mockFetch(async () => jsonResponse({}, 404));

    const notion = mockNotionClient(
      [
        {
          id: "issue-no-gh",
          title: "Broken link issue",
          type: "Issue",
          status: "Open",
          githubUrl: "https://github.com/Abstract-Data/app/issues/99",
          repo: "Abstract-Data/app",
          created: "2026-03-06",
          updated: "2026-03-06",
          labels: ["bug"],
        },
      ],
      []
    );

    const result = await executeSyncTimeLog({}, notion as never);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.created).toBe(1);
    expect(result.entries[0]!.description_prefix).toBe("[EST-FALLBACK]");
    expect(result.entries[0]!.hours).toBe(2); // bug fallback = 2h
  });

  test("dry run creates nothing in Notion", async () => {
    const notion = mockNotionClient(
      [
        {
          id: "issue-dry",
          title: "Dry run test",
          type: "Issue",
          status: "Open",
          githubUrl: "https://github.com/Abstract-Data/app/issues/60",
          repo: "Abstract-Data/app",
          created: "2026-03-07",
          updated: "2026-03-07",
        },
      ],
      []
    );

    const result = await executeSyncTimeLog({ dry_run: true }, notion as never);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.created).toBe(1);
    expect(result.summary).toContain("DRY RUN");

    // No actual Notion writes
    expect(notion._createdPages.length).toBe(0);
    expect(notion._updatedPages.length).toBe(0);
  });

  test("repo_filter limits scope", async () => {
    const notion = mockNotionClient(
      [
        {
          id: "issue-in-scope",
          title: "In scope",
          type: "Issue",
          status: "Open",
          githubUrl: "https://github.com/Abstract-Data/app/issues/1",
          repo: "Abstract-Data/app",
          created: "2026-03-06",
          updated: "2026-03-06",
        },
        {
          id: "issue-out-scope",
          title: "Out of scope",
          type: "Issue",
          status: "Open",
          githubUrl: "https://github.com/Abstract-Data/other/issues/2",
          repo: "Abstract-Data/other",
          created: "2026-03-06",
          updated: "2026-03-06",
        },
      ],
      []
    );

    const result = await executeSyncTimeLog(
      { repo_filter: ["Abstract-Data/app"] },
      notion as never
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    // Only the in-scope item processed
    expect(result.items_scanned).toBe(1);
    expect(result.created).toBe(1);
    expect(result.entries[0]!.title).toBe("In scope");
  });

  test("handles multiple items with mixed actions", async () => {
    const notion = mockNotionClient(
      [
        // New issue — will be created
        {
          id: "new-issue",
          title: "New feature request",
          type: "Issue",
          status: "Open",
          githubUrl: "https://github.com/Abstract-Data/app/issues/70",
          repo: "Abstract-Data/app",
          created: "2026-03-07",
          updated: "2026-03-07",
          labels: ["feature"],
        },
        // PR with existing manual entry — will be skipped
        {
          id: "manual-pr",
          title: "Manual time PR",
          type: "PR",
          status: "Open",
          githubUrl: "https://github.com/Abstract-Data/app/pull/71",
          repo: "Abstract-Data/app",
          created: "2026-03-06",
          updated: "2026-03-08",
        },
        // Merged PR with existing [EST] — will be updated
        {
          id: "merged-pr",
          title: "Merged feature",
          type: "PR",
          status: "Merged",
          githubUrl: "https://github.com/Abstract-Data/app/pull/72",
          repo: "Abstract-Data/app",
          created: "2026-03-04",
          updated: "2026-03-09",
        },
      ],
      [
        {
          id: "tl-manual-entry",
          description: "Logged 3h for manual time PR",
          githubItemIds: ["manual-pr"],
        },
        {
          id: "tl-est-entry",
          description: "[EST] PR: Merged feature (#72) \u2014 Abstract-Data/app",
          githubItemIds: ["merged-pr"],
        },
      ]
    );

    const result = await executeSyncTimeLog({}, notion as never);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.items_scanned).toBe(3);
    expect(result.created).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(1);

    // Check each entry action
    const actions = result.entries.map((e) => `${e.title}:${e.action}`);
    expect(actions).toContain("New feature request:created");
    expect(actions).toContain("Manual time PR:skipped");
    expect(actions).toContain("Merged feature:updated");
  });
});
