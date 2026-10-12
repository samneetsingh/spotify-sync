// Formatting for the dashboard's Home components: local dates ("YYYY-MM-DD", already in the owner's
// time zone, so they're formatted as UTC calendar dates), months, hours and short numbers. Text
// only; JSX escapes it.

import { fmt } from "../../email/layout";

const utc = (date: string): number => {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y!, (m ?? 1) - 1, d ?? 1);
};
const format = (opts: Intl.DateTimeFormatOptions) => {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts });
  return (date: string) => f.format(utc(date));
};

/** "Mon" for "2026-10-06". */
export const weekdayShort = format({ weekday: "short" });
/** "Mon, Oct 6". */
export const dayName = format({ weekday: "short", month: "short", day: "numeric" });
/** "Oct 6". */
export const dayShort = format({ month: "short", day: "numeric" });
/** "Sat, Mar 14, 2026". */
export const dayLong = format({ weekday: "short", month: "short", day: "numeric", year: "numeric" });
/** "Oct" for "2026-10" or "2026-10-06". */
export const monthShort = (month: string) => format({ month: "short" })(month.slice(0, 7));
/** "October 2026". */
export const monthLong = (month: string) => format({ month: "long", year: "numeric" })(month.slice(0, 7));
/** "October". */
export const monthName = (month: string) => format({ month: "long" })(month.slice(0, 7));

/** "1 play" / "1,204 plays". */
export const playsText = (n: number) => `${fmt(n)} play${n === 1 ? "" : "s"}`;

/** Listening time in hours: "0", "4.2", "38", "1,204". */
export function hours(ms: number): string {
  const h = ms / 3_600_000;
  if (h === 0) return "0";
  if (h < 10) return (Math.round(h * 10) / 10).toString();
  return fmt(Math.round(h));
}

/** An axis number: "950", "1,200", "12k". */
export const axisNumber = (n: number) => (n >= 10_000 ? `${fmt(Math.round(n / 1000))}k` : fmt(n));

/** "12 AM", "1 AM" ... "11 PM". */
export const hourName = (h: number) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`;

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
export const WEEKDAYS_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
