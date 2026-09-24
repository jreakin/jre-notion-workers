import { describe, test, expect } from "bun:test";
import {
  assertWriterMayMutateTimeLogRow,
  assertWriterMayUpdatePrEstimateRow,
  PR_ESTIMATE_SOURCE,
  isBillingStatusUnknown,
} from "../../src/shared/pr-estimate-ownership.js";

describe("pr-estimate-ownership", () => {
  test("allows PR estimate source", () => {
    expect(
      assertWriterMayMutateTimeLogRow({
        source: PR_ESTIMATE_SOURCE,
        billingStatus: "Unbilled",
      })
    ).toEqual({ allowed: true });
  });

  test("rejects empty source", () => {
    const r = assertWriterMayMutateTimeLogRow({ source: "", billingStatus: "" });
    expect(r.allowed).toBe(false);
  });

  test("rejects Manual source", () => {
    const r = assertWriterMayMutateTimeLogRow({ source: "Manual", billingStatus: "Unbilled" });
    expect(r.allowed).toBe(false);
  });

  test("rejects Auditor EST superseded", () => {
    const r = assertWriterMayMutateTimeLogRow({
      source: "Auditor EST (superseded)",
      billingStatus: "",
    });
    expect(r.allowed).toBe(false);
  });

  test("rejects Invoiced and Paid", () => {
    for (const billing of ["Invoiced", "Paid"]) {
      const r = assertWriterMayMutateTimeLogRow({
        source: PR_ESTIMATE_SOURCE,
        billingStatus: billing,
      });
      expect(r.allowed).toBe(false);
    }
  });

  test("empty billing status is unknown — not treated as Unbilled for updates", () => {
    expect(isBillingStatusUnknown("")).toBe(true);
    const r = assertWriterMayUpdatePrEstimateRow({
      source: PR_ESTIMATE_SOURCE,
      billingStatus: "",
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.reason).toContain("unknown");
    }
  });

  test("updates only Unbilled PR estimate rows", () => {
    expect(
      assertWriterMayUpdatePrEstimateRow({
        source: PR_ESTIMATE_SOURCE,
        billingStatus: "Unbilled",
      }).allowed
    ).toBe(true);
  });
});
