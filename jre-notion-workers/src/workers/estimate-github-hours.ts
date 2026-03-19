/**
 * estimate-github-hours: Calls the GitHub API to analyze a PR or issue and
 * returns an hour estimate based on diff stats, labels, file count, and
 * complexity signals.
 */
import type {
  EstimateGitHubHoursInput,
  EstimateGitHubHoursOutput,
  HoursBreakdown,
} from "../shared/types.js";
import { classifyGitHubError } from "../shared/github-utils.js";

const TAG = "[estimate-github-hours]";

/* ── GitHub response shapes ─────────────────────────────────────────── */

interface GitHubPR {
  additions: number;
  deletions: number;
  changed_files: number;
  title: string;
  body: string | null;
  labels: Array<{ name: string }>;
}

interface GitHubPRFile {
  filename: string;
  additions: number;
  deletions: number;
  changes: number;
}

interface GitHubIssue {
  title: string;
  body: string | null;
  labels: Array<{ name: string }>;
  pull_request?: unknown; // present if issue is actually a PR
}

/* ── Helpers ────────────────────────────────────────────────────────── */

function roundToQuarter(n: number): number {
  return Math.round(n * 4) / 4;
}

function labelNames(labels: Array<{ name: string }>): string[] {
  return labels.map((l) => l.name.toLowerCase());
}

async function ghFetch<T>(url: string, token: string): Promise<{ ok: true; data: T } | { ok: false; error: string; status: number; code: string }> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (!res.ok) {
    const classified = classifyGitHubError(res, url);
    return { ok: false, error: classified.message, status: classified.status ?? res.status, code: classified.code };
  }

  const data = (await res.json()) as T;
  return { ok: true, data };
}

/* ── PR estimation ──────────────────────────────────────────────────── */

function baseEstimateFromDiff(linesChanged: number): number {
  if (linesChanged <= 50) return 0.5;
  if (linesChanged <= 150) return 1;
  if (linesChanged <= 400) return 2;
  if (linesChanged <= 800) return 4;
  if (linesChanged <= 1500) return 6;
  return 8;
}

function labelMultiplierForPR(labels: string[]): number {
  if (labels.includes("documentation")) return 0.5;
  if (labels.includes("bug")) return 1.0;
  if (labels.includes("feature")) return 1.5;
  if (labels.includes("enhancement")) return 1.2;
  return 1.0;
}

function complexityFactorForPR(
  changedFiles: number,
  files: GitHubPRFile[]
): number {
  let factor = 0;

  // File count bonuses
  if (changedFiles > 10) {
    factor += 1;
  } else if (changedFiles > 5) {
    factor += 0.5;
  }

  // Directory spread
  const dirs = new Set(
    files.map((f) => {
      const parts = f.filename.split("/");
      return parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
    })
  );
  if (dirs.size > 2) {
    factor += 0.5;
  }

  // Test files
  const hasTests = files.some(
    (f) =>
      f.filename.includes("test") ||
      f.filename.includes("spec") ||
      f.filename.includes("__tests__")
  );
  if (hasTests) {
    factor += 0.5;
  }

  return Math.min(factor, 2); // cap at +2h
}

function prConfidence(
  labels: string[],
  linesChanged: number,
  changedFiles: number
): "low" | "medium" | "high" {
  const hasLabels = labels.length > 0;
  const smallDiff = linesChanged < 800;
  const fewFiles = changedFiles < 10;

  if (linesChanged >= 1500) return "low";

  const conditions = [hasLabels, smallDiff, fewFiles];
  const metCount = conditions.filter(Boolean).length;

  if (metCount === 3) return "high";
  if (metCount >= 2) return "medium";
  return "low";
}

async function estimatePR(
  owner: string,
  repo: string,
  number: number,
  token: string
): Promise<EstimateGitHubHoursOutput> {
  // 1. Fetch PR details
  const prResult = await ghFetch<GitHubPR>(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
    token
  );
  if (!prResult.ok) return { success: false, error: prResult.error };

  const pr = prResult.data;

  // 2. Fetch per-file diff stats
  const filesResult = await ghFetch<GitHubPRFile[]>(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/files`,
    token
  );
  if (!filesResult.ok) return { success: false, error: filesResult.error };

  const files = filesResult.data;
  const labels = labelNames(pr.labels);
  const linesChanged = pr.additions + pr.deletions;

  // 3. Calculate
  const baseEstimate = baseEstimateFromDiff(linesChanged);
  const labelMult = labelMultiplierForPR(labels);
  const complexity = complexityFactorForPR(pr.changed_files, files);
  const raw = baseEstimate * labelMult + complexity;
  const estimatedHours = roundToQuarter(raw);
  const confidence = prConfidence(labels, linesChanged, pr.changed_files);

  const reasoning = `PR #${number} has ${linesChanged} lines changed across ${pr.changed_files} files. Base estimate ${baseEstimate}h${labelMult !== 1 ? ` x${labelMult} label multiplier` : ""} + ${complexity}h complexity = ${estimatedHours}h (${confidence} confidence).`;

  console.log(TAG, `PR #${number} ${owner}/${repo}: ${estimatedHours}h (${confidence})`);

  return {
    success: true,
    estimatedHours,
    confidence,
    breakdown: { baseEstimate, labelMultiplier: labelMult, complexityFactor: complexity },
    reasoning,
  };
}

/* ── Issue estimation ───────────────────────────────────────────────── */

function baseEstimateFromIssueLabels(labels: string[]): number {
  if (labels.includes("documentation")) return 0.5;
  if (labels.includes("good first issue")) return 1;
  if (labels.includes("bug")) return 2;
  if (labels.includes("enhancement")) return 3;
  if (labels.includes("feature")) return 5;
  return 2; // no labels → 2h default
}

function bodyLengthMultiplier(body: string | null): number {
  const len = (body ?? "").length;
  if (len < 200) return 0.8;
  if (len <= 1000) return 1.0;
  return 1.3;
}

async function estimateIssue(
  owner: string,
  repo: string,
  number: number,
  token: string
): Promise<EstimateGitHubHoursOutput> {
  const issueResult = await ghFetch<GitHubIssue>(
    `https://api.github.com/repos/${owner}/${repo}/issues/${number}`,
    token
  );
  if (!issueResult.ok) return { success: false, error: issueResult.error };

  const issue = issueResult.data;
  const labels = labelNames(issue.labels);

  const baseEstimate = baseEstimateFromIssueLabels(labels);
  const bodyMult = bodyLengthMultiplier(issue.body);
  const raw = baseEstimate * bodyMult;
  const estimatedHours = roundToQuarter(raw);

  const reasoning = `Issue #${number} base estimate ${baseEstimate}h from labels [${labels.join(", ") || "none"}] x${bodyMult} body length multiplier = ${estimatedHours}h (low confidence — no code to analyze).`;

  console.log(TAG, `Issue #${number} ${owner}/${repo}: ${estimatedHours}h (low)`);

  return {
    success: true,
    estimatedHours,
    confidence: "low", // always low for issues
    breakdown: { baseEstimate, labelMultiplier: bodyMult, complexityFactor: 0 },
    reasoning,
  };
}

/* ── Entry point ────────────────────────────────────────────────────── */

export async function executeEstimateGitHubHours(
  input: EstimateGitHubHoursInput
): Promise<EstimateGitHubHoursOutput> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { success: false, error: "GITHUB_TOKEN is not set" };
  }

  if (!input.owner?.trim()) {
    return { success: false, error: "owner is required" };
  }
  if (!input.repo?.trim()) {
    return { success: false, error: "repo is required" };
  }
  if (!input.number || input.number < 1) {
    return { success: false, error: "number must be a positive integer" };
  }
  if (input.type !== "pr" && input.type !== "issue") {
    return { success: false, error: 'type must be "pr" or "issue"' };
  }

  try {
    if (input.type === "pr") {
      return await estimatePR(input.owner, input.repo, input.number, token);
    }
    return await estimateIssue(input.owner, input.repo, input.number, token);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(TAG, "error:", message);
    return { success: false, error: message };
  }
}
