// The Home view: the page body under the shell's (visually hidden) "Home" heading. Pure rendering
// from HomeData (./home-data.ts), so it is easy to test and to screenshot. Every widget is a
// <section> with an <h2>; each has its own empty state, and a quiet period shows zeros rather than a
// blank chart. Times are in data.timeZone; dates in HomeData are already local ("YYYY-MM-DD").

import { artistUrl, fmt, trackUrl } from "../email/layout";
import type { WriteMode } from "../env";
import { formatDate, zonedDate } from "../utils/time";
import { BarList, ChartDefs, Heatmap, LineChart, RangeSwitch, SplitBar, StreakDots, type LinePoint, type LineSeries } from "./components/charts";
import { dayLong, dayName, dayShort, hourName, hours, monthName, monthShort, playsText, weekdayShort, WEEKDAYS } from "./components/format";
import { ArtistAvatar, Cover, HeroCover, TrackRow } from "./components/music";
import { LinkButton, Pill } from "./components/primitives";
import { delta, StatTile } from "./components/stats";
import { Banner, EmptyState, StatusChip } from "./components/status";
import { MONTH_DAYS, STREAK_DAYS, type HomeData, type PeriodSoFar, type Trend } from "./home-data";

/** The cached image for a Spotify id; own keys only, so an id like "constructor" can't pick up Object's members. */
const artOf = (data: HomeData, id: string): string | undefined => (Object.hasOwn(data.art, id) && data.art[id]) || undefined;

export interface HomeViewProps {
  data: HomeData;
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
        <HeroCover />
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
      <HeroCover cover={artOf(data, t.id)} />
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
        <StatTile label="Plays" value={fmt(c.plays)} delta={delta(c.plays, p.plays)} icon="play" />
        <StatTile label="Hours" value={hours(c.ms)} delta={delta(Math.round(c.ms / 360_000), Math.round(p.ms / 360_000))} icon="clock" />
        <StatTile label="New tracks" value={fmt(c.newTracks)} delta={delta(c.newTracks, p.newTracks)} icon="music" />
        <StatTile label="New artists" value={fmt(c.newArtists)} delta={delta(c.newArtists, p.newArtists)} icon="user" />
      </dl>
      <p class="note">Changes compare with the same point {vs}.</p>
    </section>
  );
}

// ---------------------------------------------------------------------------- listening by day

/** Each year's line with its legend total; this year's says "so far" while its span isn't over. */
function trendSeries(trend: Trend, soFar: boolean): LineSeries[] {
  return trend.lines.map((l, k) => ({
    label: String(l.year),
    values: l.plays,
    total: `${playsText(sum(l.plays.map((v) => v ?? 0)))}${k === 0 && soFar ? " so far" : ""}`,
  }));
}

/** "This week so far: 120 plays. The same week in 2025: 210, 2024: 180." */
function trendSummary(trend: Trend, title: string, soFar: boolean, others: string): string {
  const [now, ...before] = trend.lines.map((l) => ({ year: l.year, total: sum(l.plays.map((v) => v ?? 0)) }));
  const head = `${title}${soFar ? " so far" : ""}: ${playsText(now?.total ?? 0)}.`;
  return before.length ? `${head} ${others} ${before.map((b) => `${b.year}: ${fmt(b.total)}`).join(", ")}.` : head;
}

/**
 * Week: every day labelled ("Mon"). The last 30 days: every 7th day back from today labelled with
 * its day of the month ("20"), plus the month on the first label and the first in a new month
 * ("Oct 4"). Year: every month ("Oct"), every other one on phones.
 */
function weekPoints(dates: string[], today: string): LinePoint[] {
  return dates.map((d) => ({ label: weekdayShort(d), name: dayName(d), highlight: d === today }));
}

function recentPoints(dates: string[], today: string): LinePoint[] {
  let labelledMonth = "";
  return dates.map((d, i) => {
    const tick = (dates.length - 1 - i) % 7 === 0;
    const month = d.slice(0, 7);
    const label = tick && month !== labelledMonth ? dayShort(d) : String(Number(d.slice(8)));
    if (tick) labelledMonth = month;
    return { label, name: dayShort(d), highlight: d === today, tick };
  });
}

function yearPoints(months: string[], today: string): LinePoint[] {
  return months.map((m, i) => ({ label: monthShort(m), name: monthName(m), highlight: m === today.slice(0, 7), tickWide: i % 2 === 1 }));
}

/** The listening chart's height: it spans the Streak and Throwback cards beside it on wide screens. */
const CHART_H = 340;

function ListeningByDay({ data, today }: { data: HomeData; today: string }) {
  const { week, month, year } = data.trends;
  return (
    <section class="card home-days" aria-labelledby="days-title">
      <RangeSwitch
        name="days"
        legend="Show listening by"
        head={<h2 id="days-title">Listening by day</h2>}
        options={[
          {
            id: "week",
            label: "Week",
            content: <LineChart id="days-week" height={CHART_H} points={weekPoints(week.x, today)} series={trendSeries(week, true)} note="so far" summary={trendSummary(week, "This week", true, "The same week in")} />,
          },
          {
            id: "month",
            label: "Month",
            content: (
              <LineChart
                id="days-month"
                height={CHART_H}
                points={recentPoints(month.x, today)}
                series={trendSeries(month, false)}
                note="so far"
                summary={trendSummary(month, `The last ${MONTH_DAYS} days`, false, "The same dates in")}
              />
            ),
          },
          {
            id: "year",
            label: "Year",
            content: <LineChart id="days-year" height={CHART_H} points={yearPoints(year.x, today)} series={trendSeries(year, true)} note="so far" summary={trendSummary(year, String(year.lines[0]?.year ?? ""), true, "The years before:")} />,
          },
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

// ---------------------------------------------------------------------------- page

/** Home's body: status, the hero, this week and month, charts and lists. */
export function HomeView({ data, writeMode }: HomeViewProps) {
  const today = formatDate(zonedDate(data.now, data.timeZone));
  const month = monthName(today);
  const empty = !data.anyPlays && !data.songOfWeek;
  return (
    <div class={`home${empty ? " is-new" : ""}`}>
      <ChartDefs />
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
          <Throwback data={data} month={month} />
          <TopTracks data={data} month={month} />
          <TopArtists data={data} month={month} />
          <YourSound data={data} month={month} />
          <WhenYouListen data={data} />
          <NewToYou data={data} month={month} />
        </>
      )}
    </div>
  );
}
