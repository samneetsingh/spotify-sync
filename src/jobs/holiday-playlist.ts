// Holiday Favorites (Worker-only): every holiday song you've played a few times, added
// automatically through the season. Songs are recognised by title (HOLIDAY_TITLE_PHRASES):
// on real history, artist genres pulled in non-holiday hits and seasonality caught
// ordinary songs binged in winter. Add-only like hindi-favorites: songs you remove stay
// removed (they stay in the playlist cache), songs you add stay. An owned playlist
// (see owned-playlists.ts), created on the first in-season run.

import type { Config } from "../config";
import { holidayTracks, knownPlaylistTrackIds, markTracksInPlaylist, recordActions, runAll } from "../db/queries";
import type { SpotifyClient } from "../spotify/client";
import { chunkArray } from "../utils/batch";
import { formatDate, zonedDate, type LocalDate } from "../utils/time";
import { ensurePlaylist, followChecker, PLACEHOLDER_PREFIX } from "./owned-playlists";
import { backfillPlaylistCache } from "./playlist-cache";

/** Lowercase phrases; a track whose title contains one is a holiday song. ("holiday" alone also matches non-holiday hits.) */
export const HOLIDAY_TITLE_PHRASES = [
  "christmas", "xmas", "santa claus", "santa baby", "santa tell me", "saint nick", "sleigh", "jingle",
  "mistletoe", "reindeer", "rudolph", "frosty", "snowman", "navidad", "silent night", "holy night",
  "winter wonderland", "let it snow", "grinch", "deck the hall", "carol of the bells", "caroling",
  "nutcracker", "drummer boy", "joy to the world", "come all ye faithful", "herald angels",
  "silver bells", "cold outside", "do you hear what i hear", "holly jolly", "holly and the ivy",
  "mele kalikimaka", "god rest ye", "house top", "first noel", "tannenbaum", "new year's eve",
  "marshmallow world", "wonderful time of the year", "underneath the tree", "home for the holidays",
  "happy holiday", "midnight clear", "bethlehem", "wenceslas", "manger",
] as const;

export interface HolidayPlaylistResult {
  tracksAdded: number;
  tracksConsidered: number;
}

/** The holiday season in local time: October 1 to January 6 (your holiday listening starts in October). */
export const inHolidaySeason = (d: LocalDate) => d.month >= 10 || (d.month === 1 && d.day <= 6);

export async function runHolidayPlaylist(
  cfg: Config,
  db: D1Database,
  sp: SpotifyClient,
  now = Date.now(),
): Promise<HolidayPlaylistResult | null> {
  const today = zonedDate(now, cfg.timeZone);
  if (!inHolidaySeason(today)) {
    console.log(JSON.stringify({ job: "holiday-playlist", skipped: `out of season (${formatDate(today)})` }));
    return null;
  }
  const minPlays = cfg.historyPlaylists.holidayMinPlays;
  try {
    const playlistId = await ensurePlaylist(
      cfg,
      db,
      sp,
      {
        key: "holiday",
        name: "Holiday Favorites",
        description: `Holiday songs you've played ${minPlays}+ times, added automatically every October to early January by spotify-sync. Songs you remove stay removed.`,
      },
      followChecker(sp),
    );
    if (!playlistId) return null;
    const placeholder = playlistId.startsWith(PLACEHOLDER_PREFIX);
    // Mirror the playlist first so manual edits are respected (a dry-run placeholder has nothing to read).
    if (!placeholder) await backfillPlaylistCache(cfg, db, sp, playlistId);

    const rows = await holidayTracks(db, minPlays, HOLIDAY_TITLE_PHRASES);
    const known = await knownPlaylistTrackIds(db, playlistId, rows.map((r) => r.track_id));
    const toAdd = rows.filter((r) => !known.has(r.track_id));
    for (const batch of chunkArray(toAdd, cfg.addBatchSize)) {
      await sp.addToPlaylist(playlistId, batch.map((t) => t.track_uri));
    }
    if (toAdd.length && cfg.writeMode !== "dry_run" && !placeholder) {
      await runAll(db, markTracksInPlaylist(db, playlistId, toAdd));
    }

    const result = { tracksAdded: toAdd.length, tracksConsidered: rows.length };
    console.log(JSON.stringify({ job: "holiday-playlist", writeMode: cfg.writeMode, ...result }));
    return result;
  } finally {
    await recordActions(db, "holiday-playlist", cfg.writeMode, null, sp.drainActions());
  }
}
