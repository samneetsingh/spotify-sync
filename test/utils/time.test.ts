import { describe, expect, it } from "vitest";
import { addDays, isoWeek, isValidDate, zonedDate, zonedMidnight } from "../../src/utils/time";

const LA = "America/Los_Angeles";

describe("zonedMidnight", () => {
  it("is plain UTC midnight in UTC", () => {
    expect(zonedMidnight({ year: 2026, month: 10, day: 11 }, "UTC")).toBe(Date.UTC(2026, 9, 11));
  });

  it("follows the zone's offset in summer and winter", () => {
    expect(zonedMidnight({ year: 2026, month: 10, day: 11 }, LA)).toBe(Date.UTC(2026, 9, 11, 7)); // PDT
    expect(zonedMidnight({ year: 2026, month: 1, day: 15 }, LA)).toBe(Date.UTC(2026, 0, 15, 8)); // PST
  });

  it("handles the DST switch days (23 h and 25 h long)", () => {
    const start = { year: 2026, month: 3, day: 8 };
    expect(zonedMidnight(start, LA)).toBe(Date.UTC(2026, 2, 8, 8));
    expect(zonedMidnight(addDays(start, 1), LA) - zonedMidnight(start, LA)).toBe(23 * 3_600_000);
    const end = { year: 2026, month: 11, day: 1 };
    expect(zonedMidnight(end, LA)).toBe(Date.UTC(2026, 10, 1, 7));
    expect(zonedMidnight(addDays(end, 1), LA) - zonedMidnight(end, LA)).toBe(25 * 3_600_000);
  });
});

describe("dates", () => {
  it("zonedDate gives the local calendar date", () => {
    expect(zonedDate(Date.UTC(2026, 9, 11, 5, 30), LA)).toEqual({ year: 2026, month: 10, day: 10 });
    expect(zonedDate(Date.UTC(2026, 9, 11, 5, 30), "UTC")).toEqual({ year: 2026, month: 10, day: 11 });
  });

  it("isValidDate knows leap days", () => {
    expect(isValidDate({ year: 2024, month: 2, day: 29 })).toBe(true);
    expect(isValidDate({ year: 2025, month: 2, day: 29 })).toBe(false);
  });

  it("isoWeek uses Monday-start weeks and the ISO week-year", () => {
    expect(isoWeek({ year: 2026, month: 10, day: 11 })).toBe("2026-W41"); // Sunday
    expect(isoWeek({ year: 2026, month: 10, day: 12 })).toBe("2026-W42"); // Monday
    expect(isoWeek({ year: 2021, month: 1, day: 3 })).toBe("2020-W53");
    expect(isoWeek({ year: 2024, month: 12, day: 30 })).toBe("2025-W01");
  });
});
