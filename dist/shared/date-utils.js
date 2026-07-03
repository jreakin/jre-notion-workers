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
export function formatRunTime(isoDate) {
    try {
        const d = parseISO(isoDate);
        const parts = runTimeFormatter.formatToParts(d);
        const y = parts.find((p) => p.type === "year")?.value ?? "";
        const m = parts.find((p) => p.type === "month")?.value ?? "";
        const day = parts.find((p) => p.type === "day")?.value ?? "";
        const hour = parts.find((p) => p.type === "hour")?.value ?? "";
        const minute = parts.find((p) => p.type === "minute")?.value ?? "";
        return `${y}-${m}-${day} ${hour}:${minute} (America/Chicago)`;
    }
    catch {
        return isoDate;
    }
}
const CHICAGO_OFFSET_FORMATTER = new Intl.DateTimeFormat("en-US", {
    timeZone: CHICAGO,
    timeZoneName: "shortOffset",
});
/**
 * Chicago UTC offset string ("-05:00" CDT or "-06:00" CST) for the given UTC
 * instant. Resolves DST by asking the platform's tz database.
 */
function chicagoOffsetForInstant(d) {
    const parts = CHICAGO_OFFSET_FORMATTER.formatToParts(d);
    const tz = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
    const m = tz.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (!m || !m[1] || !m[2])
        return "-06:00";
    const sign = m[1];
    const hh = m[2].padStart(2, "0");
    const mm = m[3] ?? "00";
    return `${sign}${hh}:${mm}`;
}
/**
 * Coerce a "run time" string into ISO-8601 acceptable to Notion's date property.
 * Accepts:
 *   - "2026-04-27T20:31:00-05:00" (already valid → returned as-is)
 *   - "2026-04-28T01:31:00Z"      (already valid → returned as-is)
 *   - "2026-04-27T20:31:00"        (naive → appended with Chicago offset)
 *   - "2026-04-27 20:31"           (Chicago wall-clock → ISO + Chicago offset)
 *   - "2026-04-27 20:31 (America/Chicago)" (legacy display → ISO + Chicago offset)
 * Returns null if the input doesn't match any supported shape.
 */
export function toIsoDateTime(input) {
    if (!input)
        return null;
    const trimmed = input.trim();
    // Pass-through when already a complete ISO-8601 datetime with offset or Z.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed)) {
        return trimmed;
    }
    // Naive ISO ("YYYY-MM-DDTHH:mm[:ss]"): treat as Chicago local.
    let m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) {
        // Display form: "YYYY-MM-DD HH:mm[:ss]" with optional "(America/Chicago)" tail.
        m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*\([^)]*\))?$/);
    }
    if (!m)
        return null;
    const y = m[1];
    const mo = m[2];
    const d = m[3];
    const h = m[4].padStart(2, "0");
    const mi = m[5];
    const s = (m[6] ?? "00").padStart(2, "0");
    const naive = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
    // Probe against the same wall-clock pretending UTC; offset for that instant
    // in Chicago is the offset we want to attach. (Twice-a-year DST ambiguity is
    // out of scope — agents always pass the current instant.)
    const probe = new Date(`${naive}Z`);
    if (Number.isNaN(probe.getTime()))
        return null;
    const offset = chicagoOffsetForInstant(probe);
    return `${naive}${offset}`;
}
/**
 * Hours elapsed since the given ISO datetime.
 */
export function hoursAgo(isoDate) {
    try {
        const d = parseISO(isoDate);
        return differenceInHours(new Date(), d);
    }
    catch {
        return Number.POSITIVE_INFINITY;
    }
}
/**
 * Next business day (Mon–Fri), skipping weekends. If from is omitted, use today.
 */
export function nextBusinessDay(from) {
    const base = from ?? new Date();
    let d = addDays(base, 1);
    const day = d.getDay();
    if (day === 0)
        d = addDays(d, 1);
    if (day === 6)
        d = addDays(d, 2);
    return d;
}
/**
 * Parse "YYYY-MM-DD HH:mm (America/Chicago)" or similar back to Date for age calculation.
 */
export function parseRunTimeString(runTimeStr) {
    try {
        const match = runTimeStr.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})/);
        if (!match)
            return null;
        const y = match[1];
        const m = match[2];
        const d = match[3];
        const h = match[4];
        const min = match[5];
        if (!y || !m || !d || h === undefined || !min)
            return null;
        const iso = `${y}-${m}-${d}T${h.padStart(2, "0")}:${min}:00-06:00`;
        return parseISO(iso);
    }
    catch {
        return null;
    }
}
