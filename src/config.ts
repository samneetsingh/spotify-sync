import type { Env, WriteMode } from "./env";
import { parseWriteMode } from "./env";

export interface ArtistDiscoveryConfig {
  playsPerSongThreshold: number;
  songsOverThreshold: number;
  totalStreamsThreshold: number;
  altSongCount: number;
  altStreamsThreshold: number;
  minPlaysPerTrack: number;
  maxTracksPerPlaylist: number;
  minTracksPerPlaylist: number;
}

export interface HistoryPlaylistsConfig {
  onThisDayPerYear: number;
  forgottenMinPlays: number;
  forgottenIdleDays: number;
  forgottenSize: number;
  holidayMinPlays: number;
}

export interface Config {
  writeMode: WriteMode;
  /**
   * Legacy: only the namespace of the sync cursor key (`cursor_after_ms:<id>`), never a write
   * target. `SPOTIFY_ALL_PLAYLIST_ID` when set (older deployments keep theirs so the key doesn't
   * change), else DEFAULT_CURSOR_NAMESPACE.
   */
  allPlaylistId: string;
  frequentPlaylistId: string | null;
  hindiFavoritesPlaylistId: string | null;
  frequentMinPlays: number;
  hindiFavoritesMinPlays: number;
  bootstrapHours: number;
  recentlyPlayedLimit: number;
  addBatchSize: number;
  likeBatchSize: number;
  cacheRefreshHours: number;
  artistDiscovery: ArtistDiscoveryConfig;
  timeZone: string;
  historyPlaylists: HistoryPlaylistsConfig;
}

export const DEFAULT_CURSOR_NAMESPACE = "default";

// Defaults mirror the original Python service's config.
export function loadConfig(env: Env): Config {
  return {
    writeMode: parseWriteMode(env.WRITE_MODE),
    allPlaylistId: env.SPOTIFY_ALL_PLAYLIST_ID || DEFAULT_CURSOR_NAMESPACE,
    frequentPlaylistId: env.SPOTIFY_FREQUENT_PLAYLIST_ID || null,
    hindiFavoritesPlaylistId: env.SPOTIFY_HINDI_FAVORITES_PLAYLIST_ID || null,
    frequentMinPlays: positiveInt("FREQUENT_MIN_PLAYS", env.FREQUENT_MIN_PLAYS, 2),
    hindiFavoritesMinPlays: positiveInt("HINDI_FAVORITES_MIN_PLAYS", env.HINDI_FAVORITES_MIN_PLAYS, 5),
    bootstrapHours: 24,
    recentlyPlayedLimit: 50,
    addBatchSize: 100,
    likeBatchSize: 50,
    cacheRefreshHours: 24,
    artistDiscovery: {
      playsPerSongThreshold: 20,
      songsOverThreshold: 15,
      totalStreamsThreshold: 1500,
      altSongCount: 60,
      altStreamsThreshold: 500,
      minPlaysPerTrack: 30,
      maxTracksPerPlaylist: 50,
      minTracksPerPlaylist: 10,
    },
    timeZone: timeZone(env.TIME_ZONE),
    historyPlaylists: {
      onThisDayPerYear: 10,
      forgottenMinPlays: 20,
      forgottenIdleDays: 365,
      forgottenSize: 50,
      holidayMinPlays: 3,
    },
  };
}

function timeZone(raw: string | undefined): string {
  const tz = raw || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new Error(`TIME_ZONE must be an IANA time zone such as America/Los_Angeles (got ${tz})`);
  }
  return tz;
}

function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}
