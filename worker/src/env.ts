export interface Env {
  DB: D1Database;
  SPOTIFY_CLIENT_ID: string;
  SPOTIFY_CLIENT_SECRET: string;
  SPOTIFY_ALL_PLAYLIST_ID: string;
  SPOTIFY_FREQUENT_PLAYLIST_ID?: string;
  SPOTIFY_HINDI_FAVORITES_PLAYLIST_ID?: string;
  FREQUENT_MIN_PLAYS?: string;
  HINDI_FAVORITES_MIN_PLAYS?: string;
  WRITE_MODE: string;
  SYNC_FULL_SECRET: string;
}

export type WriteMode = "live" | "dry_run" | "shadow";

export function parseWriteMode(raw: string | undefined): WriteMode {
  if (raw === "live" || raw === "shadow") return raw;
  return "dry_run";
}
