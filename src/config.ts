import type { Env, WriteMode } from "./env";
import { parseWriteMode } from "./env";
import { resolveSettings, type SettingValues } from "./settings";

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

/** The owner's on/off settings for each job or playlist (src/settings.ts). */
export interface Features {
  liked: boolean;
  frequent: boolean;
  artistPlaylists: boolean;
  hindiFavorites: boolean;
  onThisDay: boolean;
  forgottenFavorites: boolean;
  holiday: boolean;
}

export interface Config {
  writeMode: WriteMode;
  /** The sync cursor's `state` key: SYNC_CURSOR_KEY (the Python parity fixtures use their own). */
  cursorKey: string;
  /**
   * A fixed playlist instead of the owned one in `state` (`playlist:frequent`, `playlist:hindi`),
   * which is created on first use. Only the Python parity fixtures set these; loadConfig never does.
   */
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
  features: Features;
  digests: { weekly: boolean; monthly: boolean; aiEditor: boolean };
}

/**
 * What a job returns when its setting is off (or its playlist was deleted in Spotify): withJob then
 * clears the job's failure state without a "recovered" email and logs no activity.
 */
export const DISABLED: Readonly<{ disabled: true }> = Object.freeze({ disabled: true });
export type Disabled = typeof DISABLED;
export const isDisabled = (result: unknown): result is Disabled =>
  typeof result === "object" && result !== null && (result as { disabled?: unknown }).disabled === true;

/**
 * Where the sync keeps its cursor. Older deployments named it after SPOTIFY_ALL_PLAYLIST_ID
 * (`cursor_after_ms:<id>`); migration v12 moved theirs here.
 */
export const SYNC_CURSOR_KEY = "cursor_after_ms:default";

/**
 * The jobs' config: fixed tuning (defaults mirror the original Python service's config) plus the
 * owner's settings. `settings` defaults to the deploy config and code defaults (no D1 read); jobs
 * get the effective ones from withJob (src/runtime.ts).
 */
export function loadConfig(env: Env, settings: SettingValues = resolveSettings([], env).values): Config {
  const s = settings;
  return {
    writeMode: parseWriteMode(env.WRITE_MODE),
    cursorKey: SYNC_CURSOR_KEY,
    frequentPlaylistId: null,
    hindiFavoritesPlaylistId: null,
    frequentMinPlays: s.frequentMinPlays,
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
    timeZone: s.timeZone,
    historyPlaylists: {
      onThisDayPerYear: 10,
      forgottenMinPlays: 20,
      forgottenIdleDays: 365,
      forgottenSize: 50,
      holidayMinPlays: 3,
    },
    features: {
      liked: s.liked,
      frequent: s.frequent,
      artistPlaylists: s.artistPlaylists,
      hindiFavorites: s.hindiFavorites,
      onThisDay: s.onThisDay,
      forgottenFavorites: s.forgottenFavorites,
      holiday: s.holiday,
    },
    digests: { weekly: s.digestWeekly, monthly: s.digestMonthly, aiEditor: s.aiEditor },
  };
}

function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}
