import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  MemoryPrEstimateStore,
  processMergedPr,
  buildPrDescription,
  isLiveWriteEnabled,
  type GitHubFetcher,
} from "../../src/workers/pr-estimate-writer.js";
import { PR_ESTIMATE_SOURCE } from "../../src/shared/pr-estimate-ownership.js";
import type { PrEstimateWriterInput } from "../../src/shared/types.js";

const item = {
  id: "gh-1",
  title: "Add feature",
  githubUrl: "https://github.com/jreakin/v0-quorum-report-redesign-concep/pull/42",
  repo: "jreakin/v0-quorum-report-redesign-concep",
  clientIds: ["client-1"],
  projectIds: ["proj-1"],
  prNumber: 42,
  owner: "jreakin",
  repoName: "v0-quorum-report-redesign-concep",
};

function mockGithub(overrides: Partial<GitHubPrFetchResult> = {}): GitHubFetcher {
  return {
    async fetchPrData() {
      return {
        mergeDate: "2026-03-10",
        files: [
          { filename: "src/a.ts", additions: 600, deletions: 200 },
          { filename: "README.md", additions: 300, deletions: 0 },
        ],
        gitAttributes: null,
        ...overrides,
      };
    },
  };
}

interface GitHubPrFetchResult {
  mergeDate: string;
  files: Array<{ filename: string; additions: number; deletions: number }>;
  gitAttributes: string | null;
}

describe("pr-estimate-writer", () => {
  let savedLive: string | undefined;

  beforeEach(() => {
    savedLive = process.env.PR_ESTIMATE_WRITER_LIVE;
  });

  afterEach(() => {
    if (savedLive === undefined) delete process.env.PR_ESTIMATE_WRITER_LIVE;
    else process.env.PR_ESTIMATE_WRITER_LIVE = savedLive;
  });

  test("dry-run default — isLiveWriteEnabled false", () => {
    delete process.env.PR_ESTIMATE_WRITER_LIVE;
    expect(isLiveWriteEnabled({})).toBe(false);
    expect(isLiveWriteEnabled({ dry_run: true })).toBe(false);
    expect(isLiveWriteEnabled({ dry_run: false })).toBe(false);
    process.env.PR_ESTIMATE_WRITER_LIVE = "1";
    expect(isLiveWriteEnabled({ dry_run: false })).toBe(true);
  });

  test("creates row with PR estimate source fields on live run", async () => {
    const store = new MemoryPrEstimateStore();
    store.items = [item];

    const result = await processMergedPr({
      item,
      store,
      github: mockGithub(),
      dryRun: false,
    });

    expect(result.action).toBe("created");
    expect(result.hours).toBe(5.25);
    expect(store.timeLogRows).toHaveLength(1);
    const row = store.timeLogRows[0]!;
    expect(row.source).toBe(PR_ESTIMATE_SOURCE);
    expect(row.billingStatus).toBe("Unbilled");
    expect(row.billable).toBe(false);
    expect(store.estHoursUpdates[0]?.hours).toBe(5.25);
  });

  test("PR estimate row with empty billing status skipped on rerun", async () => {
    const store = new MemoryPrEstimateStore();
    store.items = [item];
    store.timeLogRows.push({
      id: "tl-1",
      githubItemId: "gh-1",
      githubUrl: item.githubUrl,
      description: "old",
      hours: 4,
      date: "2026-03-10",
      source: PR_ESTIMATE_SOURCE,
      billingStatus: "",
      billable: false,
      projectIds: ["proj-1"],
      clientIds: ["client-1"],
    });

    const result = await processMergedPr({
      item,
      store,
      github: mockGithub(),
      dryRun: false,
    });

    expect(result.action).toBe("skipped");
    expect(result.reason).toContain("unknown");
    expect(store.timeLogRows[0]!.hours).toBe(4);
  });

  test("idempotency updates existing PR estimate row", async () => {
    const store = new MemoryPrEstimateStore();
    store.items = [item];
    store.timeLogRows.push({
      id: "tl-1",
      githubItemId: "gh-1",
      githubUrl: item.githubUrl,
      description: "old",
      hours: 4,
      date: "2026-03-10",
      source: PR_ESTIMATE_SOURCE,
      billingStatus: "Unbilled",
      billable: false,
      projectIds: ["proj-1"],
      clientIds: ["client-1"],
    });

    const result = await processMergedPr({
      item,
      store,
      github: mockGithub(),
      dryRun: false,
    });

    expect(result.action).toBe("updated");
    expect(store.timeLogRows).toHaveLength(1);
    expect(store.timeLogRows[0]!.hours).toBe(5.25);
  });

  test("untouched rows — manual and auditor stubs skipped", async () => {
    const store = new MemoryPrEstimateStore();
    store.items = [item];

    for (const source of ["Manual", "Auditor EST (superseded)", ""]) {
      store.timeLogRows = [{
        id: "tl-x",
        githubItemId: "gh-1",
        githubUrl: item.githubUrl,
        description: "protected",
        hours: 2,
        date: "2026-01-01",
        source,
        billingStatus: source === "" ? "" : "Unbilled",
        billable: false,
        projectIds: [],
        clientIds: [],
      }];

      const result = await processMergedPr({
        item,
        store,
        github: mockGithub(),
        dryRun: false,
      });

      expect(result.action).toBe("skipped");
    }
  });

  test("over-cap adds flag to description", async () => {
    const store = new MemoryPrEstimateStore();
    const bigFiles = [{ filename: "huge.ts", additions: 5000, deletions: 0 }];
    const result = await processMergedPr({
      item,
      store,
      github: mockGithub({ files: bigFiles }),
      dryRun: true,
    });
    expect(result.over_cap).toBe(true);
    expect(result.hours).toBe(8);
    const desc = buildPrDescription(item.title, item.prNumber, item.repo, [
      "⚠ OVER CAP (raw 33.25 h)",
    ]);
    expect(desc).toContain("OVER CAP");
  });

  test("late PR uses next open period date", async () => {
    const store = new MemoryPrEstimateStore();
    store.periodRows = [
      { projectId: "proj-1", date: "2026-02-05", billingStatus: "Invoiced" },
    ];

    await processMergedPr({
      item,
      store,
      github: mockGithub({ mergeDate: "2026-02-15" }),
      dryRun: false,
      asOfDate: "2026-04-01",
    });

    const row = store.timeLogRows[0]!;
    expect(row.date).toBe("2026-04-01");
    expect(row.description).toContain("merged 2026-02-15");
  });
});
