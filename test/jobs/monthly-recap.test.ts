import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AlertConfig } from "../../src/alerts";
import { loadConfig, type Config } from "../../src/config";
import type { Env, WriteMode } from "../../src/env";
import { getState } from "../../src/db/state";
import { migrate } from "../../src/db/schema";
import { renderRecap, runMonthlyRecap, type RecapData } from "../../src/jobs/monthly-recap";
import { resetDb } from "../parity/spotify-fixture";

const OCT_11 = Date.UTC(2026, 9, 11, 15); // recaps September 2026 (Los Angeles)

type Sent = { subject: string; text: string; html?: string };

function fakeEmail(opts: { fail?: boolean } = {}) {
  const sent: Sent[] = [];
  const binding = {
    async send(msg: Sent) {
      if (opts.fail) throw new Error("boom");
      sent.push(msg);
      return { messageId: `m${sent.length}` };
    },
  } as unknown as SendEmail;
  return { sent, cfg: { binding, from: "spotify-sync@example.com", to: "me@example.com" } as AlertConfig };
}

const config = (mode: WriteMode = "live"): Config =>
  loadConfig({ SPOTIFY_ALL_PLAYLIST_ID: "all1", WRITE_MODE: mode, TIME_ZONE: "America/Los_Angeles" } as Env);

/** One track per row, credited to one artist, played at the given UTC times. */
async function seed(rows: Array<{ id: string; name: string; artist: [string, string]; at: string[]; durationMs?: number }>) {
  await env.DB.batch(
    rows.flatMap(({ id, name, artist, at, durationMs }) => [
      env.DB.prepare("INSERT INTO tracks(track_id, track_uri, name, artists, duration_ms) VALUES(?1, 'spotify:track:' || ?1, ?2, ?3, ?4)").bind(id, name, artist[1], durationMs ?? null),
      env.DB.prepare("INSERT INTO track_artists(track_id, artist_id, artist_name, position) VALUES(?1, ?2, ?3, 0)").bind(id, artist[0], artist[1]),
      ...at.map((iso) =>
        env.DB.prepare("INSERT INTO plays(played_at_ms, track_id, track_uri, source) VALUES(?1, ?2, 'spotify:track:' || ?2, 'history_import')").bind(Date.parse(iso), id),
      ),
    ]),
  );
}

const days = (prefix: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}-${String(from + i).padStart(2, "0")}T18:00:00Z`);

const SEPTEMBER = [
  {
    id: "a",
    name: "Tom & Jerry <Live>",
    artist: ["A1", "Alpha"] as [string, string],
    durationMs: 3_600_000,
    at: ["2026-08-20T18:00:00Z", "2026-09-13T18:00:00Z", "2026-09-13T19:00:00Z", "2026-09-13T20:00:00Z", "2026-09-20T18:00:00Z"],
  },
  { id: "n", name: "Fresh Song", artist: ["N1", "Newbie"] as [string, string], at: ["2026-09-05T18:00:00Z", "2026-09-06T18:00:00Z"] },
  { id: "r", name: "Comeback", artist: ["R1", "Returner"] as [string, string], at: [...days("2024-05", 1, 10), ...days("2026-09", 2, 4)] },
  { id: "o", name: "Old Gold", artist: ["A1", "Alpha"] as [string, string], at: ["2025-09-10T18:00:00Z", "2025-09-10T19:00:00Z"] },
];

beforeAll(() => migrate(env.DB));
beforeEach(() => resetDb(env.DB));

describe("runMonthlyRecap", () => {
  it("emails last month's recap once", async () => {
    await seed(SEPTEMBER);
    const { sent, cfg } = fakeEmail();
    expect(await runMonthlyRecap(config(), env.DB, cfg, OCT_11)).toEqual({ month: "2026-09", sent: true });
    expect(await getState(env.DB, "recap:last_month")).toBe("2026-09");

    const [email] = sent;
    expect(email!.subject).toBe("Your September 2026 in music: 9 plays");
    expect(email!.text).toContain("9 plays · about 4 hours · 3 tracks · 3 artists");
    expect(email!.text).toContain("1. Tom & Jerry <Live> — Alpha (4 plays)");
    expect(email!.text).toContain("1 track you'd never played before");
    expect(email!.text).toContain("Newbie (first listen · 2 plays)");
    expect(email!.text).toContain("Returner (3 plays, first since May 2024)");
    expect(email!.text).toContain("Sunday, September 13: 3 plays");
    expect(email!.text).toContain("Old Gold — Alpha (your top track in September 2025)");
    expect(email!.html).toContain('<a href="https://open.spotify.com/track/a"');
    expect(email!.html).toContain("Tom &amp; Jerry &lt;Live&gt;");
    expect(email!.html).not.toContain("<Live>");

    expect(await runMonthlyRecap(config(), env.DB, cfg, OCT_11)).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it("fails the job when sending fails (so it alerts), and retries the next day", async () => {
    await seed(SEPTEMBER);
    const broken = fakeEmail({ fail: true });
    await expect(runMonthlyRecap(config(), env.DB, broken.cfg, OCT_11)).rejects.toThrow(/2026-09 recap email could not be sent/);
    expect(await getState(env.DB, "recap:last_month")).toBeNull();

    const ok = fakeEmail();
    expect(await runMonthlyRecap(config(), env.DB, ok.cfg, OCT_11 + 86_400_000)).toEqual({ month: "2026-09", sent: true });
  });

  it("quietly skips sending when email isn't configured", async () => {
    await seed(SEPTEMBER);
    expect(await runMonthlyRecap(config(), env.DB, {}, OCT_11)).toEqual({ month: "2026-09", sent: false });
  });

  it("counts the busiest day in local time across a DST change", async () => {
    // Nov 30 23:30 PST is Dec 1 07:30 UTC; one fixed November offset (PDT) would call it Dec 1.
    await seed([{ id: "x", name: "Late", artist: ["X1", "Night Owl"], at: ["2026-12-01T07:30:00Z", "2026-12-01T07:40:00Z", "2026-11-15T20:00:00Z"] }]);
    const { sent, cfg } = fakeEmail();
    await runMonthlyRecap(config(), env.DB, cfg, Date.UTC(2026, 11, 2, 15));
    expect(sent[0]!.text).toContain("Monday, November 30: 2 plays");
  });

  it("only sends in live mode", async () => {
    await seed(SEPTEMBER);
    const { sent, cfg } = fakeEmail();
    expect(await runMonthlyRecap(config("dry_run"), env.DB, cfg, OCT_11)).toEqual({ month: "2026-09", sent: false });
    expect(sent).toEqual([]);
    expect(await getState(env.DB, "recap:last_month")).toBeNull();
  });

  it("skips a month without plays", async () => {
    const { sent, cfg } = fakeEmail();
    expect(await runMonthlyRecap(config(), env.DB, cfg, OCT_11)).toBeNull();
    expect(sent).toEqual([]);
  });
});

it("renderRecap leaves out sections without data", () => {
  const data: RecapData = {
    month: { year: 2026, month: 9, day: 1 },
    timeZone: "UTC",
    totals: { plays: 1, tracks: 1, artists: 1, ms: 0 },
    topTracks: [{ track_id: "t", name: "Only", artists: "Solo", plays: 1 }],
    topArtists: [{ artist_id: "s", name: "Solo", plays: 1 }],
    newTrackCount: 0,
    newArtists: [],
    returning: [],
    busiestDay: null,
    throwbacks: [],
  };
  const { text, html } = renderRecap(data);
  expect(text).toContain("Top tracks");
  expect(text).toContain("1. Only — Solo (1 play)");
  for (const absent of ["New to you", "Welcome back", "Busiest day", "Throwback"]) {
    expect(text).not.toContain(absent);
    expect(html).not.toContain(absent);
  }
});
