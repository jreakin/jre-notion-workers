/**
 * Run time formatting (America/Chicago), hours-ago, and next business day.
 */
import { addDays, differenceInHours, parseISO } from "date-fns";

const CHICAGO = "America/Chicago";

const runTimeFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: CHICAGO,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/**
 * Format ISO datetime to "YYYY-MM-DD HH:mm (America/Chicago)".
 */
export function formatRunTime(isoDate: string): string {
  try {
    const d = parseISO(isoDate);
    const parts = runTimeFormatter.formatToParts(d);
    const y = parts.find((p) => p.type === "year")?.value ?? "";
    const m = parts.find((p) => p.type === "month")?.value ?? "";
    const day = parts.find((p) => p.type === "day")?.value ?? "";
    const hour = parts.find((p) => p.type === "hour")?.value ?? "";
    const minute = parts.find((p) => p.type === "minute")?.value ?? "";
    return `${y}-${m}-${day} ${hour}:${minute} (America/Chicago)`;
  } catch {
    return isoDate;
  }
}

/**
 * Hours elapsed since the given ISO datetime.
 */
export function hoursAgo(isoDate: string): number {
  try {
    const d = parseISO(isoDate);
    return differenceInHours(new Date(), d);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Next business day (Mon–Fri), skipping weekends. If from is omitted, use today.
 */
export function nextBusinessDay(from?: Date): Date {
  const base = from ?? new Date();
  let d = addDays(base, 1);
  const day = d.getDay();
  if (day === 0) d = addDays(d, 1);
  if (day === 6) d = addDays(d, 2);
  return d;
}

/**
 * Parse "YYYY-MM-DD HH:mm (America/Chicago)" or similar back to Date for age calculation.
 */
export function parseRunTimeString(runTimeStr: string): Date | null {
  try {
    const match = runTimeStr.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})/);
    if (!match) return null;
    const y = match[1];
    const m = match[2];
    const d = match[3];
    const h = match[4];
    const min = match[5];
    if (!y || !m || !d || h === undefined || !min) return null;
    const iso = `${y}-${m}-${d}T${h.padStart(2, "0")}:${min}:00-06:00`;
    return parseISO(iso);
  } catch {
    return null;
  }
}
