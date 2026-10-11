import { describe, test, expect } from "bun:test";
import {
  computePrEstimateHours,
  classifyFile,
  specWorkedExampleFiles,
  MAX_HOURS,
  MIN_HOURS,
} from "../../src/shared/pr-estimate-heuristic.js";

describe("pr-estimate-heuristic", () => {
  test("spec worked example yields 5.25h", () => {
    const result = computePrEstimateHours(specWorkedExampleFiles());
    expect(result.weightedLines).toBe(775);
    expect(result.rawHours).toBeCloseTo(5.166666, 4);
    expect(result.hours).toBe(5.25);
    expect(result.overCap).toBe(false);
  });

  test("lockfiles weight 0", () => {
    expect(classifyFile("package-lock.json")).toBe("lockfile");
    const r = computePrEstimateHours([
      { filename: "package-lock.json", additions: 10000, deletions: 0 },
    ]);
    expect(r.hours).toBe(MIN_HOURS);
    expect(r.weightedLines).toBe(0);
  });

  test("docs weight 0.25", () => {
    expect(classifyFile("README.md")).toBe("docs");
  });

  test("tests weight 0.5", () => {
    expect(classifyFile("src/foo.test.ts")).toBe("tests");
  });

  test("config weight 0.3", () => {
    expect(classifyFile(".eslintrc.json")).toBe("config");
  });

  test("minimum 0.25h", () => {
    const r = computePrEstimateHours([
      { filename: "tiny.ts", additions: 1, deletions: 0 },
    ]);
    expect(r.hours).toBe(MIN_HOURS);
  });

  test("over cap flags at 8h placeholder", () => {
    const r = computePrEstimateHours([
      { filename: "big.ts", additions: 2000, deletions: 0 },
    ]);
    expect(r.overCap).toBe(true);
    expect(r.hours).toBe(MAX_HOURS);
    expect(r.overCapRawHours).toBeGreaterThan(8);
  });
});
