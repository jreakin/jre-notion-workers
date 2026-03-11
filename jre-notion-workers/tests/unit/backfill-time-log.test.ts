/**
 * Unit tests for the backfill-time-log script.
 * Mocks Notion client and GitHub fetch to test the backfill flow.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { parseArgs, loadAllGitHubItems, runBackfill } from "../../scripts/backfill-time-log.js";

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

function mockFetchGlobal(
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
      Title: { title: [{ plain_text: item.title }] },
      Type: { select: { name: item.type } },
      Status: { select: { name: item.status } },
      "GitHub URL": { url: item.githubUrl },
      Repo: { rich_text: [{ plain_text: item.repo }] },
      Created: { date: { start: item.created } },
      Updated: { date: { start: item.updated } },
      Labels: {
        multi_select: (item.labels ?? []).map((l) => ({ name: l })),
      },
      Client: { relation: (item.clientIds ?? []).map((id) => ({ id })) },
      Project: { relation: (item.projectIds ?? []).map((id) => ({ id })) },
      Task: { relation: (item.taskIds ?? []).map((id) => ({ id })) },
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
      Description: { title: [{ plain_text: entry.description }] },
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

  const client = {
    databases: {
      query: async (args: { database_id: string }) => {
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
    },
    _createdPages: createdPages,
  };

  return client;
}

/** Default GitHub API mock for estimation. */
function setupDefaultGitHubMock() {
  mockFetchGlobal(async (url: string) => {
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
    if (url.includes("/files")) {
      return jsonResponse([
        { filename: "src/a.ts", additions: 40, deletions: 10, changes: 50 },
        { filename: "src/b.ts", additions: 30, deletions: 5, changes: 35 },
        { filename: "src/c.ts", additions: 10, deletions: 5, changes: 15 },
      ]);
    }
    if (url.includes("/issues/")) {
      return jsonResponse({
        title: "Add feature",
        body: "We need a new feature.",
        labels: [{ name: "feature" }],
      });
    }
    return jsonResponse({}, 404);
  });
}

/* ── Tests ─────────────────────────────────────────────────────────── */

describe("backfill-time-log", () => {
  beforeEach(() => {
    setupEnv();
    setupDefaultGitHubMock();
  });

  afterEach(() => {
    restoreEnv();
    restoreFetch();
  });

  /* ── parseArgs ──────────────────────────────────────────────────── */

  describe("parseArgs", () => {
    test("defaults: no dry-run, both types, no limit", () => {
      const opts = parseArgs(["node", "script.ts"]);
      expect(opts.dryRun).toBe(false);
      expect(opts.itemTypes).toEqual(["Issue", "PR"]);
      expect(opts.repoFilter).toEqual([]);
      expect(opts.limit).toBe(0);
      expect(opts.verbose).toBe(false);
    });

    test("--dry-run flag", () => {
      const opts = parseArgs(["node", "script.ts", "--dry-run"]);
      expect(opts.dryRun).toBe(true);
    });

    test("--repo flag (repeatable)", () => {
      const opts = parseArgs([
        "node", "script.ts",
        "--repo", "Abstract-Data/app",
        "--repo", "JREakin/tools",
      ]);
      expect(opts.repoFilter).toEqual(["Abstract-Data/app", "JREakin/tools"]);
    });

    test("--type flag overrides defaults", () => {
      const opts = parseArgs(["node", "script.ts", "--type", "PR"]);
      expect(opts.itemTypes).toEqual(["PR"]);
    });

    test("--limit flag", () => {
      const opts = parseArgs(["node", "script.ts", "--limit", "5"]);
      expect(opts.limit).toBe(5);
    });

    test("--verbose flag", () => {
      const opts = parseArgs(["node", "script.ts", "--verbose"]);
      expect(opts.verbose).toBe(true);
    });
  });

  /* ── loadAllGitHubItems ─────────────────────────────────────────── */

  test("loads all items without date filter", async () => {
    const notion = mockNotionClient(
      [
        {
          id: "old-pr",
          title: "Ancient PR",
          type: "PR",
          status: "Merged",
          githubUrl: "https://github.com/Abstract-Data/app/pull/1",
          repo: "Abstract-Data/app",
          created: "2024-01-15",
          updated: "2024-01-20",
        },
        {
          id: "recent-issue",
          title: "Recent issue",
          type: "Issue",
          status: "Open",
          githubUrl: "https://github.com/Abstract-Data/app/issues/100",
          repo: "Abstract-Data/app",
          created: "2026-03-09",
          updated: "2026-03-09",
        },
      ],
      []
    );

    const items = await loadAllGitHubItems(
      notion as never,
      ["Issue", "PR"],
      []
    );

    // Both items loaded — no date filter applied
    expect(items.length).toBe(2);
    expect(items.map((i) => i.id)).toContain("old-pr");
    expect(items.map((i) => i.id)).toContain("recent-issue");
  });

  /* ── runBackfill ────────────────────────────────────────────────── */

  test("skips items already in Time Log", async () => {
    const notion = mockNotionClient(
      [
        {
          id: "existing-item",
          title: "Already tracked",
          type: "PR",
          status: "Open",
          githubUrl: "https://github.com/Abstract-Data/app/pull/10",
          repo: "Abstract-Data/app",
          created: "2026-03-01",
          updated: "2026-03-01",
        },
        {
          id: "new-item",
          title: "Not yet tracked",
          type: "Issue",
          status: "Open",
          githubUrl: "https://github.com/Abstract-Data/app/issues/11",
          repo: "Abstract-Data/app",
          created: "2026-03-01",
          updated: "2026-03-01",
          labels: ["bug"],
        },
      ],
      [
        {
          id: "tl-1",
          description: "[EST] PR: Already tracked (#10)",
          githubItemIds: ["existing-item"],
        },
      ]
    );

    const result = await runBackfill(
      { dryRun: false, repoFilter: [], itemTypes: ["Issue", "PR"], limit: 0, verbose: false },
      notion as never
    );

    expect(result.created).toBe(1);
    expect(result.alreadyCovered).toBe(1);
    expect(result.totalItems).toBe(2);
    expect(notion._createdPages.length).toBe(1);
    // Verify the new entry was for the right item
    const createdGhRelation = notion._createdPages[0]!["GitHub Item"] as {
      relation: Array<{ id: string }>;
    };
    expect(createdGhRelation.relation[0]!.id).toBe("new-item");
  });

  test("creates entries with correct properties", async () => {
    const notion = mockNotionClient(
      [
        {
          id: "pr-1",
          title: "Add auth module",
          type: "PR",
          status: "Merged",
          githubUrl: "https://github.com/Abstract-Data/app/pull/22",
          repo: "Abstract-Data/app",
          created: "2026-02-15",
          updated: "2026-02-20",
          clientIds: ["client-abc"],
          projectIds: ["project-xyz"],
          taskIds: ["task-1"],
        },
      ],
      []
    );

    const result = await runBackfill(
      { dryRun: false, repoFilter: [], itemTypes: ["Issue", "PR"], limit: 0, verbose: false },
      notion as never
    );

    expect(result.created).toBe(1);
    const created = notion._createdPages[0]!;
    expect(created["GitHub Item"]).toEqual({ relation: [{ id: "pr-1" }] });
    expect(created.Client).toEqual({ relation: [{ id: "client-abc" }] });
    expect(created.Project).toEqual({ relation: [{ id: "project-xyz" }] });
    expect(created.Task).toEqual({ relation: [{ id: "task-1" }] });
    expect(created.Billable).toEqual({ checkbox: false });

    // Description should contain [EST-FINAL] since PR is Merged
    const desc = (created.Description as { title: Array<{ text: { content: string } }> })
      .title[0]!.text.content;
    expect(desc).toContain("[EST-FINAL]");
    expect(desc).toContain("PR:");
    expect(desc).toContain("#22");

    // Hours should be a number
    const hours = (created.Hours as { number: number }).number;
    expect(hours).toBeGreaterThan(0);
  });

  test("uses fallback on estimation failure", async () => {
    // Override fetch to return 404
    mockFetchGlobal(async () => jsonResponse({}, 404));

    const notion = mockNotionClient(
      [
        {
          id: "fallback-issue",
          title: "Deleted issue",
          type: "Issue",
          status: "Closed",
          githubUrl: "https://github.com/Abstract-Data/app/issues/999",
          repo: "Abstract-Data/app",
          created: "2026-01-01",
          updated: "2026-01-01",
          labels: ["bug"],
        },
      ],
      []
    );

    const result = await runBackfill(
      { dryRun: false, repoFilter: [], itemTypes: ["Issue", "PR"], limit: 0, verbose: false },
      notion as never
    );

    expect(result.created).toBe(1);
    expect(result.fallbacks).toBe(1);

    const desc = (notion._createdPages[0]!.Description as {
      title: Array<{ text: { content: string } }>;
    }).title[0]!.text.content;
    expect(desc).toContain("[EST-FALLBACK]");

    // Bug label fallback = 2h
    const hours = (notion._createdPages[0]!.Hours as { number: number }).number;
    expect(hours).toBe(2);
  });

  test("dry run creates nothing in Notion", async () => {
    const notion = mockNotionClient(
      [
        {
          id: "dry-item",
          title: "Dry run item",
          type: "PR",
          status: "Open",
          githubUrl: "https://github.com/Abstract-Data/app/pull/50",
          repo: "Abstract-Data/app",
          created: "2026-02-01",
          updated: "2026-02-01",
        },
      ],
      []
    );

    const result = await runBackfill(
      { dryRun: true, repoFilter: [], itemTypes: ["Issue", "PR"], limit: 0, verbose: false },
      notion as never
    );

    expect(result.created).toBe(1);
    expect(result.totalHours).toBeGreaterThan(0);
    // No actual Notion writes
    expect(notion._createdPages.length).toBe(0);
  });

  test("repo filter limits scope", async () => {
    const notion = mockNotionClient(
      [
        {
          id: "in-scope",
          title: "In scope PR",
          type: "PR",
          status: "Open",
          githubUrl: "https://github.com/Abstract-Data/app/pull/1",
          repo: "Abstract-Data/app",
          created: "2026-01-01",
          updated: "2026-01-01",
        },
        {
          id: "out-scope",
          title: "Out of scope PR",
          type: "PR",
          status: "Open",
          githubUrl: "https://github.com/Abstract-Data/other/pull/2",
          repo: "Abstract-Data/other",
          created: "2026-01-01",
          updated: "2026-01-01",
        },
      ],
      []
    );

    const result = await runBackfill(
      {
        dryRun: false,
        repoFilter: ["Abstract-Data/app"],
        itemTypes: ["Issue", "PR"],
        limit: 0,
        verbose: false,
      },
      notion as never
    );

    expect(result.totalItems).toBe(1); // Only in-scope loaded
    expect(result.created).toBe(1);
  });

  test("limit flag caps processing", async () => {
    const notion = mockNotionClient(
      [
        {
          id: "item-1",
          title: "Item 1",
          type: "Issue",
          status: "Open",
          githubUrl: "https://github.com/Abstract-Data/app/issues/1",
          repo: "Abstract-Data/app",
          created: "2026-01-01",
          updated: "2026-01-01",
        },
        {
          id: "item-2",
          title: "Item 2",
          type: "Issue",
          status: "Open",
          githubUrl: "https://github.com/Abstract-Data/app/issues/2",
          repo: "Abstract-Data/app",
          created: "2026-01-01",
          updated: "2026-01-01",
        },
        {
          id: "item-3",
          title: "Item 3",
          type: "Issue",
          status: "Open",
          githubUrl: "https://github.com/Abstract-Data/app/issues/3",
          repo: "Abstract-Data/app",
          created: "2026-01-01",
          updated: "2026-01-01",
        },
      ],
      []
    );

    const result = await runBackfill(
      { dryRun: false, repoFilter: [], itemTypes: ["Issue", "PR"], limit: 2, verbose: false },
      notion as never
    );

    expect(result.processed).toBe(2); // Limited to 2
    expect(result.created).toBe(2);
    expect(notion._createdPages.length).toBe(2);
  });

  test("continues on individual item failure", async () => {
    // Make the first estimation fail but second succeed
    let callCount = 0;
    mockFetchGlobal(async (url: string) => {
      callCount++;
      // First item's issue call fails with 500
      if (callCount === 1 && url.includes("/issues/")) {
        return jsonResponse({ message: "Internal Server Error" }, 500);
      }
      // Second item succeeds
      if (url.includes("/issues/")) {
        return jsonResponse({
          title: "Feature",
          body: "A new feature",
          labels: [{ name: "feature" }],
        });
      }
      return jsonResponse({}, 404);
    });

    const notion = mockNotionClient(
      [
        {
          id: "fail-item",
          title: "Will fail estimation",
          type: "Issue",
          status: "Open",
          githubUrl: "https://github.com/Abstract-Data/app/issues/1",
          repo: "Abstract-Data/app",
          created: "2026-01-01",
          updated: "2026-01-01",
          labels: ["bug"],
        },
        {
          id: "ok-item",
          title: "Will succeed",
          type: "Issue",
          status: "Open",
          githubUrl: "https://github.com/Abstract-Data/app/issues/2",
          repo: "Abstract-Data/app",
          created: "2026-01-01",
          updated: "2026-01-01",
        },
      ],
      []
    );

    const result = await runBackfill(
      { dryRun: false, repoFilter: [], itemTypes: ["Issue", "PR"], limit: 0, verbose: false },
      notion as never
    );

    // Both items processed — first falls back, second succeeds
    expect(result.created).toBe(2);
    expect(result.fallbacks).toBe(1);
    // Both still created (fallback doesn't error out, just uses default)
    expect(notion._createdPages.length).toBe(2);
  });
});
