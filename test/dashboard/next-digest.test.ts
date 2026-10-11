// nextDigestRun: the first daily 08:05 UTC run that would send a digest, across DST and in zones far
// from UTC; and the labels the Emails card shows.

import { describe, expect, it } from "vitest";
import { DAILY_RUN_UTC, nextDigestRun, periodLabel, runDay } from "../../src/dashboard/next-digest";
import { lastPeriod } from "../../src/jobs/digest";

const LA = "America/Los_Angeles";
const at = (iso: string) => Date.parse(iso);

describe("nextDigestRun", () => {
  it("matches the daily cron's time", () => {
    expect(DAILY_RUN_UTC).toEqual({ hour: 8, minute: 5 });
  });

  it("skips runs whose period already went out", () => {
    // Sat Oct 10: Sunday's run still covers W40 (already sent), Monday's covers W41.
    const next = nextDigestRun("week", at("2026-10-10T12:00:00Z"), LA, "2026-W40")!;
    expect(new Date(next.at).toISOString()).toBe("2026-10-12T08:05:00.000Z");
    expect(next.period.key).toBe("2026-W41");
    expect(periodLabel(next.period)).toBe("Oct 5–11");
  });

  it("is the next run when nothing was sent yet, and not one that already happened today", () => {
    expect(new Date(nextDigestRun("week", at("2026-10-12T07:00:00Z"), LA, null)!.at).toISOString()).toBe("2026-10-12T08:05:00.000Z");
    expect(new Date(nextDigestRun("week", at("2026-10-12T09:00:00Z"), LA, null)!.at).toISOString()).toBe("2026-10-13T08:05:00.000Z");
  });

  it("waits a week once this week's digest is out", () => {
    const next = nextDigestRun("week", at("2026-10-12T09:00:00Z"), LA, "2026-W41")!;
    expect(new Date(next.at).toISOString()).toBe("2026-10-19T08:05:00.000Z");
  });

  it("handles the end of daylight saving time (Nov 1 in Los Angeles)", () => {
    // 08:05 UTC is 01:05 PDT on Nov 1 and 00:05 PST on Nov 2: both after local midnight.
    const week = nextDigestRun("week", at("2026-10-31T20:00:00Z"), LA, "2026-W43")!;
    expect(new Date(week.at).toISOString()).toBe("2026-11-02T08:05:00.000Z");
    expect(week.period.key).toBe("2026-W44");
    expect(periodLabel(week.period)).toBe("Oct 26 – Nov 1");
    const month = nextDigestRun("month", at("2026-10-31T20:00:00Z"), LA, "2026-09")!;
    expect(new Date(month.at).toISOString()).toBe("2026-11-01T08:05:00.000Z");
    expect(month.period.key).toBe("2026-10");
    expect(periodLabel(month.period)).toBe("October 2026");
  });

  it("handles the start of daylight saving time (Mar 8 in Los Angeles)", () => {
    const next = nextDigestRun("week", at("2026-03-07T12:00:00Z"), LA, "2026-W09")!;
    expect(new Date(next.at).toISOString()).toBe("2026-03-09T08:05:00.000Z");
    expect(next.period.key).toBe("2026-W10");
  });

  it("works for a UTC+5:30 zone (08:05 UTC is 13:35 in Kolkata)", () => {
    const next = nextDigestRun("week", at("2026-10-10T12:00:00Z"), "Asia/Kolkata", "2026-W40")!;
    expect(new Date(next.at).toISOString()).toBe("2026-10-12T08:05:00.000Z");
    expect(runDay(next.at, "Asia/Kolkata")).toBe("Mon, Oct 12");
    const month = nextDigestRun("month", at("2026-10-31T23:00:00Z"), "Asia/Kolkata", "2026-09")!;
    // Nov 1 04:30 IST already; the Nov 1 08:05 UTC run is the first in November.
    expect(new Date(month.at).toISOString()).toBe("2026-11-01T08:05:00.000Z");
  });

  it("waits a day where 08:05 UTC is still the previous local day (UTC-11)", () => {
    // Monday 08:05 UTC is Sunday 21:05 in Pago Pago: the week isn't over yet there.
    const next = nextDigestRun("week", at("2026-10-11T12:00:00Z"), "Pacific/Pago_Pago", "2026-W40")!;
    expect(new Date(next.at).toISOString()).toBe("2026-10-13T08:05:00.000Z");
    expect(runDay(next.at, "Pacific/Pago_Pago")).toBe("Mon, Oct 12");
  });

  it("agrees with lastPeriod at the run it picks", () => {
    for (const tz of [LA, "Asia/Kolkata", "UTC", "Pacific/Kiritimati"]) {
      const now = at("2026-12-30T10:00:00Z");
      const prev = lastPeriod("month", now, tz).key;
      const next = nextDigestRun("month", now, tz, prev)!;
      expect(lastPeriod("month", next.at, tz).key).not.toBe(prev);
      expect(lastPeriod("month", next.at - 86_400_000, tz).key).toBe(prev);
    }
  });
});

describe("labels", () => {
  it("formats run days in the zone and periods compactly", () => {
    expect(runDay(at("2026-10-12T08:05:00Z"), LA)).toBe("Mon, Oct 12");
    expect(periodLabel(lastPeriod("week", at("2026-10-05T12:00:00Z"), "UTC"))).toBe("Sep 28 – Oct 4");
    expect(periodLabel(lastPeriod("month", at("2026-01-02T12:00:00Z"), "UTC"))).toBe("December 2025");
  });
});
