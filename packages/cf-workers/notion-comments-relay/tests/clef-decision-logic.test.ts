import { describe, expect, test } from "bun:test";
import { decideClefOutcome } from "../src/wake-gate/clef-decision-logic.js";

describe("clef decision boundaries", () => {
  test("skip when low action and high dup", () => {
    expect(decideClefOutcome(0.04, 0.85, "now")).toBe("would_skip");
  });
  test("batch when moderate action and batch when", () => {
    expect(decideClefOutcome(0.2, 0.1, "batch")).toBe("would_batch");
  });
  test("wake otherwise", () => {
    expect(decideClefOutcome(0.9, 0.1, "now")).toBe("would_wake");
  });
  test("q_when=ignore is never louder than batch (live case 0.0641/0.9103/ignore)", () => {
    expect(decideClefOutcome(0.0641, 0.9103, "ignore")).toBe("would_skip");
    expect(decideClefOutcome(0.2, 0.1, "ignore")).toBe("would_batch");
    expect(decideClefOutcome(0.3, 0.0, "ignore")).toBe("would_batch");
  });
  test("q_when=ignore with high action still wakes", () => {
    expect(decideClefOutcome(0.31, 0.95, "ignore")).toBe("would_wake");
    expect(decideClefOutcome(0.9, 0.0, "ignore")).toBe("would_wake");
  });
  test("monotone: ignore ≤ batch ≤ now for every grid point", () => {
    const rank = { would_skip: 0, would_batch: 1, would_log_only: 1, would_wake: 2 } as Record<string, number>;
    for (let a = 0; a <= 1.0001; a += 0.05) {
      for (let d = 0; d <= 1.0001; d += 0.05) {
        const i = rank[decideClefOutcome(a, d, "ignore")]!;
        const b = rank[decideClefOutcome(a, d, "batch")]!;
        const n = rank[decideClefOutcome(a, d, "now")]!;
        expect(i).toBeLessThanOrEqual(b);
        expect(b).toBeLessThanOrEqual(n);
      }
    }
  });
});
