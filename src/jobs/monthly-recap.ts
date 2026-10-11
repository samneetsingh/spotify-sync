// Monthly recap email (Worker-only): last month's listening, sent through the alert
// email binding. Runs with the daily jobs and sends whenever last month's recap hasn't
// gone out yet (state `recap:last_month`), so a failed send is retried the next day.
// Only live mode sends; other modes log the text. Sections without data are left out.

import { sendEmail, type AlertConfig, type Email } from "../alerts";
import type { Config } from "../config";
import {
  recapBusiestRange,
  recapNewArtists,
  recapNewTrackCount,
  recapReturningArtists,
  recapTopArtists,
  recapTopTracks,
  recapTotals,
  type RecapArtist,
  type RecapTotals,
  type RecapTrack,
} from "../db/queries";
import { getState, setState } from "../db/state";
import { addDays, addMonths, formatDate, zonedDate, zonedMidnight, type LocalDate } from "../utils/time";

const STATE_KEY = "recap:last_month";
const YEAR_MS = 365 * 86_400_000;
const THROWBACK_YEARS = [1, 5];

export interface RecapData {
  /** First day of the recapped month. */
  month: LocalDate;
  timeZone: string;
  totals: RecapTotals;
  topTracks: RecapTrack[];
  topArtists: RecapArtist[];
  newTrackCount: number;
  newArtists: RecapArtist[];
  returning: Array<RecapArtist & { last_before_ms: number }>;
  busiestDay: { day: string; plays: number } | null;
  throwbacks: Array<{ year: number; track: RecapTrack }>;
}

export interface MonthlyRecapResult {
  month: string;
  sent: boolean;
}

export async function runMonthlyRecap(
  cfg: Config,
  db: D1Database,
  alerts: AlertConfig,
  now = Date.now(),
): Promise<MonthlyRecapResult | null> {
  const month = addMonths(zonedDate(now, cfg.timeZone), -1);
  const key = `${month.year}-${String(month.month).padStart(2, "0")}`;
  if ((await getState(db, STATE_KEY)) === key) return null;

  const data = await loadRecap(db, month, cfg.timeZone);
  if (!data.totals.plays) {
    console.log(JSON.stringify({ job: "monthly-recap", month: key, skipped: "no plays" }));
    return null;
  }
  const email = renderRecap(data);
  if (cfg.writeMode !== "live") {
    console.log(JSON.stringify({ job: "monthly-recap", writeMode: cfg.writeMode, month: key, would_send: email.subject }));
    console.log(email.text);
    console.log(email.html); // for previewing the email from a dry run
    return { month: key, sent: false };
  }
  const sent = await sendEmail(alerts, email);
  if (sent) await setState(db, STATE_KEY, key);
  console.log(JSON.stringify({ job: "monthly-recap", month: key, sent }));
  // Email is set up but this send failed: fail the job so withJob alerts (a plain-text
  // alert can get through where the HTML recap didn't). It is retried tomorrow.
  if (!sent && alerts.binding && alerts.from && alerts.to) throw new Error(`The ${key} recap email could not be sent; retrying tomorrow`);
  return { month: key, sent };
}

export async function loadRecap(db: D1Database, month: LocalDate, timeZone: string): Promise<RecapData> {
  const range = (m: LocalDate) => [zonedMidnight(m, timeZone), zonedMidnight(addMonths(m, 1), timeZone)] as const;
  const [from, to] = range(month);
  const days: LocalDate[] = [];
  for (let d = month; d.month === month.month; d = addDays(d, 1)) days.push(d);
  const [totals, topTracks, topArtists, newTrackCount, newArtists, returning, busiest, ...pastTops] = await Promise.all([
    recapTotals(db, from, to),
    recapTopTracks(db, from, to, 5),
    recapTopArtists(db, from, to, 5),
    recapNewTrackCount(db, from, to),
    recapNewArtists(db, from, to, 3),
    recapReturningArtists(db, from, to, { idleMs: YEAR_MS, minEarlierPlays: 10, minPlays: 3, limit: 3 }),
    recapBusiestRange(db, days.map((d) => [zonedMidnight(d, timeZone), zonedMidnight(addDays(d, 1), timeZone)])),
    ...THROWBACK_YEARS.map((years) => recapTopTracks(db, ...range({ ...month, year: month.year - years }), 1)),
  ]);
  const throwbacks = THROWBACK_YEARS.flatMap((years, i) => {
    const track = (pastTops[i] as RecapTrack[])[0];
    return track ? [{ year: month.year - years, track }] : [];
  });
  const busiestDay = busiest ? { day: formatDate(days[busiest.range_index]!), plays: busiest.plays } : null;
  return { month, timeZone, totals, topTracks, topArtists, newTrackCount, newArtists, returning, busiestDay, throwbacks };
}

interface Line {
  text: string;
  html: string;
}

interface Section {
  title: string;
  ordered: boolean;
  lines: Line[];
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const fmt = (n: number) => n.toLocaleString("en-US");
const plays = (n: number) => `${fmt(n)} play${n === 1 ? "" : "s"}`;
const link = (url: string, label: string) => `<a href="${url}" style="color:#1a7f45;text-decoration:none">${esc(label)}</a>`;
const note = (s: string) => ` <span style="color:#888">(${esc(s)})</span>`;
const plain = (s: string): Line => ({ text: s, html: esc(s) });

function trackLine(t: RecapTrack, detail: string): Line {
  const name = t.name ?? "Unknown track";
  const by = t.artists ? ` — ${t.artists}` : "";
  return {
    text: `${name}${by} (${detail})`,
    html: `${link(`https://open.spotify.com/track/${t.track_id}`, name)}${by ? `<span style="color:#555">${esc(by)}</span>` : ""}${note(detail)}`,
  };
}

function artistLine(a: RecapArtist, detail: string): Line {
  return { text: `${a.name} (${detail})`, html: `${link(`https://open.spotify.com/artist/${a.artist_id}`, a.name)}${note(detail)}` };
}

/** The recap as an email: subject, plain text and HTML built from the same sections. */
export function renderRecap(d: RecapData): Email {
  const monthName = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(Date.UTC(d.month.year, d.month.month - 1, 1));
  const sinceFormat = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: d.timeZone });
  const dayFormat = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
  const title = `Your ${monthName} ${d.month.year} in music`;
  const t = d.totals;
  const headline = `${plays(t.plays)} · about ${fmt(Math.round(t.ms / 3_600_000))} hours · ${fmt(t.tracks)} tracks · ${fmt(t.artists)} artists`;

  const sections: Section[] = [
    { title: "Top tracks", ordered: true, lines: d.topTracks.map((tr) => trackLine(tr, plays(tr.plays))) },
    { title: "Top artists", ordered: true, lines: d.topArtists.map((a) => artistLine(a, plays(a.plays))) },
    {
      title: "New to you",
      ordered: false,
      lines: [
        ...(d.newTrackCount ? [plain(`${fmt(d.newTrackCount)} track${d.newTrackCount === 1 ? "" : "s"} you'd never played before`)] : []),
        ...d.newArtists.map((a) => artistLine(a, `first listen · ${plays(a.plays)}`)),
      ],
    },
    {
      title: "Welcome back",
      ordered: false,
      lines: d.returning.map((a) => artistLine(a, `${plays(a.plays)}, first since ${sinceFormat.format(a.last_before_ms)}`)),
    },
    {
      title: "Busiest day",
      ordered: false,
      lines: d.busiestDay ? [plain(`${dayFormat.format(Date.parse(`${d.busiestDay.day}T00:00:00Z`))}: ${plays(d.busiestDay.plays)}`)] : [],
    },
    {
      title: "Throwback",
      ordered: false,
      lines: d.throwbacks.map((tb) => trackLine(tb.track, `your top track in ${monthName} ${tb.year}`)),
    },
  ].filter((s) => s.lines.length);

  const footer = "On This Day, Forgotten Favorites and Holiday Favorites keep updating in your library. Sent by spotify-sync.";
  const text = [
    title,
    headline,
    ...sections.flatMap((s) => ["", s.title, ...s.lines.map((l, i) => `  ${s.ordered ? `${i + 1}.` : "-"} ${l.text}`)]),
    "",
    footer,
  ].join("\n");

  const h2 = 'style="font-size:16px;margin:24px 0 6px"';
  const list = 'style="margin:0;padding-left:22px;line-height:1.6"';
  const html = [
    '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#191414">',
    `<h1 style="font-size:22px;margin:0 0 4px">${esc(title)}</h1>`,
    `<p style="color:#555;margin:0">${esc(headline)}</p>`,
    ...sections.map((s) => {
      const tag = s.ordered ? "ol" : "ul";
      return `<h2 ${h2}>${esc(s.title)}</h2><${tag} ${list}>${s.lines.map((l) => `<li>${l.html}</li>`).join("")}</${tag}>`;
    }),
    `<p style="color:#999;font-size:12px;margin-top:28px">${esc(footer)}</p>`,
    "</div>",
  ].join("\n");

  return { subject: `${title}: ${plays(t.plays)}`, text, html };
}
