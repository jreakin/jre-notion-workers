/**
 * Period rule for PR Estimate Writer Time Log dates.
 * TODO(open-question-c): empty Billing Status in period detection is unresolved.
 */

export const CHICAGO_TZ = "America/Chicago";

export interface TimeLogPeriodRow {
  projectId: string;
  date: string;
  billingStatus: string | null | undefined;
}

export interface PeriodAssignmentInput {
  mergeDate: string;
  projectId: string;
  existingRowsForProject: TimeLogPeriodRow[];
  asOfDate?: string;
}

export interface PeriodAssignmentResult {
  date: string;
  descriptionSuffix: string | null;
  mergeMonthBilled: boolean;
  needsCorrectionRow: boolean;
  correctionHoursDelta: number | null;
}

function parseYmd(ymd: string): { year: number; month: number; day: number } {
  const [y, m, d] = ymd.split("-").map((n) => parseInt(n, 10));
  return { year: y!, month: m!, day: d! };
}

function monthKey(ymd: string): string {
  const { year, month } = parseYmd(ymd);
  return `${year}-${String(month).padStart(2, "0")}`;
}

function firstOfMonth(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

function nextMonth(year: number, month: number): { year: number; month: number } {
  if (month === 12) return { year: year + 1, month: 1 };
  return { year, month: month + 1 };
}

function isMonthBilled(projectId: string, month: string, rows: TimeLogPeriodRow[]): boolean {
  return rows.some((row) => {
    if (row.projectId !== projectId) return false;
    const billing = (row.billingStatus ?? "").trim();
    if (billing !== "Invoiced" && billing !== "Paid") return false;
    return monthKey(row.date) === month;
  });
}

function findNextOpenMonthStart(
  fromYmd: string,
  projectId: string,
  rows: TimeLogPeriodRow[],
  asOfYmd: string
): string {
  let { year, month } = parseYmd(fromYmd);
  const asOfMonth = monthKey(asOfYmd);

  for (let i = 0; i < 24; i++) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    if (!isMonthBilled(projectId, key, rows)) {
      const candidate = firstOfMonth(year, month);
      if (key >= asOfMonth || candidate <= asOfYmd) {
        return candidate;
      }
      return firstOfMonth(parseYmd(asOfYmd).year, parseYmd(asOfYmd).month);
    }
    const nm = nextMonth(year, month);
    year = nm.year;
    month = nm.month;
  }

  return firstOfMonth(parseYmd(asOfYmd).year, parseYmd(asOfYmd).month);
}

export function assignPeriodDate(input: PeriodAssignmentInput): PeriodAssignmentResult {
  const { mergeDate, projectId, existingRowsForProject } = input;
  const asOf = input.asOfDate ?? mergeDate;
  const mergeMonth = monthKey(mergeDate);
  const billed = isMonthBilled(projectId, mergeMonth, existingRowsForProject);

  if (!billed) {
    return {
      date: mergeDate,
      descriptionSuffix: null,
      mergeMonthBilled: false,
      needsCorrectionRow: false,
      correctionHoursDelta: null,
    };
  }

  let nextOpen = findNextOpenMonthStart(mergeDate, projectId, existingRowsForProject, asOf);
  const asOfFirst = firstOfMonth(parseYmd(asOf).year, parseYmd(asOf).month);
  if (nextOpen < asOfFirst) {
    nextOpen = asOfFirst;
  }
  return {
    date: nextOpen,
    descriptionSuffix: `merged ${mergeDate}`,
    mergeMonthBilled: true,
    needsCorrectionRow: false,
    correctionHoursDelta: null,
  };
}

export interface CorrectionRowInput {
  previousHours: number;
  newHours: number;
  mergeDate: string;
  projectId: string;
  existingRowsForProject: TimeLogPeriodRow[];
  asOfDate?: string;
}

export function planCorrectionRow(input: CorrectionRowInput): PeriodAssignmentResult {
  const delta = input.newHours - input.previousHours;
  const period = assignPeriodDate({
    mergeDate: input.mergeDate,
    projectId: input.projectId,
    existingRowsForProject: input.existingRowsForProject,
    asOfDate: input.asOfDate,
  });

  return {
    ...period,
    needsCorrectionRow: delta !== 0,
    correctionHoursDelta: delta !== 0 ? delta : null,
  };
}
