export function isoToMs(iso: string): number {
  return new Date(iso).getTime();
}

export function nowMs(): number {
  return Date.now();
}

export interface LocalDate {
  year: number;
  month: number; // 1-12
  day: number;
}

/** The calendar date of `ms` in `timeZone`. */
export function zonedDate(ms: number, timeZone: string): LocalDate {
  const p = zonedParts(ms, timeZone);
  return { year: p.year, month: p.month, day: p.day };
}

/** UTC ms at which `date` starts in `timeZone` (DST-safe for zones that don't switch at midnight). */
export function zonedMidnight(date: LocalDate, timeZone: string): number {
  const guess = Date.UTC(date.year, date.month - 1, date.day);
  const first = guess - zoneOffset(guess, timeZone);
  return guess - zoneOffset(first, timeZone);
}

/** The date `days` after `date` (calendar arithmetic, no time zone involved). */
export function addDays(date: LocalDate, days: number): LocalDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Whether year/month/day is a real date (Feb 29 only in leap years). */
export function isValidDate(date: LocalDate): boolean {
  return addDays(date, 0).day === date.day;
}

export const formatDate = (d: LocalDate) =>
  `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;

/** ISO 8601 week of `date`, e.g. "2026-W41" (weeks start Monday). */
export function isoWeek(date: LocalDate): string {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7)); // the Thursday of this week decides its year
  const week = Math.ceil(((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function zonedParts(ms: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(ms);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** Offset of `timeZone` from UTC at `ms`, in ms (Los Angeles in summer: -7 h). */
function zoneOffset(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - (ms - (ms % 1000));
}
