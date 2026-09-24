/**
 * PR estimate heuristic — weighted line counts → hours.
 * Spec: Decision 3e57d7f5-6298-815f-b05c-e42d2f15a80d (Abstract Secretary).
 */

export const WEIGHTED_LINES_PER_HOUR = 150;
export const MIN_HOURS = 0.25;
export const MAX_HOURS = 8;

export type FileWeightCategory =
  | "lockfile"
  | "generated"
  | "tests"
  | "docs"
  | "config"
  | "code";

export interface PrFileDiff {
  filename: string;
  additions: number;
  deletions: number;
}

export interface HeuristicBreakdownEntry {
  filename: string;
  category: FileWeightCategory;
  weight: number;
  weightedLines: number;
}

export interface PrEstimateHeuristicResult {
  weightedLines: number;
  rawHours: number;
  hours: number;
  overCap: boolean;
  overCapRawHours: number | null;
  breakdown: HeuristicBreakdownEntry[];
}

const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "Gemfile.lock",
  "composer.lock",
  "go.sum",
  "uv.lock",
]);

const CATEGORY_WEIGHT: Record<FileWeightCategory, number> = {
  lockfile: 0,
  generated: 0,
  tests: 0.5,
  docs: 0.25,
  config: 0.3,
  code: 1.0,
};

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

function isLockfile(filename: string): boolean {
  return LOCKFILE_NAMES.has(basename(filename));
}

function isGeneratedOrVendored(filename: string, linguistGenerated: Set<string>): boolean {
  const lower = filename.toLowerCase();
  if (linguistGenerated.has(filename) || linguistGenerated.has(lower)) return true;
  if (
    lower.includes("/dist/") ||
    lower.includes("/build/") ||
    lower.includes("/.next/") ||
    lower.includes("/node_modules/") ||
    lower.includes("/vendor/") ||
    lower.endsWith(".min.js") ||
    lower.endsWith(".map") ||
    lower.includes("/__snapshots__/") ||
    lower.endsWith(".snap")
  ) {
    return true;
  }
  const base = basename(lower);
  if (base.includes(".generated.") || base.includes(".gen.") || base.endsWith(".d.ts")) {
    return true;
  }
  if (/migrations?\/.+\.(sql|ts|js)$/.test(lower) && /generated|auto/i.test(lower)) {
    return true;
  }
  return false;
}

function isTestFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return (
    lower.includes("/test/") ||
    lower.includes("/tests/") ||
    lower.includes("/__tests__/") ||
    /\.test\.[^/]+$/.test(lower) ||
    /\.spec\.[^/]+$/.test(lower) ||
    /_test\.[^/]+$/.test(lower) ||
    /test_[^/]+\.py$/.test(lower)
  );
}

function isDocsFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".mdx") || lower.endsWith(".txt") || lower.endsWith(".rst")) {
    return true;
  }
  return lower.includes("/docs/");
}

function isConfigFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  const base = basename(lower);
  if (base.startsWith(".") && base !== "." && !base.includes("/")) return true;
  return (
    lower.endsWith(".json") ||
    lower.endsWith(".yaml") ||
    lower.endsWith(".yml") ||
    lower.endsWith(".toml") ||
    lower.endsWith(".ini")
  );
}

export function classifyFile(
  filename: string,
  linguistGenerated: Set<string> = new Set()
): FileWeightCategory {
  if (isLockfile(filename)) return "lockfile";
  if (isGeneratedOrVendored(filename, linguistGenerated)) return "generated";
  if (isTestFile(filename)) return "tests";
  if (isDocsFile(filename)) return "docs";
  if (isConfigFile(filename)) return "config";
  return "code";
}

export function fileWeight(category: FileWeightCategory): number {
  return CATEGORY_WEIGHT[category];
}

export function weightedLinesForFile(
  file: PrFileDiff,
  linguistGenerated: Set<string> = new Set()
): { category: FileWeightCategory; weight: number; weightedLines: number } {
  const category = classifyFile(file.filename, linguistGenerated);
  const weight = fileWeight(category);
  const lineUnits = file.additions + 0.5 * file.deletions;
  return { category, weight, weightedLines: weight * lineUnits };
}

export function roundToQuarter(hours: number): number {
  return Math.round(hours * 4) / 4;
}

export function computePrEstimateHours(
  files: PrFileDiff[],
  linguistGenerated: Set<string> = new Set()
): PrEstimateHeuristicResult {
  const breakdown: HeuristicBreakdownEntry[] = [];
  let weightedLines = 0;

  for (const file of files) {
    const { category, weight, weightedLines: wl } = weightedLinesForFile(file, linguistGenerated);
    weightedLines += wl;
    breakdown.push({ filename: file.filename, category, weight, weightedLines: wl });
  }

  const rawHours = weightedLines / WEIGHTED_LINES_PER_HOUR;

  if (rawHours > MAX_HOURS) {
    return {
      weightedLines,
      rawHours,
      hours: MAX_HOURS,
      overCap: true,
      overCapRawHours: rawHours,
      breakdown,
    };
  }

  const rounded = roundToQuarter(rawHours);
  const hours = Math.max(MIN_HOURS, rounded);

  return {
    weightedLines,
    rawHours,
    hours,
    overCap: false,
    overCapRawHours: null,
    breakdown,
  };
}

export function specWorkedExampleFiles(): PrFileDiff[] {
  return [
    { filename: "src/main.ts", additions: 600, deletions: 200 },
    { filename: "README.md", additions: 300, deletions: 0 },
    { filename: "package-lock.json", additions: 5000, deletions: 0 },
  ];
}

export function formatOverCapDescriptionSuffix(rawHours: number): string {
  const display = roundToQuarter(rawHours);
  return `⚠ OVER CAP (raw ${display} h)`;
}
