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
  /** Failure alerts (optional): send_email binding plus sender/recipient addresses. */
  ALERT_EMAIL?: SendEmail;
  ALERT_FROM?: string;
  ALERT_EMAIL_TO?: string;
  /** The Worker's public origin, e.g. https://spotify-sync.example.com (reconnect links, email images). */
  PUBLIC_URL?: string;
  /** The Spotify account allowed to reconnect (the reconnect link refuses any other). */
  SPOTIFY_USER_ID?: string;
  /** "on" turns on the digests' optional AI editor (needs OPENAI_API_KEY); anything else is off. */
  AI_EDITOR?: string;
  /** Secret for the AI editor (OpenAI); without it the digests use the default layout. */
  OPENAI_API_KEY?: string;
  /** Transient staging for history imports (R2, objects deleted after parsing). Import is hidden without it. */
  IMPORTS?: R2Bucket;
  /** The history import Workflow (`ImportWorkflow`, src/import). Import is hidden without it. */
  IMPORT_WORKFLOW?: Workflow<ImportParams>;
  /** Deploy-config layer of the dashboard settings: a JSON object of setting key -> value (src/settings.ts). */
  SETTINGS?: string;
}

/** Parameters of one ImportWorkflow instance; a retry runs a new instance with the next attempt. */
export interface ImportParams {
  importId: string;
  attempt: number;
}

export type WriteMode = "live" | "dry_run" | "shadow";

export function parseWriteMode(raw: string | undefined): WriteMode {
  if (raw === "live" || raw === "shadow") return raw;
  return "dry_run";
}
