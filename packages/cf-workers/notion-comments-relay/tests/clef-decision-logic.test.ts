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
});
