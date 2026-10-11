// When the next weekly digest / monthly recap goes out, for the dashboard's Emails card.
// The daily cron (DAILY_RUN_UTC) sends a digest whenever its period's key differs from the last one
// sent (src/jobs/digest.ts), so the next send is the first daily run whose last complete period
// isn't `lastKey`. A digest of a period without plays is skipped by the job; this doesn't know that.

import { lastPeriod, type DigestKind, type Period } from "../jobs/digest";
import { addDays } from "../utils/time";

/** The daily cron that sends digests ("5 8 * * *" in wrangler.toml and src/schedule.ts): 08:05 UTC. */
export const DAILY_RUN_UTC = { hour: 8, minute: 5 } as const;

const DAY_MS = 86_400_000;
const SEARCH_DAYS = 40;

export interface NextDigest {
  /** Epoch ms of the cron run that sends it. */
  at: number;
  period: Period;
}

/** The next daily run after `now` that would send `kind`, or null if none in the next 40 days. */
export function nextDigestRun(kind: DigestKind, now: number, timeZone: string, lastKey: string | null): NextDigest | null {
  const today = new Date(now);
  const firstRun = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), DAILY_RUN_UTC.hour, DAILY_RUN_UTC.minute);
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    const at = firstRun + i * DAY_MS;
    if (at <= now) continue;
    const period = lastPeriod(kind, at, timeZone);
    if (period.key !== lastKey) return { at, period };
  }
  return null;
}

const dayFmt = (timeZone: string) => new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" });

/** "Mon, Oct 13" in `timeZone`. */
export const runDay = (at: number, timeZone: string): string => dayFmt(timeZone).format(at);

/** What a period covers: "Oct 6–12", "Sep 29 – Oct 5" or "September 2026". */
export function periodLabel(p: Period): string {
  const utc = (d: { year: number; month: number; day: number }) => Date.UTC(d.year, d.month - 1, d.day);
  if (p.kind === "month") {
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" }).format(utc(p.start));
  }
  const last = addDays(p.end, -1);
  const md = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
  return p.start.month === last.month ? `${md.format(utc(p.start))}–${last.day}` : `${md.format(utc(p.start))} – ${md.format(utc(last))}`;
}
