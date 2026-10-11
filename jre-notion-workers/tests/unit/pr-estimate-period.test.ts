import { describe, test, expect } from "bun:test";
import { assignPeriodDate, planCorrectionRow } from "../../src/shared/pr-estimate-period.js";

describe("pr-estimate-period", () => {
  test("merge in open month keeps merge date", () => {
    const r = assignPeriodDate({
      mergeDate: "2026-03-15",
      projectId: "proj-1",
      existingRowsForProject: [],
    });
    expect(r.date).toBe("2026-03-15");
    expect(r.mergeMonthBilled).toBe(false);
    expect(r.descriptionSuffix).toBeNull();
  });

  test("empty billing status is unknown — does not mark merge month billed", () => {
    const r = assignPeriodDate({
      mergeDate: "2026-02-20",
      projectId: "proj-1",
      existingRowsForProject: [
        { projectId: "proj-1", date: "2026-02-10", billingStatus: "" },
      ],
      asOfDate: "2026-04-05",
    });
    expect(r.mergeMonthBilled).toBe(false);
    expect(r.date).toBe("2026-02-20");
  });

  test("late PR lands in next open period when merge month billed", () => {
    const r = assignPeriodDate({
      mergeDate: "2026-02-20",
      projectId: "proj-1",
      existingRowsForProject: [
        { projectId: "proj-1", date: "2026-02-10", billingStatus: "Invoiced" },
      ],
      asOfDate: "2026-04-05",
    });
    expect(r.mergeMonthBilled).toBe(true);
    expect(r.date).toBe("2026-04-01");
    expect(r.descriptionSuffix).toBe("merged 2026-02-20");
  });

  test("correction row stub sets delta", () => {
    const r = planCorrectionRow({
      previousHours: 4,
      newHours: 5,
      mergeDate: "2026-02-20",
      projectId: "proj-1",
      existingRowsForProject: [],
    });
    expect(r.needsCorrectionRow).toBe(true);
    expect(r.correctionHoursDelta).toBe(1);
  });
});
