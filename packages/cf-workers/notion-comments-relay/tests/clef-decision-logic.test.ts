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
  test("q_when=ignore batches, never skips above the locked 0.05 cutoff (live case 0.0641/0.9103/ignore)", () => {
    expect(decideClefOutcome(0.0641, 0.9103, "ignore")).toBe("would_batch");
    expect(decideClefOutcome(0.3, 0.99, "ignore")).toBe("would_batch");
    expect(decideClefOutcome(0.05, 0.8, "ignore")).toBe("would_skip"); // locked skip rule unchanged
    expect(decideClefOutcome(0.0501, 0.99, "ignore")).toBe("would_batch");
    expect(decideClefOutcome(0.31, 0.95, "ignore")).toBe("would_wake");
  });
  test("ignore and batch are identical across the grid; skip never depends on q_when", () => {
    for (let a = 0; a <= 1.0001; a += 0.01) {
      for (let d = 0; d <= 1.0001; d += 0.05) {
        expect(decideClefOutcome(a, d, "ignore")).toBe(decideClefOutcome(a, d, "batch"));
        const skip = a <= 0.05 && d >= 0.8;
        expect(decideClefOutcome(a, d, "now") === "would_skip").toBe(skip);
      }
    }
  });
});
