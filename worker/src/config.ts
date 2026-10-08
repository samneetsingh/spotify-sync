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

export interface Config {
  writeMode: WriteMode;
  /** Only used as the sync cursor key namespace (`cursor_after_ms:<id>`), not as a write target. */
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
}

// Defaults mirror src/config/__init__.py + config.yaml.
export function loadConfig(env: Env): Config {
  if (!env.SPOTIFY_ALL_PLAYLIST_ID) throw new Error("SPOTIFY_ALL_PLAYLIST_ID is required");
  return {
    writeMode: parseWriteMode(env.WRITE_MODE),
    allPlaylistId: env.SPOTIFY_ALL_PLAYLIST_ID,
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
  };
}

function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}
