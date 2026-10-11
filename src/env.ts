export interface Env {
  DB: D1Database;
  /** Secrets: the Spotify app's credentials (login, token refresh). */
  SPOTIFY_CLIENT_ID: string;
  SPOTIFY_CLIENT_SECRET: string;
  /** live | shadow | dry_run (anything else is dry_run). */
  WRITE_MODE: string;
  /** The Worker's public origin, e.g. https://spotify-sync.example.com: the dashboard, its one OAuth redirect (/auth/callback), email links and images. */
  PUBLIC_URL?: string;
  /** Email (optional): send_email binding plus sender/recipient. ALERT_EMAIL_TO also receives the one-time setup link. */
  ALERT_EMAIL?: SendEmail;
  ALERT_FROM?: string;
  ALERT_EMAIL_TO?: string;
  /** Deploy-config layer of the dashboard settings: a JSON object of setting key -> value (src/settings.ts). */
  SETTINGS?: string;
  /** Secret for the AI editor (OpenAI). Without it the setting is hidden and off. */
  OPENAI_API_KEY?: string;
  /** Transient staging for history imports (R2, objects deleted after parsing). Import is hidden without it. */
  IMPORTS?: R2Bucket;
  /** The history import Workflow (`ImportWorkflow`, src/import). Import is hidden without it. */
  IMPORT_WORKFLOW?: Workflow<ImportParams>;
  /** Tuning, not in the template: plays for Hindi Favorites (default 5). */
  HINDI_FAVORITES_MIN_PLAYS?: string;

  // Pre-dashboard deploy vars (LEGACY_VARS in src/settings.ts). Only for upgrading an existing
  // instance: configure renders them while its deploy config still has them, and the Worker copies
  // them into D1 once (importLegacyConfig in src/runtime.ts); then they come out of the deploy
  // config (README, "Upgrading"). Until then TIME_ZONE, FREQUENT_MIN_PLAYS, AI_EDITOR and the Hindi
  // id are also the deploy layer of their settings, and SPOTIFY_USER_ID overrides the owner pin.
  // New code reads the settings and `state` instead, never these.
  /** Copied to `state` owner:spotify_id; while set, the owner (src/auth/owner.ts). */
  SPOTIFY_USER_ID?: string;
  /** Not read: migration v12 moved the sync cursor to `cursor_after_ms:default`. */
  SPOTIFY_ALL_PLAYLIST_ID?: string;
  /** Copied to `state` playlist:frequent (empty = Frequent Plays off). */
  SPOTIFY_FREQUENT_PLAYLIST_ID?: string;
  /** Copied to `state` playlist:hindi; set = the hindiFavorites setting on. */
  SPOTIFY_HINDI_FAVORITES_PLAYLIST_ID?: string;
  /** The timeZone setting. */
  TIME_ZONE?: string;
  /** The frequentMinPlays setting. */
  FREQUENT_MIN_PLAYS?: string;
  /** "on" = the aiEditor setting on. */
  AI_EDITOR?: string;
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
