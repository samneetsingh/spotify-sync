// Realistic digest data for the renderer tests (no D1): a September 2026 recap and the week of
// Sep 28 - Oct 4. Some ids have no art on purpose, so the ♪ fallbacks render too.

import type { DigestData } from "../../src/jobs/digest";

const DISC = "https://sync.test/email/vinyl.png?v=1";
const img = (id: string) => `https://i.test/${id}-300`;
const withArt = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, img(id)]));

/** 7 x 24 plays: quiet small hours, an evening peak that moves around the week. */
const hours = (scale: number) =>
  Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => (h < 7 ? (h < 2 ? d % 3 : 0) : ((d + 2) * (h % 6) + h) % 13) * scale));

export function monthData(): DigestData {
  return {
    period: { kind: "month", start: { year: 2026, month: 9, day: 1 }, end: { year: 2026, month: 10, day: 1 }, key: "2026-09" },
    timeZone: "America/Los_Angeles",
    totals: { plays: 1564, tracks: 412, artists: 187, ms: 313_400_000 },
    previous: null,
    topTracks: [
      { track_id: "t1", name: "Tom & Jerry <Live>", artists: "Alpha, Beta", plays: 48 },
      { track_id: "t2", name: "Midnight City", artists: "M83", plays: 31 },
      { track_id: "t3", name: "Kesariya", artists: "Pritam, Arijit Singh", plays: 27 },
      { track_id: "t4", name: "Retrograde", artists: "James Blake", plays: 22 },
      { track_id: "t5", name: "No Art Here", artists: "Unknown Band", plays: 19 },
    ],
    topArtists: [
      { artist_id: "a1", name: "Alpha", plays: 96 },
      { artist_id: "a2", name: "M83", plays: 61 },
      { artist_id: "a3", name: "Arijit Singh", plays: 58 },
      { artist_id: "a4", name: "James Blake", plays: 40 },
      { artist_id: "a5", name: "Beach House", plays: 33 },
    ],
    newTrackCount: 96,
    newArtists: [
      { artist_id: "n1", name: "Newbie", plays: 12 },
      { artist_id: "n2", name: "Fresh Face", plays: 7 },
      { artist_id: "n3", name: "Nameless Art", plays: 4 },
    ],
    repeatPlays: 1102,
    days: Array.from({ length: 30 }, (_, i) => (i === 17 ? 0 : 20 + ((i * 7 + 3) % 11) * 4 + (i === 12 ? 40 : 0))),
    hours: hours(2),
    returning: [
      { artist_id: "r1", name: "Returner", plays: 14, last_before_ms: Date.UTC(2024, 4, 10, 18) },
      { artist_id: "r2", name: "Sigur Rós", plays: 9, last_before_ms: Date.UTC(2023, 10, 2, 18) },
    ],
    genres: [
      { genre: "dream pop", plays: 412 },
      { genre: "indie rock", plays: 298 },
      { genre: "filmi", plays: 205 },
      { genre: "shoegaze", plays: 120 },
      { genre: "art pop", plays: 64 },
    ],
    year: [980, 1120, 1405, 1310, 870, 1012, 1250, 1630, 1488, 1302, 1820, 1564].map((plays, i) => ({
      month: { year: i < 3 ? 2025 : 2026, month: ((9 + i) % 12) + 1, day: 1 },
      plays,
    })),
    throwbacks: [
      { year: 2025, track: { track_id: "y1", name: "Old Gold", artists: "Alpha", plays: 21 } },
      { year: 2021, track: { track_id: "y5", name: "Way Back", artists: "Beach House", plays: 17 } },
    ],
    art: withArt(["t1", "t2", "t3", "t4", "a1", "a2", "a3", "a4", "a5", "n1", "n2", "r1", "y1"]),
    playlists: [
      { name: "On This Day", url: "https://open.spotify.com/playlist/otd1" },
      { name: "Forgotten Favorites", url: "https://open.spotify.com/playlist/ff1" },
    ],
    discUrl: DISC,
  };
}

export function weekData(): DigestData {
  return {
    period: { kind: "week", start: { year: 2026, month: 9, day: 28 }, end: { year: 2026, month: 10, day: 5 }, key: "2026-W40" },
    timeZone: "America/Los_Angeles",
    totals: { plays: 212, tracks: 98, artists: 51, ms: 44_100_000 },
    previous: { totals: { plays: 260, tracks: 110, artists: 60, ms: 52_300_000 }, newTrackCount: 18 },
    topTracks: [
      { track_id: "w1", name: "This Week", artists: "Weekly", plays: 14 },
      { track_id: "w2", name: "Sunday Best", artists: "Surfaces", plays: 9 },
      { track_id: "w3", name: "Ghost Town", artists: "Kanye West, PARTYNEXTDOOR", plays: 8 },
      { track_id: "w4", name: "Unart", artists: "Nobody", plays: 6 },
    ],
    topArtists: [
      { artist_id: "wa1", name: "Weekly", plays: 22 },
      { artist_id: "wa2", name: "Surfaces", plays: 15 },
      { artist_id: "wa3", name: "Kanye West", plays: 12 },
      { artist_id: "wa4", name: "Nobody", plays: 6 },
    ],
    newTrackCount: 21,
    newArtists: [
      { artist_id: "wn1", name: "First Timer", plays: 5 },
      { artist_id: "wn2", name: "Second Timer", plays: 3 },
    ],
    repeatPlays: 170,
    days: [31, 22, 40, 0, 47, 39, 33],
    hours: hours(1),
    returning: [],
    genres: [],
    year: [],
    throwbacks: [],
    art: withArt(["w1", "w2", "w3", "wa1", "wa2", "wa3", "wn1"]),
    playlists: [{ name: "On This Day", url: "https://open.spotify.com/playlist/otd1" }],
    discUrl: DISC,
  };
}
