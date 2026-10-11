export interface Env {
  DB: D1Database;
  SPOTIFY_CLIENT_ID: string;
  SPOTIFY_CLIENT_SECRET: string;
  /** Legacy, optional: namespace of the sync cursor key (see Config.allPlaylistId). */
  SPOTIFY_ALL_PLAYLIST_ID?: string;
  SPOTIFY_FREQUENT_PLAYLIST_ID?: string;
  SPOTIFY_HINDI_FAVORITES_PLAYLIST_ID?: string;
  FREQUENT_MIN_PLAYS?: string;
  HINDI_FAVORITES_MIN_PLAYS?: string;
  /** IANA zone for the history playlists' "today" (e.g. America/Los_Angeles); defaults to UTC. */
  TIME_ZONE?: string;
  WRITE_MODE: string;
  SYNC_FULL_SECRET: string;
  /** Failure alerts (optional): send_email binding plus sender/recipient addresses. */
  ALERT_EMAIL?: SendEmail;
  ALERT_FROM?: string;
  ALERT_EMAIL_TO?: string;
  /** The Worker's public origin, e.g. https://spotify-sync.example.com (reconnect links, email images). */
  PUBLIC_URL?: string;
  /** The Spotify account allowed to reconnect (the reconnect link refuses any other). */
  SPOTIFY_USER_ID?: string;
}

export type WriteMode = "live" | "dry_run" | "shadow";

export function parseWriteMode(raw: string | undefined): WriteMode {
  if (raw === "live" || raw === "shadow") return raw;
  return "dry_run";
}
