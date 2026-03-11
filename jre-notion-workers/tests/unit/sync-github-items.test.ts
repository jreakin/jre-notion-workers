import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  executeSyncGitHubItems,
  inferTypeFromUrl,
  isNewer,
} from "../../src/workers/sync-github-items.js";

/* ── Mock helpers ────────────────────────────────────────────────── */

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

/* ── GitHub data factories ───────────────────────────────────────── */

function makeRepo(
  fullName: string,
  opts?: { fork?: boolean; archived?: boolean; description?: string; updatedAt?: string }
) {
  const [owner] = fullName.split("/");
  return {
    full_name: fullName,
    html_url: `https://github.com/${fullName}`,
    description: opts?.description ?? `Repo: ${fullName}`,
    fork: opts?.fork ?? false,
    archived: opts?.archived ?? false,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: opts?.updatedAt ?? "2024-06-15T00:00:00Z",
    owner: { login: owner! },
  };
}

function makeIssue(
  repoFullName: string,
  num: number,
  opts?: {
    state?: "open" | "closed";
    isPR?: boolean;
    labels?: string[];
    body?: string;
    updatedAt?: string;
  }
) {
  return {
    number: num,
    title: `Issue #${num} in ${repoFullName}`,
    html_url: `https://github.com/${repoFullName}/issues/${num}`,
    state: opts?.state ?? ("open" as const),
    body: opts?.body ?? `Body for issue ${num}`,
    labels: (opts?.labels ?? []).map((n) => ({ name: n })),
    created_at: "2024-03-01T00:00:00Z",
    updated_at: opts?.updatedAt ?? "2024-06-15T00:00:00Z",
    ...(opts?.isPR ? { pull_request: { url: "..." } } : {}),
  };
}

function makePR(
  repoFullName: string,
  num: number,
  opts?: {
    state?: "open" | "closed";
    mergedAt?: string | null;
    labels?: string[];
    updatedAt?: string;
  }
) {
  return {
    number: num,
    title: `PR #${num} in ${repoFullName}`,
    html_url: `https://github.com/${repoFullName}/pull/${num}`,
    state: opts?.state ?? ("open" as const),
    body: `Body for PR ${num}`,
    labels: (opts?.labels ?? []).map((n) => ({ name: n })),
    created_at: "2024-03-01T00:00:00Z",
    updated_at: opts?.updatedAt ?? "2024-06-15T00:00:00Z",
    merged_at: opts?.mergedAt ?? null,
  };
}

/* ── Notion mock ─────────────────────────────────────────────────── */

interface NotionPage {
  id: string;
  ghUrl: string;
  type?: string;
  updatedAt?: string; // YYYY-MM-DD
  projectIds?: string[];
  clientIds?: string[];
}

function mockNotionClient(pages: NotionPage[]) {
  const createdPages: Array<Record<string, unknown>> = [];
  const updatedPages: Array<{ page_id: string; properties: unknown }> = [];

  return {
    client: {
      databases: {
        query: async () => ({
          results: pages.map((p) => ({
            id: p.id,
            properties: {
              Title: { title: [{ plain_text: p.id }] },
              "GitHub URL": { url: p.ghUrl },
              Type: { select: { name: p.type ?? "Repo" } },
              Updated: p.updatedAt
                ? { date: { start: p.updatedAt } }
                : { date: null },
              Project: {
                relation: (p.projectIds ?? []).map((id) => ({ id })),
              },
              Client: {
                relation: (p.clientIds ?? []).map((id) => ({ id })),
              },
            },
          })),
          has_more: false,
          next_cursor: null,
        }),
      },
      pages: {
        create: async (args: Record<string, unknown>) => {
          createdPages.push(args);
          return { id: `new-${createdPages.length}` };
        },
        update: async (args: { page_id: string; properties: unknown }) => {
          updatedPages.push(args);
          return {};
        },
      },
    } as never,
    createdPages,
    updatedPages,
  };
}

/* ── Fetch mock ──────────────────────────────────────────────────── */

interface MockEndpoints {
  repos?: Record<string, ReturnType<typeof makeRepo>[]>;
  issues?: Record<string, ReturnType<typeof makeIssue>[]>;
  prs?: Record<string, ReturnType<typeof makePR>[]>;
}

function mockFetch(endpoints: MockEndpoints) {
  globalThis.fetch = (async (url: string) => {
    // Org repos: /orgs/{name}/repos
    const orgMatch = url.match(/\/orgs\/([^/]+)\/repos/);
    if (orgMatch) {
      const orgName = orgMatch[1]!;
      return {
        ok: true,
        status: 200,
        json: async () => endpoints.repos?.[orgName] ?? [],
        headers: new Headers(),
      };
    }

    // Authenticated user repos: /user/repos (returns all repos; tests filter by owner)
    if (url.includes("/user/repos")) {
      // Combine ALL user-type repos into one array (simulating the /user/repos response)
      const allRepos = Object.values(endpoints.repos ?? {}).flat();
      return {
        ok: true,
        status: 200,
        json: async () => allRepos,
        headers: new Headers(),
      };
    }

    // Issues: /repos/{owner}/{repo}/issues
    const issueMatch = url.match(/\/repos\/([^/]+\/[^/]+)\/issues/);
    if (issueMatch) {
      const key = issueMatch[1]!;
      return {
        ok: true,
        status: 200,
        json: async () => endpoints.issues?.[key] ?? [],
        headers: new Headers(),
      };
    }

    // PRs: /repos/{owner}/{repo}/pulls
    const prMatch = url.match(/\/repos\/([^/]+\/[^/]+)\/pulls/);
    if (prMatch) {
      const key = prMatch[1]!;
      return {
        ok: true,
        status: 200,
        json: async () => endpoints.prs?.[key] ?? [],
        headers: new Headers(),
      };
    }

    return {
      ok: false,
      status: 404,
      json: async () => ({ message: "Not Found" }),
      headers: new Headers(),
    };
  }) as never;
}

/* ── Setup / Teardown ────────────────────────────────────────────── */

beforeEach(() => {
  process.env.GITHUB_TOKEN = "test-token";
  process.env.GITHUB_ITEMS_DATABASE_ID = "test-db-id";
});

afterEach(() => {
  restoreEnv();
  restoreFetch();
});

/* ── Tests ───────────────────────────────────────────────────────── */

describe("sync-github-items", () => {
  describe("input validation", () => {
    test("fails when no sources and no org_name provided", async () => {
      const result = await executeSyncGitHubItems({}, mockNotionClient([]).client);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("At least one source is required");
      }
    });

    test("fails with empty sources array", async () => {
      const result = await executeSyncGitHubItems(
        { sources: [] },
        mockNotionClient([]).client
      );
      expect(result.success).toBe(false);
    });
  });

  describe("legacy backward compat", () => {
    test("treats org_name as a single org source", async () => {
      mockFetch({
        repos: { "Abstract-Data": [makeRepo("Abstract-Data/repo-a")] },
      });

      const mock = mockNotionClient([]);
      const result = await executeSyncGitHubItems(
        { org_name: "Abstract-Data", dry_run: false },
        mock.client
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.repos_found).toBe(1);
        expect(result.created).toBe(1);
        expect(mock.createdPages.length).toBe(1);
      }
    });
  });

  describe("repo sync", () => {
    test("creates Notion rows for repos not yet tracked", async () => {
      mockFetch({
        repos: {
          "Abstract-Data": [
            makeRepo("Abstract-Data/project-alpha"),
            makeRepo("Abstract-Data/project-beta"),
          ],
        },
      });

      const mock = mockNotionClient([]);
      const result = await executeSyncGitHubItems(
        {
          sources: [{ name: "Abstract-Data", type: "org" }],
          include_issues: false,
          include_prs: false,
          dry_run: false,
        },
        mock.client
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.repos_found).toBe(2);
        expect(result.created).toBe(2);
        expect(mock.createdPages.length).toBe(2);
      }
    });

    test("skips repos already tracked with same updated date", async () => {
      mockFetch({
        repos: {
          "Abstract-Data": [
            makeRepo("Abstract-Data/repo-a", { updatedAt: "2024-06-15T00:00:00Z" }),
          ],
        },
      });

      const mock = mockNotionClient([
        {
          id: "existing-1",
          ghUrl: "https://github.com/Abstract-Data/repo-a",
          type: "Repo",
          updatedAt: "2024-06-15",
        },
      ]);

      const result = await executeSyncGitHubItems(
        {
          sources: [{ name: "Abstract-Data", type: "org" }],
          include_issues: false,
          include_prs: false,
          dry_run: false,
        },
        mock.client
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.skipped).toBe(1);
        expect(result.created).toBe(0);
        expect(result.updated).toBe(0);
        expect(mock.createdPages.length).toBe(0);
        expect(mock.updatedPages.length).toBe(0);
      }
    });

    test("updates repos when GitHub data is newer", async () => {
      mockFetch({
        repos: {
          "Abstract-Data": [
            makeRepo("Abstract-Data/repo-a", { updatedAt: "2024-07-01T00:00:00Z" }),
          ],
        },
      });

      const mock = mockNotionClient([
        {
          id: "existing-1",
          ghUrl: "https://github.com/Abstract-Data/repo-a",
          type: "Repo",
          updatedAt: "2024-06-15",
        },
      ]);

      const result = await executeSyncGitHubItems(
        {
          sources: [{ name: "Abstract-Data", type: "org" }],
          include_issues: false,
          include_prs: false,
          dry_run: false,
        },
        mock.client
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.updated).toBe(1);
        expect(mock.updatedPages.length).toBe(1);
        expect(mock.updatedPages[0]!.page_id).toBe("existing-1");
      }
    });
  });

  describe("issue sync", () => {
    test("creates issues from GitHub", async () => {
      mockFetch({
        repos: {
          JREakin: [makeRepo("JREakin/my-project")],
        },
        issues: {
          "JREakin/my-project": [
            makeIssue("JREakin/my-project", 1),
            makeIssue("JREakin/my-project", 2, { state: "closed" }),
          ],
        },
      });

      const mock = mockNotionClient([]);
      const result = await executeSyncGitHubItems(
        {
          sources: [{ name: "JREakin", type: "user" }],
          include_prs: false,
          dry_run: false,
        },
        mock.client
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.repos_found).toBe(1);
        expect(result.issues_found).toBe(2);
        // 1 repo + 2 issues = 3 created
        expect(result.created).toBe(3);
      }
    });

    test("filters out pull_request items from issues endpoint", async () => {
      mockFetch({
        repos: {
          JREakin: [makeRepo("JREakin/my-project")],
        },
        issues: {
          "JREakin/my-project": [
            makeIssue("JREakin/my-project", 1),
            makeIssue("JREakin/my-project", 2, { isPR: true }),
          ],
        },
      });

      const mock = mockNotionClient([]);
      const result = await executeSyncGitHubItems(
        {
          sources: [{ name: "JREakin", type: "user" }],
          include_prs: false,
          dry_run: false,
        },
        mock.client
      );

      expect(result.success).toBe(true);
      if (result.success) {
        // Only 1 real issue, not the PR-flagged one
        expect(result.issues_found).toBe(1);
        // 1 repo + 1 issue
        expect(result.created).toBe(2);
      }
    });
  });

  describe("PR sync", () => {
    test("creates PRs with correct status mapping", async () => {
      mockFetch({
        repos: {
          JREakin: [makeRepo("JREakin/my-project")],
        },
        prs: {
          "JREakin/my-project": [
            makePR("JREakin/my-project", 10, { state: "open" }),
            makePR("JREakin/my-project", 11, {
              state: "closed",
              mergedAt: "2024-05-01T00:00:00Z",
            }),
            makePR("JREakin/my-project", 12, { state: "closed", mergedAt: null }),
          ],
        },
      });

      const mock = mockNotionClient([]);
      const result = await executeSyncGitHubItems(
        {
          sources: [{ name: "JREakin", type: "user" }],
          include_issues: false,
          dry_run: false,
        },
        mock.client
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.prs_found).toBe(3);
        // 1 repo + 3 PRs
        expect(result.created).toBe(4);

        // Check PR status mapping in created pages
        const prPages = mock.createdPages.filter(
          (p) =>
            (p.properties as Record<string, { select?: { name: string } }>)?.Type
              ?.select?.name === "PR"
        );
        expect(prPages.length).toBe(3);

        const statuses = prPages.map(
          (p) =>
            (p.properties as Record<string, { select?: { name: string } }>)
              ?.Status?.select?.name
        );
        expect(statuses).toContain("Open");
        expect(statuses).toContain("Merged");
        expect(statuses).toContain("Closed");
      }
    });
  });

  describe("dry run", () => {
    test("reports counts but makes no Notion writes", async () => {
      mockFetch({
        repos: {
          "Abstract-Data": [makeRepo("Abstract-Data/repo-a")],
        },
        issues: {
          "Abstract-Data/repo-a": [makeIssue("Abstract-Data/repo-a", 1)],
        },
        prs: {
          "Abstract-Data/repo-a": [makePR("Abstract-Data/repo-a", 5)],
        },
      });

      const mock = mockNotionClient([]);
      const result = await executeSyncGitHubItems(
        {
          sources: [{ name: "Abstract-Data", type: "org" }],
          dry_run: true,
        },
        mock.client
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.repos_found).toBe(1);
        expect(result.issues_found).toBe(1);
        expect(result.prs_found).toBe(1);
        expect(result.created).toBe(3);
        // No actual Notion calls
        expect(mock.createdPages.length).toBe(0);
        expect(mock.updatedPages.length).toBe(0);
        expect(result.summary).toContain("DRY RUN");
      }
    });
  });

  describe("include flags", () => {
    test("skips issues when include_issues is false", async () => {
      const calledUrls: string[] = [];
      globalThis.fetch = (async (url: string) => {
        calledUrls.push(url);
        if (url.includes("/repos/") && (url.includes("/issues") || url.includes("/pulls"))) {
          return { ok: true, status: 200, json: async () => [], headers: new Headers() };
        }
        if (url.includes("/orgs/")) {
          return {
            ok: true,
            status: 200,
            json: async () => [makeRepo("Org/repo")],
            headers: new Headers(),
          };
        }
        return { ok: false, status: 404, json: async () => ({}), headers: new Headers() };
      }) as never;

      const mock = mockNotionClient([]);
      await executeSyncGitHubItems(
        {
          sources: [{ name: "Org", type: "org" }],
          include_issues: false,
          include_prs: true,
          dry_run: false,
        },
        mock.client
      );

      expect(calledUrls.some((u) => u.includes("/issues"))).toBe(false);
      expect(calledUrls.some((u) => u.includes("/pulls"))).toBe(true);
    });

    test("skips PRs when include_prs is false", async () => {
      const calledUrls: string[] = [];
      globalThis.fetch = (async (url: string) => {
        calledUrls.push(url);
        if (url.includes("/repos/") && (url.includes("/issues") || url.includes("/pulls"))) {
          return { ok: true, status: 200, json: async () => [], headers: new Headers() };
        }
        if (url.includes("/orgs/")) {
          return {
            ok: true,
            status: 200,
            json: async () => [makeRepo("Org/repo")],
            headers: new Headers(),
          };
        }
        return { ok: false, status: 404, json: async () => ({}), headers: new Headers() };
      }) as never;

      const mock = mockNotionClient([]);
      await executeSyncGitHubItems(
        {
          sources: [{ name: "Org", type: "org" }],
          include_issues: true,
          include_prs: false,
          dry_run: false,
        },
        mock.client
      );

      expect(calledUrls.some((u) => u.includes("/pulls"))).toBe(false);
      expect(calledUrls.some((u) => u.includes("/issues"))).toBe(true);
    });
  });

  describe("filtering", () => {
    test("excludes forks by default", async () => {
      mockFetch({
        repos: {
          JREakin: [
            makeRepo("JREakin/my-project"),
            makeRepo("JREakin/forked-lib", { fork: true }),
          ],
        },
      });

      const result = await executeSyncGitHubItems(
        {
          sources: [{ name: "JREakin", type: "user" }],
          include_issues: false,
          include_prs: false,
          dry_run: true,
        },
        mockNotionClient([]).client
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.repos_found).toBe(1);
      }
    });

    test("includes archived by default", async () => {
      mockFetch({
        repos: {
          JREakin: [
            makeRepo("JREakin/active"),
            makeRepo("JREakin/old", { archived: true }),
          ],
        },
      });

      const result = await executeSyncGitHubItems(
        {
          sources: [{ name: "JREakin", type: "user" }],
          include_issues: false,
          include_prs: false,
          dry_run: true,
        },
        mockNotionClient([]).client
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.repos_found).toBe(2);
      }
    });
  });

  describe("error handling", () => {
    test("individual create failure does not abort the run", async () => {
      mockFetch({
        repos: {
          "Abstract-Data": [
            makeRepo("Abstract-Data/repo-a"),
            makeRepo("Abstract-Data/repo-b"),
          ],
        },
      });

      let callCount = 0;
      const mock = mockNotionClient([]);
      // Override create to fail on first call
      (mock.client as { pages: { create: Function } }).pages.create = async (
        args: Record<string, unknown>
      ) => {
        callCount++;
        if (callCount === 1) throw new Error("Notion API failure");
        mock.createdPages.push(args);
        return { id: `new-${mock.createdPages.length}` };
      };

      const result = await executeSyncGitHubItems(
        {
          sources: [{ name: "Abstract-Data", type: "org" }],
          include_issues: false,
          include_prs: false,
          dry_run: false,
        },
        mock.client
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.errors).toBe(1);
        expect(result.created).toBe(1); // Second repo succeeded
        expect(result.error_details.length).toBe(1);
        expect(result.error_details[0]).toContain("repo-a");
      }
    });

    test("returns error when GITHUB_TOKEN is missing", async () => {
      delete process.env.GITHUB_TOKEN;

      const result = await executeSyncGitHubItems(
        { sources: [{ name: "MyOrg", type: "org" }] },
        mockNotionClient([]).client
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("GITHUB_TOKEN");
      }
    });
  });

  describe("label filtering", () => {
    test("only maps valid labels", async () => {
      mockFetch({
        repos: {
          JREakin: [makeRepo("JREakin/my-project")],
        },
        issues: {
          "JREakin/my-project": [
            makeIssue("JREakin/my-project", 1, {
              labels: ["bug", "wontfix", "feature", "custom-label"],
            }),
          ],
        },
      });

      const mock = mockNotionClient([]);
      await executeSyncGitHubItems(
        {
          sources: [{ name: "JREakin", type: "user" }],
          include_prs: false,
          dry_run: false,
        },
        mock.client
      );

      // Find the issue create call (not the repo create)
      const issueCreate = mock.createdPages.find(
        (p) =>
          (p.properties as Record<string, { select?: { name: string } }>)?.Type
            ?.select?.name === "Issue"
      );
      expect(issueCreate).toBeDefined();
      const labels = (
        issueCreate!.properties as Record<
          string,
          { multi_select?: Array<{ name: string }> }
        >
      )?.Labels?.multi_select;
      expect(labels).toBeDefined();
      expect(labels!.length).toBe(2); // bug + feature only
      expect(labels!.map((l) => l.name).sort()).toEqual(["bug", "feature"]);
    });
  });

  describe("description truncation", () => {
    test("truncates long descriptions", async () => {
      const longBody = "x".repeat(3000);
      mockFetch({
        repos: {
          JREakin: [makeRepo("JREakin/my-project")],
        },
        issues: {
          "JREakin/my-project": [
            makeIssue("JREakin/my-project", 1, { body: longBody }),
          ],
        },
      });

      const mock = mockNotionClient([]);
      await executeSyncGitHubItems(
        {
          sources: [{ name: "JREakin", type: "user" }],
          include_prs: false,
          dry_run: false,
        },
        mock.client
      );

      const issueCreate = mock.createdPages.find(
        (p) =>
          (p.properties as Record<string, { select?: { name: string } }>)?.Type
            ?.select?.name === "Issue"
      );
      const desc = (
        issueCreate!.properties as Record<
          string,
          { rich_text?: Array<{ text: { content: string } }> }
        >
      )?.Description?.rich_text?.[0]?.text?.content;

      expect(desc).toBeDefined();
      expect(desc!.length).toBeLessThanOrEqual(2000);
      expect(desc!.endsWith("...")).toBe(true);
    });
  });

  describe("multi-source", () => {
    test("syncs repos from both org and user sources", async () => {
      mockFetch({
        repos: {
          "Abstract-Data": [makeRepo("Abstract-Data/alpha")],
          JREakin: [makeRepo("JREakin/beta")],
        },
      });

      const mock = mockNotionClient([]);
      const result = await executeSyncGitHubItems(
        {
          sources: [
            { name: "Abstract-Data", type: "org" },
            { name: "JREakin", type: "user" },
          ],
          include_issues: false,
          include_prs: false,
          dry_run: false,
        },
        mock.client
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.repos_found).toBe(2);
        expect(result.created).toBe(2);
        expect(result.summary).toContain("Abstract-Data");
        expect(result.summary).toContain("JREakin");
      }
    });
  });

  describe("inferTypeFromUrl", () => {
    test("detects Repo from bare repo URL", () => {
      expect(inferTypeFromUrl("https://github.com/Abstract-Data/my-app")).toBe("Repo");
      expect(inferTypeFromUrl("https://github.com/JREakin/project")).toBe("Repo");
    });

    test("detects Issue from /issues/{number} URL", () => {
      expect(inferTypeFromUrl("https://github.com/Abstract-Data/my-app/issues/42")).toBe("Issue");
      expect(inferTypeFromUrl("https://github.com/JREakin/project/issues/1")).toBe("Issue");
    });

    test("detects PR from /pull/{number} URL", () => {
      expect(inferTypeFromUrl("https://github.com/Abstract-Data/my-app/pull/99")).toBe("PR");
      expect(inferTypeFromUrl("https://github.com/JREakin/project/pull/7")).toBe("PR");
    });

    test("returns null for non-GitHub or malformed URLs", () => {
      expect(inferTypeFromUrl("")).toBeNull();
      expect(inferTypeFromUrl("not-a-url")).toBeNull();
      expect(inferTypeFromUrl("https://github.com/")).toBeNull();
      expect(inferTypeFromUrl("https://github.com/owner")).toBeNull();
      expect(inferTypeFromUrl("https://github.com/owner/repo/tree/main")).toBeNull();
    });

    test("does not match /issues/ or /pull/ without a number", () => {
      expect(inferTypeFromUrl("https://github.com/owner/repo/issues")).toBeNull();
      expect(inferTypeFromUrl("https://github.com/owner/repo/pull")).toBeNull();
      expect(inferTypeFromUrl("https://github.com/owner/repo/issues/abc")).toBeNull();
    });
  });

  describe("type mismatch correction", () => {
    test("forces update when existing row has wrong Type even if dates match", async () => {
      mockFetch({
        repos: {
          "Abstract-Data": [
            makeRepo("Abstract-Data/repo-a", { updatedAt: "2024-06-15T00:00:00Z" }),
          ],
        },
        issues: {
          "Abstract-Data/repo-a": [
            makeIssue("Abstract-Data/repo-a", 5, { updatedAt: "2024-06-15T00:00:00Z" }),
          ],
        },
      });

      // The issue exists but is mistagged as "Repo"
      const mock = mockNotionClient([
        {
          id: "existing-repo",
          ghUrl: "https://github.com/Abstract-Data/repo-a",
          type: "Repo",
          updatedAt: "2024-06-15",
        },
        {
          id: "mistagged-issue",
          ghUrl: "https://github.com/Abstract-Data/repo-a/issues/5",
          type: "Repo",    // WRONG — should be "Issue"
          updatedAt: "2024-06-15",
        },
      ]);

      const result = await executeSyncGitHubItems(
        {
          sources: [{ name: "Abstract-Data", type: "org" }],
          include_prs: false,
          dry_run: false,
        },
        mock.client
      );

      expect(result.success).toBe(true);
      if (result.success) {
        // Repo skipped (same date, correct type), issue updated (wrong type)
        expect(result.skipped).toBe(1);
        expect(result.updated).toBe(1);
        expect(mock.updatedPages.length).toBe(1);
        expect(mock.updatedPages[0]!.page_id).toBe("mistagged-issue");

        // Verify the update sets correct Type
        const updatedProps = mock.updatedPages[0]!.properties as Record<
          string,
          { select?: { name: string } }
        >;
        expect(updatedProps.Type?.select?.name).toBe("Issue");
      }
    });

    test("forces update when PR is mistagged as Issue", async () => {
      mockFetch({
        repos: {
          "Abstract-Data": [
            makeRepo("Abstract-Data/repo-a", { updatedAt: "2024-06-15T00:00:00Z" }),
          ],
        },
        prs: {
          "Abstract-Data/repo-a": [
            makePR("Abstract-Data/repo-a", 10, {
              state: "closed",
              mergedAt: "2024-06-10T00:00:00Z",
              updatedAt: "2024-06-15T00:00:00Z",
            }),
          ],
        },
      });

      const mock = mockNotionClient([
        {
          id: "existing-repo",
          ghUrl: "https://github.com/Abstract-Data/repo-a",
          type: "Repo",
          updatedAt: "2024-06-15",
        },
        {
          id: "mistagged-pr",
          ghUrl: "https://github.com/Abstract-Data/repo-a/pull/10",
          type: "Issue",   // WRONG — should be "PR"
          updatedAt: "2024-06-15",
        },
      ]);

      const result = await executeSyncGitHubItems(
        {
          sources: [{ name: "Abstract-Data", type: "org" }],
          include_issues: false,
          dry_run: false,
        },
        mock.client
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.updated).toBe(1);
        expect(mock.updatedPages.length).toBe(1);
        expect(mock.updatedPages[0]!.page_id).toBe("mistagged-pr");

        const updatedProps = mock.updatedPages[0]!.properties as Record<
          string,
          { select?: { name: string } }
        >;
        expect(updatedProps.Type?.select?.name).toBe("PR");
        expect(updatedProps.Status?.select?.name).toBe("Merged");
      }
    });

    test("does not force update when Type already matches", async () => {
      mockFetch({
        repos: {
          "Abstract-Data": [
            makeRepo("Abstract-Data/repo-a", { updatedAt: "2024-06-15T00:00:00Z" }),
          ],
        },
      });

      const mock = mockNotionClient([
        {
          id: "existing-1",
          ghUrl: "https://github.com/Abstract-Data/repo-a",
          type: "Repo",     // Correct type
          updatedAt: "2024-06-15",
        },
      ]);

      const result = await executeSyncGitHubItems(
        {
          sources: [{ name: "Abstract-Data", type: "org" }],
          include_issues: false,
          include_prs: false,
          dry_run: false,
        },
        mock.client
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.skipped).toBe(1);
        expect(result.updated).toBe(0);
        expect(mock.updatedPages.length).toBe(0);
      }
    });
  });

  describe("relation inheritance", () => {
    test("new issue inherits Project and Client from parent repo", async () => {
      mockFetch({
        repos: {
          "Abstract-Data": [
            makeRepo("Abstract-Data/repo-a", { updatedAt: "2024-06-15T00:00:00Z" }),
          ],
        },
        issues: {
          "Abstract-Data/repo-a": [
            makeIssue("Abstract-Data/repo-a", 1),
          ],
        },
      });

      // Repo already exists with Project and Client linked
      const mock = mockNotionClient([
        {
          id: "repo-row",
          ghUrl: "https://github.com/Abstract-Data/repo-a",
          type: "Repo",
          updatedAt: "2024-06-15",
          projectIds: ["proj-page-1"],
          clientIds: ["client-page-1"],
        },
      ]);

      const result = await executeSyncGitHubItems(
        {
          sources: [{ name: "Abstract-Data", type: "org" }],
          include_prs: false,
          dry_run: false,
        },
        mock.client
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.created).toBe(1); // issue only (repo skipped)
        expect(mock.createdPages.length).toBe(1);

        const issueProps = mock.createdPages[0]!.properties as Record<
          string,
          { relation?: Array<{ id: string }> }
        >;
        expect(issueProps.Project?.relation).toEqual([{ id: "proj-page-1" }]);
        expect(issueProps.Client?.relation).toEqual([{ id: "client-page-1" }]);
      }
    });

    test("new PR inherits Project and Client from parent repo", async () => {
      mockFetch({
        repos: {
          "Abstract-Data": [
            makeRepo("Abstract-Data/repo-a", { updatedAt: "2024-06-15T00:00:00Z" }),
          ],
        },
        prs: {
          "Abstract-Data/repo-a": [
            makePR("Abstract-Data/repo-a", 5, { state: "open" }),
          ],
        },
      });

      const mock = mockNotionClient([
        {
          id: "repo-row",
          ghUrl: "https://github.com/Abstract-Data/repo-a",
          type: "Repo",
          updatedAt: "2024-06-15",
          projectIds: ["proj-page-1"],
          clientIds: ["client-page-1", "client-page-2"],
        },
      ]);

      const result = await executeSyncGitHubItems(
        {
          sources: [{ name: "Abstract-Data", type: "org" }],
          include_issues: false,
          dry_run: false,
        },
        mock.client
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.created).toBe(1); // PR only
        expect(mock.createdPages.length).toBe(1);

        const prProps = mock.createdPages[0]!.properties as Record<
          string,
          { relation?: Array<{ id: string }> }
        >;
        expect(prProps.Project?.relation).toEqual([{ id: "proj-page-1" }]);
        expect(prProps.Client?.relation).toEqual([
          { id: "client-page-1" },
          { id: "client-page-2" },
        ]);
      }
    });

    test("no relations set when parent repo has none", async () => {
      mockFetch({
        repos: {
          "Abstract-Data": [
            makeRepo("Abstract-Data/repo-a", { updatedAt: "2024-06-15T00:00:00Z" }),
          ],
        },
        issues: {
          "Abstract-Data/repo-a": [
            makeIssue("Abstract-Data/repo-a", 1),
          ],
        },
      });

      // Repo exists but has NO Project or Client
      const mock = mockNotionClient([
        {
          id: "repo-row",
          ghUrl: "https://github.com/Abstract-Data/repo-a",
          type: "Repo",
          updatedAt: "2024-06-15",
        },
      ]);

      const result = await executeSyncGitHubItems(
        {
          sources: [{ name: "Abstract-Data", type: "org" }],
          include_prs: false,
          dry_run: false,
        },
        mock.client
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(mock.createdPages.length).toBe(1);

        const issueProps = mock.createdPages[0]!.properties as Record<
          string,
          { relation?: Array<{ id: string }> }
        >;
        // No Project or Client properties should be set
        expect(issueProps.Project).toBeUndefined();
        expect(issueProps.Client).toBeUndefined();
      }
    });

    test("relations NOT set on new repo create", async () => {
      mockFetch({
        repos: {
          "Abstract-Data": [makeRepo("Abstract-Data/new-repo")],
        },
      });

      const mock = mockNotionClient([]);
      const result = await executeSyncGitHubItems(
        {
          sources: [{ name: "Abstract-Data", type: "org" }],
          include_issues: false,
          include_prs: false,
          dry_run: false,
        },
        mock.client
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(mock.createdPages.length).toBe(1);

        const repoProps = mock.createdPages[0]!.properties as Record<
          string,
          { relation?: Array<{ id: string }> }
        >;
        // Repos don't get auto-relations — those are set by users/agents
        expect(repoProps.Project).toBeUndefined();
        expect(repoProps.Client).toBeUndefined();
      }
    });

    test("relations NOT overwritten when updating existing issue", async () => {
      mockFetch({
        repos: {
          "Abstract-Data": [
            makeRepo("Abstract-Data/repo-a", { updatedAt: "2024-06-15T00:00:00Z" }),
          ],
        },
        issues: {
          "Abstract-Data/repo-a": [
            makeIssue("Abstract-Data/repo-a", 1, { updatedAt: "2024-07-01T00:00:00Z" }),
          ],
        },
      });

      // Repo has relations, and the issue already exists (will be updated due to newer date)
      const mock = mockNotionClient([
        {
          id: "repo-row",
          ghUrl: "https://github.com/Abstract-Data/repo-a",
          type: "Repo",
          updatedAt: "2024-06-15",
          projectIds: ["proj-page-1"],
          clientIds: ["client-page-1"],
        },
        {
          id: "issue-row",
          ghUrl: "https://github.com/Abstract-Data/repo-a/issues/1",
          type: "Issue",
          updatedAt: "2024-06-15",
          clientIds: ["different-client"],  // manually set — should be preserved
        },
      ]);

      const result = await executeSyncGitHubItems(
        {
          sources: [{ name: "Abstract-Data", type: "org" }],
          include_prs: false,
          dry_run: false,
        },
        mock.client
      );

      expect(result.success).toBe(true);
      if (result.success) {
        // Issue gets updated (newer date) but relations should NOT be in the update properties
        expect(result.updated).toBe(1);
        expect(mock.updatedPages.length).toBe(1);

        const updateProps = mock.updatedPages[0]!.properties as Record<
          string,
          { relation?: Array<{ id: string }> }
        >;
        // Relations should NOT be included in updates — preserves manual assignments
        expect(updateProps.Project).toBeUndefined();
        expect(updateProps.Client).toBeUndefined();
      }
    });

    test("tracks unlinked_repos count", async () => {
      mockFetch({
        repos: {
          "Abstract-Data": [
            makeRepo("Abstract-Data/linked-repo"),
            makeRepo("Abstract-Data/unlinked-repo"),
          ],
        },
      });

      // Only one repo has a Client relation
      const mock = mockNotionClient([
        {
          id: "linked",
          ghUrl: "https://github.com/Abstract-Data/linked-repo",
          type: "Repo",
          updatedAt: "2024-06-15",
          clientIds: ["client-1"],
        },
        {
          id: "unlinked",
          ghUrl: "https://github.com/Abstract-Data/unlinked-repo",
          type: "Repo",
          updatedAt: "2024-06-15",
        },
      ]);

      const result = await executeSyncGitHubItems(
        {
          sources: [{ name: "Abstract-Data", type: "org" }],
          include_issues: false,
          include_prs: false,
          dry_run: false,
        },
        mock.client
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.unlinked_repos).toBe(1);
        expect(result.summary).toContain("1 repos unlinked to Client");
      }
    });
  });

  describe("isNewer (epoch-based timestamp comparison)", () => {
    test("returns true when GitHub timestamp is later than Notion date-only", () => {
      // GitHub: 3pm UTC, Notion: midnight UTC (date-only) → newer
      expect(isNewer("2024-06-15T15:00:00Z", "2024-06-15")).toBe(true);
    });

    test("returns false when timestamps represent the same moment", () => {
      expect(isNewer("2024-06-15T00:00:00Z", "2024-06-15")).toBe(false);
      expect(isNewer("2024-06-15T00:00:00Z", "2024-06-15T00:00:00.000+00:00")).toBe(false);
    });

    test("returns true when GitHub day is strictly after Notion day", () => {
      expect(isNewer("2024-07-01T00:00:00Z", "2024-06-15")).toBe(true);
    });

    test("returns false when GitHub day is before Notion day", () => {
      expect(isNewer("2024-06-01T00:00:00Z", "2024-06-15")).toBe(false);
    });

    test("returns true when existing is empty", () => {
      expect(isNewer("2024-06-15T00:00:00Z", "")).toBe(true);
    });

    test("returns true when existing is unparseable", () => {
      expect(isNewer("2024-06-15T00:00:00Z", "not-a-date")).toBe(true);
    });

    test("returns false when GitHub date is unparseable", () => {
      expect(isNewer("garbage", "2024-06-15")).toBe(false);
    });

    test("handles Notion datetime format vs GitHub Z format", () => {
      // Same instant in different formats → not newer
      expect(isNewer("2024-06-15T15:00:00Z", "2024-06-15T15:00:00.000+00:00")).toBe(false);
      // 1 second later → newer
      expect(isNewer("2024-06-15T15:00:01Z", "2024-06-15T15:00:00.000+00:00")).toBe(true);
    });
  });

  describe("intra-day update detection (regression)", () => {
    test("detects update when GitHub timestamp is later same day", async () => {
      // GitHub item updated at 3pm on June 15
      mockFetch({
        repos: {
          "Abstract-Data": [
            makeRepo("Abstract-Data/repo-a", { updatedAt: "2024-06-15T15:00:00Z" }),
          ],
        },
      });

      // Notion row was synced earlier the same day (stores midnight via old date-only format)
      const mock = mockNotionClient([
        {
          id: "existing-1",
          ghUrl: "https://github.com/Abstract-Data/repo-a",
          type: "Repo",
          updatedAt: "2024-06-15",  // date-only = midnight UTC
        },
      ]);

      const result = await executeSyncGitHubItems(
        {
          sources: [{ name: "Abstract-Data", type: "org" }],
          include_issues: false,
          include_prs: false,
          dry_run: false,
        },
        mock.client
      );

      expect(result.success).toBe(true);
      if (result.success) {
        // Should detect that 15:00 UTC is newer than midnight UTC
        expect(result.updated).toBe(1);
        expect(result.skipped).toBe(0);
        expect(mock.updatedPages.length).toBe(1);
      }
    });
  });

  describe("incremental sync (updated_since_days)", () => {
    test("passes since parameter to GitHub issues endpoint", async () => {
      const calledUrls: string[] = [];
      globalThis.fetch = (async (url: string) => {
        calledUrls.push(url);
        if (url.includes("/orgs/")) {
          return {
            ok: true,
            status: 200,
            json: async () => [makeRepo("Org/repo-a")],
            headers: new Headers(),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => [],
          headers: new Headers(),
        };
      }) as never;

      const mock = mockNotionClient([]);
      await executeSyncGitHubItems(
        {
          sources: [{ name: "Org", type: "org" }],
          updated_since_days: 7,
          dry_run: false,
        },
        mock.client
      );

      const issueUrl = calledUrls.find((u) => u.includes("/issues"));
      expect(issueUrl).toBeDefined();
      expect(issueUrl!).toContain("&since=");
    });

    test("passes sort=updated&direction=desc to GitHub PRs endpoint when since provided", async () => {
      const calledUrls: string[] = [];
      globalThis.fetch = (async (url: string) => {
        calledUrls.push(url);
        if (url.includes("/orgs/")) {
          return {
            ok: true,
            status: 200,
            json: async () => [makeRepo("Org/repo-a")],
            headers: new Headers(),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => [],
          headers: new Headers(),
        };
      }) as never;

      const mock = mockNotionClient([]);
      await executeSyncGitHubItems(
        {
          sources: [{ name: "Org", type: "org" }],
          updated_since_days: 7,
          dry_run: false,
        },
        mock.client
      );

      const prUrl = calledUrls.find((u) => u.includes("/pulls"));
      expect(prUrl).toBeDefined();
      expect(prUrl!).toContain("sort=updated");
      expect(prUrl!).toContain("direction=desc");
    });

    test("omitting updated_since_days does NOT add since to issues URL", async () => {
      const calledUrls: string[] = [];
      globalThis.fetch = (async (url: string) => {
        calledUrls.push(url);
        if (url.includes("/orgs/")) {
          return {
            ok: true,
            status: 200,
            json: async () => [makeRepo("Org/repo-a")],
            headers: new Headers(),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => [],
          headers: new Headers(),
        };
      }) as never;

      const mock = mockNotionClient([]);
      await executeSyncGitHubItems(
        {
          sources: [{ name: "Org", type: "org" }],
          // no updated_since_days
          dry_run: false,
        },
        mock.client
      );

      const issueUrl = calledUrls.find((u) => u.includes("/issues"));
      expect(issueUrl).toBeDefined();
      expect(issueUrl!).not.toContain("&since=");
    });

    test("PR early-stop: skips PRs older than cutoff", async () => {
      // Return PRs sorted by updated desc. The second one is older than the cutoff.
      globalThis.fetch = (async (url: string) => {
        if (url.includes("/orgs/")) {
          return {
            ok: true,
            status: 200,
            json: async () => [makeRepo("Org/repo-a")],
            headers: new Headers(),
          };
        }
        if (url.includes("/issues")) {
          return {
            ok: true,
            status: 200,
            json: async () => [],
            headers: new Headers(),
          };
        }
        if (url.includes("/pulls")) {
          return {
            ok: true,
            status: 200,
            json: async () => [
              makePR("Org/repo-a", 2, { updatedAt: "2026-03-09T00:00:00Z" }),
              makePR("Org/repo-a", 1, { updatedAt: "2026-02-01T00:00:00Z" }),
            ],
            headers: new Headers(),
          };
        }
        return { ok: false, status: 404, json: async () => ({}), headers: new Headers() };
      }) as never;

      const mock = mockNotionClient([]);
      const result = await executeSyncGitHubItems(
        {
          sources: [{ name: "Org", type: "org" }],
          include_issues: false,
          updated_since_days: 7, // cutoff ≈ 2026-03-03
          dry_run: false,
        },
        mock.client
      );

      expect(result.success).toBe(true);
      if (result.success) {
        // Only the recent PR should be counted (the old one is before cutoff)
        expect(result.prs_found).toBe(1);
        // 1 repo + 1 PR
        expect(result.created).toBe(2);
      }
    });

    test("concurrent repo processing: all repos synced correctly", async () => {
      // Create 8 repos to test batching (batch size = 5)
      const repoNames = Array.from({ length: 8 }, (_, i) => `Org/repo-${i}`);
      const repos = repoNames.map((name) => makeRepo(name));

      mockFetch({
        repos: { Org: repos },
      });

      const mock = mockNotionClient([]);
      const result = await executeSyncGitHubItems(
        {
          sources: [{ name: "Org", type: "org" }],
          include_issues: false,
          include_prs: false,
          dry_run: false,
        },
        mock.client
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.repos_found).toBe(8);
        expect(result.created).toBe(8);
        expect(mock.createdPages.length).toBe(8);
      }
    });
  });

  describe("max_writes_per_run (write budget)", () => {
    test("caps total creates + updates and defers remaining items", async () => {
      // 1 repo + 3 issues = 4 writes needed (1 repo create + 3 issue creates)
      mockFetch({
        repos: {
          "Abstract-Data": [makeRepo("Abstract-Data/repo-a")],
        },
        issues: {
          "Abstract-Data/repo-a": [
            makeIssue("Abstract-Data/repo-a", 1),
            makeIssue("Abstract-Data/repo-a", 2),
            makeIssue("Abstract-Data/repo-a", 3),
          ],
        },
      });

      const mock = mockNotionClient([]);
      const result = await executeSyncGitHubItems(
        {
          sources: [{ name: "Abstract-Data", type: "org" }],
          include_prs: false,
          dry_run: false,
          max_writes_per_run: 2,
        },
        mock.client
      );

      expect(result.success).toBe(true);
      if (result.success) {
        // Only 2 writes allowed: repo + first issue
        expect(result.created).toBe(2);
        // Remaining issues deferred
        expect(result.summary).toContain("Budget exhausted");
        expect(result.summary).toContain("deferred");
      }
    });

    test("no budget cap when max_writes_per_run is omitted", async () => {
      mockFetch({
        repos: {
          "Abstract-Data": [makeRepo("Abstract-Data/repo-a")],
        },
        issues: {
          "Abstract-Data/repo-a": [
            makeIssue("Abstract-Data/repo-a", 1),
            makeIssue("Abstract-Data/repo-a", 2),
            makeIssue("Abstract-Data/repo-a", 3),
          ],
        },
      });

      const mock = mockNotionClient([]);
      const result = await executeSyncGitHubItems(
        {
          sources: [{ name: "Abstract-Data", type: "org" }],
          include_prs: false,
          dry_run: false,
          // no max_writes_per_run
        },
        mock.client
      );

      expect(result.success).toBe(true);
      if (result.success) {
        // All items created: 1 repo + 3 issues
        expect(result.created).toBe(4);
        expect(result.summary).not.toContain("Budget exhausted");
      }
    });

    test("budget counts updates too, not just creates", async () => {
      // Repo already exists with old date → will be updated.
      // 2 new issues → will be created.
      // Budget = 2 → repo update + 1 issue create, then budget exhausted.
      mockFetch({
        repos: {
          "Abstract-Data": [
            makeRepo("Abstract-Data/repo-a", { updatedAt: "2024-07-01T00:00:00Z" }),
          ],
        },
        issues: {
          "Abstract-Data/repo-a": [
            makeIssue("Abstract-Data/repo-a", 1),
            makeIssue("Abstract-Data/repo-a", 2),
          ],
        },
      });

      const mock = mockNotionClient([
        {
          id: "existing-repo",
          ghUrl: "https://github.com/Abstract-Data/repo-a",
          type: "Repo",
          updatedAt: "2024-06-15",
        },
      ]);

      const result = await executeSyncGitHubItems(
        {
          sources: [{ name: "Abstract-Data", type: "org" }],
          include_prs: false,
          dry_run: false,
          max_writes_per_run: 2,
        },
        mock.client
      );

      expect(result.success).toBe(true);
      if (result.success) {
        // 1 update (repo) + 1 create (first issue) = 2 writes
        expect(result.updated + result.created).toBe(2);
        expect(result.summary).toContain("Budget exhausted");
      }
    });

    test("dry run bypasses internal cap for accurate counting", async () => {
      // In dry-run mode, all items should be counted even without max_writes_per_run.
      // The internal cap (INTERNAL_WRITE_CAP=150) must NOT apply to dry runs.
      mockFetch({
        repos: {
          "Abstract-Data": [makeRepo("Abstract-Data/repo-a")],
        },
        issues: {
          "Abstract-Data/repo-a": [
            makeIssue("Abstract-Data/repo-a", 1),
            makeIssue("Abstract-Data/repo-a", 2),
          ],
        },
      });

      const mock = mockNotionClient([]);
      const result = await executeSyncGitHubItems(
        {
          sources: [{ name: "Abstract-Data", type: "org" }],
          include_prs: false,
          dry_run: true,
          // no max_writes_per_run — dry run should still count everything
        },
        mock.client
      );

      expect(result.success).toBe(true);
      if (result.success) {
        // 1 repo + 2 issues = 3 would-be writes, all counted
        expect(result.created).toBe(3);
        expect(result.summary).toContain("DRY RUN");
        expect(result.summary).not.toContain("Budget exhausted");
        // No actual Notion writes
        expect(mock.createdPages.length).toBe(0);
      }
    });

    test("budget of 0 means unlimited", async () => {
      mockFetch({
        repos: {
          "Abstract-Data": [makeRepo("Abstract-Data/repo-a")],
        },
        issues: {
          "Abstract-Data/repo-a": [
            makeIssue("Abstract-Data/repo-a", 1),
          ],
        },
      });

      const mock = mockNotionClient([]);
      const result = await executeSyncGitHubItems(
        {
          sources: [{ name: "Abstract-Data", type: "org" }],
          include_prs: false,
          dry_run: false,
          max_writes_per_run: 0,
        },
        mock.client
      );

      expect(result.success).toBe(true);
      if (result.success) {
        // All items created: 1 repo + 1 issue
        expect(result.created).toBe(2);
        expect(result.summary).not.toContain("Budget exhausted");
      }
    });
  });

  describe("write concurrency within repos", () => {
    test("multiple issues in a repo are all synced correctly", async () => {
      // 1 repo + 5 issues → all should be created
      const issues = Array.from({ length: 5 }, (_, i) =>
        makeIssue("Abstract-Data/repo-a", i + 1)
      );

      mockFetch({
        repos: {
          "Abstract-Data": [makeRepo("Abstract-Data/repo-a")],
        },
        issues: {
          "Abstract-Data/repo-a": issues,
        },
      });

      const mock = mockNotionClient([]);
      const result = await executeSyncGitHubItems(
        {
          sources: [{ name: "Abstract-Data", type: "org" }],
          include_prs: false,
          dry_run: false,
        },
        mock.client
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.issues_found).toBe(5);
        // 1 repo + 5 issues
        expect(result.created).toBe(6);
        expect(mock.createdPages.length).toBe(6);
      }
    });

    test("multiple PRs in a repo are all synced correctly", async () => {
      const prs = Array.from({ length: 4 }, (_, i) =>
        makePR("Abstract-Data/repo-a", i + 10)
      );

      mockFetch({
        repos: {
          "Abstract-Data": [makeRepo("Abstract-Data/repo-a")],
        },
        prs: {
          "Abstract-Data/repo-a": prs,
        },
      });

      const mock = mockNotionClient([]);
      const result = await executeSyncGitHubItems(
        {
          sources: [{ name: "Abstract-Data", type: "org" }],
          include_issues: false,
          dry_run: false,
        },
        mock.client
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.prs_found).toBe(4);
        // 1 repo + 4 PRs
        expect(result.created).toBe(5);
        expect(mock.createdPages.length).toBe(5);
      }
    });
  });
});
