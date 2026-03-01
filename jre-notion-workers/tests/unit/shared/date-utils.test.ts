import { describe, expect, it } from "bun:test";
import { formatRunTime, hoursAgo, nextBusinessDay, parseRunTimeString } from "../../../src/shared/date-utils.js";

describe("formatRunTime", () => {
  it("formats ISO to America/Chicago style", () => {
    const result = formatRunTime("2026-02-28T15:00:00-06:00");
    expect(result).toContain("2026-02-28");
    expect(result).toContain("America/Chicago");
  });
});

describe("hoursAgo", () => {
  it("returns positive hours for past date", () => {
    const past = new Date();
    past.setHours(past.getHours() - 2);
    const result = hoursAgo(past.toISOString());
    expect(result).toBeGreaterThanOrEqual(1);
  });
});

describe("nextBusinessDay", () => {
  it("returns a date", () => {
    const result = nextBusinessDay();
    expect(result).toBeInstanceOf(Date);
  });
});

describe("parseRunTimeString", () => {
  it("parses YYYY-MM-DD HH:mm style", () => {
    const result = parseRunTimeString("2026-02-28 09:00 (America/Chicago)");
    expect(result).toBeInstanceOf(Date);
    expect(result?.getFullYear()).toBe(2026);
  });
  it("returns null for invalid string", () => {
    expect(parseRunTimeString("garbage")).toBeNull();
  });
});
