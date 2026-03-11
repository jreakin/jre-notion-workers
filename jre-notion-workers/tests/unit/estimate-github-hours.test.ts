/**
 * Unit tests for estimate-github-hours worker.
 * Mocks global fetch to avoid real GitHub API calls.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { executeEstimateGitHubHours } from "../../src/workers/estimate-github-hours.js";
import type { EstimateGitHubHoursInput } from "../../src/shared/types.js";

/* ── Env helpers ────────────────────────────────────────────────────── */

let savedEnv: Record<string, string | undefined>;

function setupEnv() {
  savedEnv = { GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  process.env.GITHUB_TOKEN = "ghp_test_token_123";
}

function restoreEnv() {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/* ── Fetch mock helpers ─────────────────────────────────────────────── */

const originalFetch = globalThis.fetch;

function mockFetch(handler: (url: string, opts?: RequestInit) => Promise<Response>) {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = handler as typeof fetch;
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

function rateLimitResponse(): Response {
  return new Response("rate limited", {
    status: 403,
    headers: { "x-ratelimit-remaining": "0" },
  });
}

/* ── Test data factories ────────────────────────────────────────────── */

function makePR(overrides?: Partial<{ additions: number; deletions: number; changed_files: number; labels: Array<{ name: string }> }>) {
  return {
    additions: overrides?.additions ?? 80,
    deletions: overrides?.deletions ?? 20,
    changed_files: overrides?.changed_files ?? 3,
    title: "Fix widget rendering",
    body: "Fixes a bug with the widget component.",
    labels: overrides?.labels ?? [{ name: "bug" }],
  };
}

function makeFiles(count: number, prefix = "src"): Array<{ filename: string; additions: number; deletions: number; changes: number }> {
  return Array.from({ length: count }, (_, i) => ({
    filename: `${prefix}/file-${i}.ts`,
    additions: 10,
    deletions: 5,
    changes: 15,
  }));
}

function makeIssue(overrides?: Partial<{ body: string | null; labels: Array<{ name: string }> }>) {
  return {
    title: "Implement dark mode",
    body: overrides?.body ?? "We need dark mode for the app. This involves updating the theme system and all components.",
    labels: overrides?.labels ?? [{ name: "feature" }],
  };
}

/* ── Tests ──────────────────────────────────────────────────────────── */

describe("estimate-github-hours", () => {
  beforeEach(() => setupEnv());
  afterEach(() => {
    restoreEnv();
    restoreFetch();
  });

  // ── Validation tests ──────────────────────────────────────────────

  test("returns error when GITHUB_TOKEN is not set", async () => {
    delete process.env.GITHUB_TOKEN;
    const result = await executeEstimateGitHubHours({
      owner: "Abstract-Data", repo: "test", number: 1, type: "pr",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("GITHUB_TOKEN");
  });

  test("returns error when owner is empty", async () => {
    const result = await executeEstimateGitHubHours({
      owner: "", repo: "test", number: 1, type: "pr",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("owner");
  });

  test("returns error when repo is empty", async () => {
    const result = await executeEstimateGitHubHours({
      owner: "Abstract-Data", repo: "", number: 1, type: "pr",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("repo");
  });

  test("returns error when number is invalid", async () => {
    const result = await executeEstimateGitHubHours({
      owner: "Abstract-Data", repo: "test", number: 0, type: "pr",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("number");
  });

  test("returns error when type is invalid", async () => {
    const result = await executeEstimateGitHubHours({
      owner: "Abstract-Data", repo: "test", number: 1, type: "other" as "pr",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("type");
  });

  // ── PR estimation tests ───────────────────────────────────────────

  test("PR: small bug fix (100 lines, bug label) → ~1h, high confidence", async () => {
    const pr = makePR({ additions: 60, deletions: 40, changed_files: 2, labels: [{ name: "bug" }] });
    const files = makeFiles(2);

    mockFetch(async (url) => {
      if (url.includes("/pulls/42/files")) return jsonResponse(files);
      if (url.includes("/pulls/42")) return jsonResponse(pr);
      return jsonResponse({}, 404);
    });

    const result = await executeEstimateGitHubHours({
      owner: "Abstract-Data", repo: "test-app", number: 42, type: "pr",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.estimatedHours).toBe(1); // 1h base × 1.0 bug + 0 complexity
      expect(result.confidence).toBe("high");
      expect(result.breakdown.baseEstimate).toBe(1);
      expect(result.breakdown.labelMultiplier).toBe(1.0);
      expect(result.breakdown.complexityFactor).toBe(0);
    }
  });

  test("PR: feature with many files across directories → higher estimate with complexity", async () => {
    const pr = makePR({
      additions: 250,
      deletions: 50,
      changed_files: 8,
      labels: [{ name: "feature" }],
    });
    // Files across 3+ directories with test files
    const files = [
      { filename: "src/components/Widget.tsx", additions: 100, deletions: 20, changes: 120 },
      { filename: "src/hooks/useWidget.ts", additions: 40, deletions: 10, changes: 50 },
      { filename: "src/utils/widget-helpers.ts", additions: 30, deletions: 5, changes: 35 },
      { filename: "api/routes/widget.ts", additions: 30, deletions: 5, changes: 35 },
      { filename: "tests/widget.test.ts", additions: 40, deletions: 5, changes: 45 },
      { filename: "tests/hooks.test.ts", additions: 10, deletions: 5, changes: 15 },
      { filename: "docs/widget.md", additions: 5, deletions: 0, changes: 5 },
      { filename: "config/widget.json", additions: 5, deletions: 0, changes: 5 },
    ];

    mockFetch(async (url) => {
      if (url.includes("/pulls/99/files")) return jsonResponse(files);
      if (url.includes("/pulls/99")) return jsonResponse(pr);
      return jsonResponse({}, 404);
    });

    const result = await executeEstimateGitHubHours({
      owner: "Abstract-Data", repo: "platform", number: 99, type: "pr",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      // 300 lines → 2h base × 1.5 feature + (0.5 >5 files + 0.5 >2 dirs + 0.5 tests) = 4.5h
      expect(result.estimatedHours).toBe(4.5);
      expect(result.confidence).toBe("high"); // has labels + <800 lines + <10 files → all 3 conditions met
      expect(result.breakdown.baseEstimate).toBe(2);
      expect(result.breakdown.labelMultiplier).toBe(1.5);
      expect(result.breakdown.complexityFactor).toBe(1.5);
    }
  });

  test("PR: documentation label → 0.5 multiplier", async () => {
    const pr = makePR({
      additions: 100,
      deletions: 20,
      changed_files: 2,
      labels: [{ name: "documentation" }],
    });
    const files = makeFiles(2, "docs");

    mockFetch(async (url) => {
      if (url.includes("/pulls/10/files")) return jsonResponse(files);
      if (url.includes("/pulls/10")) return jsonResponse(pr);
      return jsonResponse({}, 404);
    });

    const result = await executeEstimateGitHubHours({
      owner: "Abstract-Data", repo: "docs", number: 10, type: "pr",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      // 120 lines → 1h base × 0.5 docs = 0.5h
      expect(result.estimatedHours).toBe(0.5);
      expect(result.breakdown.labelMultiplier).toBe(0.5);
    }
  });

  test("PR: no labels → multiplier 1.0", async () => {
    const pr = makePR({ additions: 30, deletions: 10, changed_files: 1, labels: [] });
    const files = makeFiles(1);

    mockFetch(async (url) => {
      if (url.includes("/pulls/5/files")) return jsonResponse(files);
      if (url.includes("/pulls/5")) return jsonResponse(pr);
      return jsonResponse({}, 404);
    });

    const result = await executeEstimateGitHubHours({
      owner: "Abstract-Data", repo: "test", number: 5, type: "pr",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      // 40 lines → 0.5h base × 1.0 no labels + 0 complexity
      expect(result.estimatedHours).toBe(0.5);
      expect(result.breakdown.labelMultiplier).toBe(1.0);
    }
  });

  test("PR: very large (1600+ lines) → 8h base, low confidence", async () => {
    const pr = makePR({
      additions: 1200,
      deletions: 500,
      changed_files: 15,
      labels: [{ name: "feature" }],
    });
    const files = makeFiles(15);

    mockFetch(async (url) => {
      if (url.includes("/pulls/200/files")) return jsonResponse(files);
      if (url.includes("/pulls/200")) return jsonResponse(pr);
      return jsonResponse({}, 404);
    });

    const result = await executeEstimateGitHubHours({
      owner: "Abstract-Data", repo: "platform", number: 200, type: "pr",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      // 1700 lines → 8h base × 1.5 feature + capped complexity
      expect(result.estimatedHours).toBeGreaterThanOrEqual(8);
      expect(result.confidence).toBe("low"); // 1500+ lines
    }
  });

  test("PR: enhancement label → 1.2 multiplier", async () => {
    const pr = makePR({
      additions: 100,
      deletions: 50,
      changed_files: 3,
      labels: [{ name: "enhancement" }],
    });
    const files = makeFiles(3);

    mockFetch(async (url) => {
      if (url.includes("/pulls/15/files")) return jsonResponse(files);
      if (url.includes("/pulls/15")) return jsonResponse(pr);
      return jsonResponse({}, 404);
    });

    const result = await executeEstimateGitHubHours({
      owner: "Abstract-Data", repo: "app", number: 15, type: "pr",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      // 150 lines → 1h base × 1.2 enhancement = 1.25 → rounds to 1.25
      expect(result.estimatedHours).toBe(1.25);
      expect(result.breakdown.labelMultiplier).toBe(1.2);
    }
  });

  // ── Issue estimation tests ────────────────────────────────────────

  test("Issue: feature label, medium body → 5h × 1.0 = 5h, low confidence", async () => {
    const issue = makeIssue({
      body: "A".repeat(500), // 500 chars → ×1.0
      labels: [{ name: "feature" }],
    });

    mockFetch(async (url) => {
      if (url.includes("/issues/30")) return jsonResponse(issue);
      return jsonResponse({}, 404);
    });

    const result = await executeEstimateGitHubHours({
      owner: "Abstract-Data", repo: "app", number: 30, type: "issue",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.estimatedHours).toBe(5);
      expect(result.confidence).toBe("low"); // always low for issues
      expect(result.breakdown.baseEstimate).toBe(5);
      expect(result.breakdown.labelMultiplier).toBe(1.0);
      expect(result.breakdown.complexityFactor).toBe(0);
    }
  });

  test("Issue: bug label, short body → 2h × 0.8 = 1.5h", async () => {
    const issue = makeIssue({
      body: "Short bug.", // < 200 chars → ×0.8
      labels: [{ name: "bug" }],
    });

    mockFetch(async (url) => {
      if (url.includes("/issues/31")) return jsonResponse(issue);
      return jsonResponse({}, 404);
    });

    const result = await executeEstimateGitHubHours({
      owner: "Abstract-Data", repo: "app", number: 31, type: "issue",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      // 2h × 0.8 = 1.6 → rounds to 1.5
      expect(result.estimatedHours).toBe(1.5);
      expect(result.breakdown.baseEstimate).toBe(2);
      expect(result.breakdown.labelMultiplier).toBe(0.8);
    }
  });

  test("Issue: documentation label, long body → 0.5h × 1.3 = 0.75h", async () => {
    const issue = makeIssue({
      body: "A".repeat(1200), // > 1000 chars → ×1.3
      labels: [{ name: "documentation" }],
    });

    mockFetch(async (url) => {
      if (url.includes("/issues/32")) return jsonResponse(issue);
      return jsonResponse({}, 404);
    });

    const result = await executeEstimateGitHubHours({
      owner: "Abstract-Data", repo: "app", number: 32, type: "issue",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      // 0.5h × 1.3 = 0.65 → rounds to 0.75
      expect(result.estimatedHours).toBe(0.75);
      expect(result.breakdown.baseEstimate).toBe(0.5);
      expect(result.breakdown.labelMultiplier).toBe(1.3);
    }
  });

  test("Issue: no labels → 2h default", async () => {
    const issue = makeIssue({
      body: "A".repeat(500),
      labels: [],
    });

    mockFetch(async (url) => {
      if (url.includes("/issues/33")) return jsonResponse(issue);
      return jsonResponse({}, 404);
    });

    const result = await executeEstimateGitHubHours({
      owner: "Abstract-Data", repo: "app", number: 33, type: "issue",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.estimatedHours).toBe(2);
      expect(result.breakdown.baseEstimate).toBe(2);
    }
  });

  test("Issue: good first issue label → 1h", async () => {
    const issue = makeIssue({
      body: "A".repeat(500),
      labels: [{ name: "good first issue" }],
    });

    mockFetch(async (url) => {
      if (url.includes("/issues/34")) return jsonResponse(issue);
      return jsonResponse({}, 404);
    });

    const result = await executeEstimateGitHubHours({
      owner: "Abstract-Data", repo: "app", number: 34, type: "issue",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.estimatedHours).toBe(1);
      expect(result.breakdown.baseEstimate).toBe(1);
    }
  });

  // ── Error handling tests ──────────────────────────────────────────

  test("handles 404 gracefully", async () => {
    mockFetch(async () => jsonResponse({ message: "Not Found" }, 404));

    const result = await executeEstimateGitHubHours({
      owner: "Abstract-Data", repo: "deleted-repo", number: 1, type: "pr",
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("not found");
  });

  test("handles rate limiting gracefully", async () => {
    mockFetch(async () => rateLimitResponse());

    const result = await executeEstimateGitHubHours({
      owner: "Abstract-Data", repo: "test", number: 1, type: "pr",
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("rate limit");
  });

  test("handles fetch error gracefully", async () => {
    mockFetch(async () => {
      throw new Error("Network failure");
    });

    const result = await executeEstimateGitHubHours({
      owner: "Abstract-Data", repo: "test", number: 1, type: "pr",
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("Network failure");
  });

  // ── Round to quarter tests ────────────────────────────────────────

  test("PR: estimates round to nearest 0.25", async () => {
    // 151–400 → 2h base, enhancement → ×1.2 = 2.4, 3 files in one dir, no tests → 0 complexity
    // raw = 2.4 → rounds to 2.5
    const pr = makePR({
      additions: 120,
      deletions: 40,
      changed_files: 3,
      labels: [{ name: "enhancement" }],
    });
    const files = makeFiles(3);

    mockFetch(async (url) => {
      if (url.includes("/pulls/50/files")) return jsonResponse(files);
      if (url.includes("/pulls/50")) return jsonResponse(pr);
      return jsonResponse({}, 404);
    });

    const result = await executeEstimateGitHubHours({
      owner: "Abstract-Data", repo: "test", number: 50, type: "pr",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      // Should be a multiple of 0.25
      expect(result.estimatedHours % 0.25).toBe(0);
    }
  });

  // ── Confidence level tests ────────────────────────────────────────

  test("PR: high confidence when labels + small diff + few files", async () => {
    const pr = makePR({ additions: 30, deletions: 10, changed_files: 2, labels: [{ name: "bug" }] });
    const files = makeFiles(2);

    mockFetch(async (url) => {
      if (url.includes("/pulls/60/files")) return jsonResponse(files);
      if (url.includes("/pulls/60")) return jsonResponse(pr);
      return jsonResponse({}, 404);
    });

    const result = await executeEstimateGitHubHours({
      owner: "Abstract-Data", repo: "test", number: 60, type: "pr",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.confidence).toBe("high");
    }
  });

  test("PR: medium confidence when missing labels but small diff and few files", async () => {
    const pr = makePR({ additions: 30, deletions: 10, changed_files: 2, labels: [] });
    const files = makeFiles(2);

    mockFetch(async (url) => {
      if (url.includes("/pulls/61/files")) return jsonResponse(files);
      if (url.includes("/pulls/61")) return jsonResponse(pr);
      return jsonResponse({}, 404);
    });

    const result = await executeEstimateGitHubHours({
      owner: "Abstract-Data", repo: "test", number: 61, type: "pr",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.confidence).toBe("medium"); // missing labels but other 2 conditions met
    }
  });
});
