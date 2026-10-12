// The new Home ("After hours" design): the page body under the shell's (visually
// hidden) "Home" heading. Pure rendering from HomeData (./home-data.ts), so it is easy to test and to
// screenshot. Every widget is a <section> with an <h2>; each has its own empty state, and a quiet
// period shows zeros rather than a blank chart. Times are in data.timeZone; dates in HomeData are
// already local ("YYYY-MM-DD").

import { artistUrl, fmt, trackUrl } from "../email/layout";
import type { WriteMode } from "../env";
import type { SettingValues } from "../settings";
import { formatDate, zonedDate } from "../utils/time";
import { BarList, ColumnChart, Heatmap, RangeSwitch, SplitBar, StreakDots, type Column } from "./components/charts";
import { dayLong, dayName, dayShort, hourName, hours, monthLong, monthName, monthShort, playsText, weekdayShort, WEEKDAYS } from "./components/format";
import { ArtistAvatar, Cover, TrackRow, Vinyl } from "./components/music";
import { LinkButton, Pill } from "./components/primitives";
import { SettingsWidget } from "./components/settings-widget";
import { delta, StatTile } from "./components/stats";
import { Banner, EmptyState, StatusChip } from "./components/status";
import { STREAK_DAYS, type DayBar, type HomeData, type MonthBar, type PeriodSoFar } from "./home-data";
import { ago } from "./layout";
import { runDay } from "./next-digest";

/** The cached image for a Spotify id; own keys only, so an id like "constructor" can't pick up Object's members. */
const artOf = (data: HomeData, id: string): string | undefined => (Object.hasOwn(data.art, id) && data.art[id]) || undefined;

export interface HomeViewProps {
  data: HomeData;
  settings: SettingValues;
  /** OPENAI_API_KEY is set: the AI editor switch shows. */
  aiAvailable: boolean;
  writeMode: WriteMode;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** The busiest entry (the earliest on a tie), or null when every count is 0. */
function busiest<T>(items: T[], plays: (t: T) => number): T | null {
  let best: T | null = null;
  for (const t of items) if (plays(t) > (best ? plays(best) : 0)) best = t;
  return best;
}

// ---------------------------------------------------------------------------- hero

function Hero({ data, empty }: { data: HomeData; empty: boolean }) {
  const song = data.songOfWeek;
  const notConnected = !data.status.connected;
  const title = (
    <h2 id="hero-title" class="hero-label">
      {!song && notConnected ? "Spotify" : "Song of the week"}
    </h2>
  );
  if (!song) {
    const lead = notConnected
      ? "Connect your Spotify account and your listening starts showing up here."
      : empty
        ? data.status.lastRun
          ? "Play something on Spotify: new plays show up here within 10 minutes."
          : "Your first sync runs within 10 minutes."
        : "Nothing played this week or last. Play something and it shows up here within 10 minutes.";
    return (
      <section class="card hero is-empty" aria-labelledby="hero-title">
        <Vinyl />
        <div class="hero-text">
          {title}
          <p class="hero-track">{notConnected ? "Not connected yet" : "No plays yet"}</p>
          <p class="hero-artist">{lead}</p>
          {notConnected ? (
            <div class="hero-actions">
              <LinkButton href="/login" label="Connect Spotify" variant="primary" />
            </div>
          ) : null}
        </div>
      </section>
    );
  }
  const t = song.track;
  return (
    <section class="card hero" aria-labelledby="hero-title">
      <Vinyl cover={artOf(data, t.id)} />
      <div class="hero-text">
        <div class="hero-head">
          {title}
          {song.lastWeek ? <span class="hero-when">From last week</span> : null}
        </div>
        <p class="hero-track">
          <a href={trackUrl(t.id)}>{t.name}</a>
        </p>
        {t.artists ? <p class="hero-artist">{t.artists}</p> : null}
        <p class="hero-plays">
          <span class="plays-badge num">{playsText(t.plays)}</span>
          <span class="muted">{song.lastWeek ? "last week" : "this week so far"}</span>
        </p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------- so far

function SoFar({ id, title, period, vs }: { id: string; title: string; period: PeriodSoFar; vs: string }) {
  const c = period.current;
  const p = period.previous;
  return (
    <section class={`card sofar home-${id}`} aria-labelledby={`${id}-title`}>
      <div class="card-head">
        <h2 id={`${id}-title`}>{title}</h2>
      </div>
      <dl class="tiles">
        <StatTile label="Plays" value={fmt(c.plays)} delta={delta(c.plays, p.plays)} />
        <StatTile label="Hours" value={hours(c.ms)} delta={delta(Math.round(c.ms / 360_000), Math.round(p.ms / 360_000))} />
        <StatTile label="New tracks" value={fmt(c.newTracks)} delta={delta(c.newTracks, p.newTracks)} />
        <StatTile label="New artists" value={fmt(c.newArtists)} delta={delta(c.newArtists, p.newArtists)} />
      </dl>
      <p class="note">Changes compare with the same point {vs}.</p>
    </section>
  );
}

// ---------------------------------------------------------------------------- listening by day

function dayColumns(bars: DayBar[], today: string, month: boolean): Column[] {
  return bars.map((b) => {
    const day = Number(b.date.slice(8));
    return {
      label: month ? String(day) : weekdayShort(b.date),
      name: dayName(b.date),
      value: b.plays,
      highlight: b.date === today,
      future: b.future,
      tick: month ? (day - 1) % 7 === 0 : true,
      note: b.date === today ? "so far" : undefined,
    };
  });
}

function monthColumns(bars: MonthBar[]): Column[] {
  return bars.map((m, i) => ({
    label: monthShort(m.month),
    name: monthLong(m.month),
    value: m.plays,
    highlight: m.current,
    tickWide: (bars.length - 1 - i) % 2 === 1,
    note: m.current ? "so far" : undefined,
  }));
}

function daysSummary(prefix: string, bars: DayBar[]): string {
  const total = sum(bars.map((b) => b.plays));
  const best = busiest(bars, (b) => b.plays);
  if (!best) return `${prefix}: no plays yet.`;
  return `${prefix}: ${playsText(total)} so far, most on ${dayName(best.date)} (${fmt(best.plays)}).`;
}

function ListeningByDay({ data, today }: { data: HomeData; today: string }) {
  const year = data.days.year;
  const best = busiest(year, (m) => m.plays);
  const yearSummary = best
    ? `The last 12 months: ${playsText(sum(year.map((m) => m.plays)))}, most in ${monthLong(best.month)} (${fmt(best.plays)}).`
    : "The last 12 months: no plays yet.";
  return (
    <section class="card home-days" aria-labelledby="days-title">
      <RangeSwitch
        name="days"
        legend="Show listening by"
        head={<h2 id="days-title">Listening by day</h2>}
        options={[
          { id: "week", label: "Week", content: <ColumnChart columns={dayColumns(data.days.week, today, false)} summary={daysSummary("This week", data.days.week)} labelHeader="Day" /> },
          {
            id: "month",
            label: "Month",
            content: <ColumnChart columns={dayColumns(data.days.month, today, true)} summary={daysSummary(`${monthName(today)}`, data.days.month)} labelHeader="Day" />,
          },
          { id: "year", label: "Year", content: <ColumnChart columns={monthColumns(year)} summary={yearSummary} labelHeader="Month" /> },
        ]}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------- streak

function Streak({ data, today }: { data: HomeData; today: string }) {
  const todayBar = data.days.week.find((b) => b.date === today);
  const n = data.streak;
  const sentence =
    n === 0 ? "Play something today to start one." : todayBar && todayBar.plays > 0 ? "In a row, including today." : "In a row, up to yesterday. Play something today to keep it going.";
  const days = data.days.week.map((b) => ({
    initial: weekdayShort(b.date).slice(0, 1),
    name: dayName(b.date),
    played: b.plays > 0,
    future: b.future,
    today: b.date === today,
  }));
  const played = days.filter((d) => d.played).length;
  const elapsed = days.filter((d) => !d.future).length;
  return (
    <section class="card home-streak" aria-labelledby="streak-title">
      <div class="card-head">
        <h2 id="streak-title">Streak</h2>
      </div>
      <p class="big">
        <span class="big-value num">{n >= STREAK_DAYS ? `${fmt(STREAK_DAYS)}+` : fmt(n)}</span> <span class="big-unit">{n === 1 ? "day" : "days"}</span>
      </p>
      <p class="soft streak-text">{sentence}</p>
      <StreakDots days={days} label={`This week: played on ${played} of ${elapsed} ${elapsed === 1 ? "day" : "days"} so far`} />
      <div class="best">
        <h3>Best day this year</h3>
        {data.bestDay ? (
          <p>
            <span class="best-day">{dayLong(data.bestDay.date)}</span>
            <span class="best-plays num">{playsText(data.bestDay.plays)}</span>
          </p>
        ) : (
          <p class="muted">No plays this year yet.</p>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------- top lists

function TopTracks({ data, month }: { data: HomeData; month: string }) {
  const tracks = data.topTracks;
  return (
    <section class="card home-tracks" aria-labelledby="tracks-title">
      <div class="card-head">
        <h2 id="tracks-title">Top tracks</h2>
        <span class="head-meta">{month} so far</span>
      </div>
      {tracks.length ? (
        <ol class="tracks">
          {tracks.map((t, i) => (
            <TrackRow rank={i + 1} track={t} art={artOf(data, t.id)} max={tracks[0]!.plays} />
          ))}
        </ol>
      ) : (
        <EmptyState title="No plays this month yet">Your most played tracks show up here.</EmptyState>
      )}
    </section>
  );
}

function TopArtists({ data, month }: { data: HomeData; month: string }) {
  const artists = data.topArtists;
  return (
    <section class="card home-artists" aria-labelledby="artists-title">
      <div class="card-head">
        <h2 id="artists-title">Top artists</h2>
        <span class="head-meta">{month} so far</span>
      </div>
      {artists.length ? (
        <BarList
          label={`Top artists, ${month} so far`}
          items={artists.map((a) => ({ label: a.name, value: a.plays, href: artistUrl(a.id), media: <ArtistAvatar name={a.name} url={artOf(data, a.id)} /> }))}
        />
      ) : data.topTracks.length ? (
        <EmptyState title="No artist details yet">Artists show up once their details are fetched from Spotify, usually by tonight.</EmptyState>
      ) : (
        <EmptyState title="No plays this month yet">The artists you play most show up here.</EmptyState>
      )}
    </section>
  );
}

function YourSound({ data, month }: { data: HomeData; month: string }) {
  return (
    <section class="card home-sound" aria-labelledby="sound-title">
      <div class="card-head">
        <h2 id="sound-title">Your sound</h2>
        <span class="head-meta">Top genres</span>
      </div>
      {data.genres.length ? (
        <BarList label={`Top genres, ${month} so far`} tone="second" items={data.genres.map((g) => ({ label: g.genre, value: g.plays }))} />
      ) : data.topTracks.length ? (
        <EmptyState title="No genres yet">Genres come from Spotify's artist details; none of this month's artists have any yet.</EmptyState>
      ) : (
        <EmptyState title="No plays this month yet">Your top genres show up here.</EmptyState>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------- when you listen

function WhenYouListen({ data }: { data: HomeData }) {
  const { grid, from, to } = data.hours;
  const total = sum(grid.map(sum));
  const days = grid.map((row, d) => ({ d, plays: sum(row) }));
  const hourTotals = Array.from({ length: 24 }, (_, h) => ({ h, plays: sum(grid.map((row) => row[h] ?? 0)) }));
  const day = busiest(days, (x) => x.plays);
  const hour = busiest(hourTotals, (x) => x.plays);
  const span = `${dayShort(from)} to ${dayShort(to)}`;
  const summary =
    day && hour
      ? `${playsText(total)} in the last 4 weeks (${span}); busiest on ${WEEKDAYS[day.d]}s and around ${hourName(hour.h)}.`
      : `No plays in the last 4 weeks (${span}).`;
  return (
    <section class="card home-hours" aria-labelledby="hours-title">
      <div class="card-head">
        <h2 id="hours-title">When you listen</h2>
        <span class="head-meta">Last 4 weeks</span>
      </div>
      {day && hour ? (
        <p class="lead">
          Mostly on <strong>{WEEKDAYS[day.d]}s</strong>, around <strong>{hourName(hour.h)}</strong>.
        </p>
      ) : (
        <p class="lead">No plays in the last 4 weeks.</p>
      )}
      <Heatmap grid={grid} summary={summary} />
    </section>
  );
}

// ---------------------------------------------------------------------------- new to you

function NewToYou({ data, month }: { data: HomeData; month: string }) {
  const n = data.newToYou;
  const fresh = Math.max(0, n.plays - n.repeatPlays);
  const share = n.plays ? Math.round((fresh / n.plays) * 100) : 0;
  return (
    <section class="card home-new" aria-labelledby="new-title">
      <div class="card-head">
        <h2 id="new-title">New to you</h2>
        <span class="head-meta">{month} so far</span>
      </div>
      {n.plays ? (
        <>
          <p class="big">
            <span class="big-value num">{fmt(n.newTracks)}</span> <span class="big-unit">new {n.newTracks === 1 ? "track" : "tracks"}</span>
          </p>
          <SplitBar
            summary={`${share}% of this month's plays were of songs new to you.`}
            parts={[
              { label: "New to you", value: fresh, tone: "accent" },
              { label: "Heard before", value: n.repeatPlays, tone: "second" },
            ]}
          />
          {n.newArtists.length ? (
            <>
              <h3 class="sub-title">New artists</h3>
              <ul class="people">
                {n.newArtists.map((a) => (
                  <li>
                    <ArtistAvatar name={a.name} url={artOf(data, a.id)} size={56} />
                    <a href={artistUrl(a.id)}>{a.name}</a>
                    <span class="muted num">{playsText(a.plays)}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      ) : (
        <EmptyState title="No plays this month yet">Songs and artists you hear for the first time show up here.</EmptyState>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------- throwback

function Throwback({ data, month }: { data: HomeData; month: string }) {
  return (
    <section class="card home-throwback" aria-labelledby="throwback-title">
      <div class="card-head">
        <h2 id="throwback-title">Throwback</h2>
        <span class="head-meta">{month} in earlier years</span>
      </div>
      {data.throwbacks.length ? (
        <ul class="throwbacks">
          {data.throwbacks.map((tb) => (
            <li>
              <Cover url={artOf(data, tb.track.id)} size={56} />
              <div class="tb-text">
                <span class="tb-when">
                  {month} {tb.year}
                </span>
                <a class="tb-name" href={trackUrl(tb.track.id)}>
                  {tb.track.name}
                </a>
                <span class="tb-meta">
                  {tb.track.artists ? `${tb.track.artists}, ` : ""}
                  {playsText(tb.track.plays)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title={`No ${month} from earlier years`}>Your top song of {month} a year ago, and five years ago, shows up here once there's listening from then.</EmptyState>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------- emails

function Digests({ data, settings, writeMode }: { data: HomeData; settings: SettingValues; writeMode: WriteMode }) {
  const tz = data.timeZone;
  const { last, next } = data.digests;
  const nextRow = (on: boolean, n: { at: number; period: string } | null) =>
    !on ? (
      <span class="muted">Off</span>
    ) : n ? (
      <>
        {runDay(n.at, tz)}
        <span class="sub">Covers {n.period}</span>
      </>
    ) : (
      <span class="muted">Not scheduled</span>
    );
  const firstNext = [settings.digestWeekly ? next.week : null, settings.digestMonthly ? next.month : null]
    .filter((n): n is { at: number; period: string } => !!n)
    .sort((a, b) => a.at - b.at)[0];
  return (
    <section class="card home-digests" id="emails" aria-labelledby="emails-title">
      <div class="card-head">
        <h2 id="emails-title">Emails</h2>
      </div>
      <h3 class="sub-title">Latest</h3>
      {last ? (
        <div class="digest-last">
          <p class="digest-subject">{last.subject}</p>
          <p class="meta">
            {last.kind === "week" ? "Weekly digest" : "Monthly recap"} for {last.period}, sent {runDay(last.sentAt, tz)} ({ago(last.sentAt, data.now)})
          </p>
        </div>
      ) : (
        <p class="soft">{firstNext ? `The latest digest shows up here after the next send, ${runDay(firstNext.at, tz)}.` : "The latest digest shows up here once one is sent."}</p>
      )}
      <h3 class="sub-title">Next</h3>
      <dl class="facts">
        <dt>Weekly digest</dt>
        <dd>{nextRow(settings.digestWeekly, next.week)}</dd>
        <dt>Monthly recap</dt>
        <dd>{nextRow(settings.digestMonthly, next.month)}</dd>
      </dl>
      {writeMode !== "live" ? <p class="note">Dry run: digests are written to the Worker log instead of being sent.</p> : null}
      <div class="card-foot">
        <a href="/manage#emails">Send a preview</a>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------- page

/** Home's body: status, the hero, this week and month, charts, lists, emails and settings. */
export function HomeView({ data, settings, aiAvailable, writeMode }: HomeViewProps) {
  const today = formatDate(zonedDate(data.now, data.timeZone));
  const month = monthName(today);
  const empty = data.days.year.every((m) => m.plays === 0) && !data.songOfWeek;
  return (
    <div class={`home${empty ? " is-new" : ""}`}>
      <div class="home-status">
        <StatusChip status={data.status} now={data.now} />
        {writeMode !== "live" ? <Pill tone="neutral" text={writeMode === "dry_run" ? "Dry run" : "Shadow mode"} /> : null}
      </div>
      {/* Without a song, the hero itself offers "Connect Spotify"; don't say it twice. */}
      {!data.status.connected && !data.songOfWeek ? null : <Banner status={data.status} now={data.now} />}
      <Hero data={data} empty={empty} />
      {empty ? null : (
        <>
          <div class="home-sofar">
            <SoFar id="week" title="This week so far" period={data.week} vs="last week" />
            <SoFar id="month" title={`${month} so far`} period={data.month} vs="last month" />
          </div>
          <ListeningByDay data={data} today={today} />
          <Streak data={data} today={today} />
          <TopTracks data={data} month={month} />
          <TopArtists data={data} month={month} />
          <YourSound data={data} month={month} />
          <WhenYouListen data={data} />
          <NewToYou data={data} month={month} />
          <Throwback data={data} month={month} />
        </>
      )}
      <Digests data={data} settings={settings} writeMode={writeMode} />
      <SettingsWidget settings={settings} aiAvailable={aiAvailable} />
    </div>
  );
}
