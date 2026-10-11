// Owner-adjustable settings (tasks/dashboard-plan.md section 4).
// CONTRACT from WP-0: the types, keys and registry below are what WP-B (resolve/load/save, jobs)
// and WP-C (the settings page) agree on. WP-B implements the functions, which throw until then.
//
// Precedence per key: a `settings` row (changed on the dashboard), then the deploy config (the
// SETTINGS JSON var, handled generically, and the legacy vars in `fromEnv`), then `default`.
// Invalid values never throw: they fall through to the next layer and are listed in `problems`.
// Infrastructure (bindings, domain, crons, secrets, WRITE_MODE, addresses, Spotify ids) stays out.
//
// Settings form encoding (POST /settings, read by saveSettings):
// - every visible setting posts its key; a boolean posts a hidden "false" followed by a checkbox
//   "true" (the last value wins), integers and time zones post their text;
// - `reset=<key>` removes that key's dashboard override (the lower layer applies again);
// - turning on a boolean with `confirmOn` also needs `confirmField(key)` = "yes", or saveSettings
//   returns an error for that key.

import type { Env } from "./env";

export interface SettingValues {
  liked: boolean;
  frequent: boolean;
  frequentMinPlays: number;
  artistPlaylists: boolean;
  hindiFavorites: boolean;
  onThisDay: boolean;
  forgottenFavorites: boolean;
  holiday: boolean;
  alerts: boolean;
  digestWeekly: boolean;
  digestMonthly: boolean;
  aiEditor: boolean;
  timeZone: string;
}

/** "alerts" | "digestWeekly" | "digestMonthly" | "aiEditor" | "liked" | "frequent" | "frequentMinPlays" | "artistPlaylists" | "hindiFavorites" | "onThisDay" | "forgottenFavorites" | "holiday" | "timeZone" */
export type SettingKey = keyof SettingValues;
export type SettingType = "boolean" | "integer" | "timeZone";
export type SettingGroup = "Playlists" | "Emails" | "General";
/** Where the effective value came from: changed here, the deploy config, or the code default. */
export type SettingSource = "dashboard" | "deploy" | "default";

export interface SettingDef<K extends SettingKey = SettingKey> {
  key: K;
  type: SettingType;
  group: SettingGroup;
  label: string;
  description: string;
  default: SettingValues[K];
  /** Integers only: inclusive bounds. */
  min?: number;
  max?: number;
  /** Booleans only: switching on needs the owner to acknowledge this text (see confirmField). */
  confirmOn?: string;
  /** Legacy deploy vars for this key (the SETTINGS JSON var is handled generically); undefined = not set. */
  fromEnv?: (env: Env) => unknown;
  /** Shown on the settings page; default: shown. */
  visible?: (env: Env) => boolean;
  /** A value that overrides every layer (e.g. aiEditor is false without an OpenAI key). */
  force?: (env: Env) => SettingValues[K] | undefined;
}

export interface EffectiveSettings {
  values: SettingValues;
  source: Record<SettingKey, SettingSource>;
  /** Invalid stored or deploy values that were ignored, in owner-facing words. */
  problems: string[];
}

export type SaveSettingsResult = { ok: true; changed: SettingKey[] } | { ok: false; errors: Partial<Record<SettingKey, string>> };

/** The form field that acknowledges a setting's `confirmOn` text. */
export const confirmField = (key: SettingKey): string => `confirm_${key}`;

/** Shown wherever Liked Songs can be switched on (settings, the import's backfill option). */
export const LIKED_SONGS_WARNING =
  "Adds every track you play to your Liked Songs. Songs you already liked are untouched. Turning this off later doesn't remove the songs it added.";

const REGISTRY: { [K in SettingKey]: SettingDef<K> } = {
  liked: {
    key: "liked",
    type: "boolean",
    group: "Playlists",
    label: "Add played songs to Liked Songs",
    description: "Every track you play is added to your Liked Songs.",
    default: false,
    confirmOn: LIKED_SONGS_WARNING,
  },
  frequent: {
    key: "frequent",
    type: "boolean",
    group: "Playlists",
    label: "Frequent Plays",
    description: "A playlist of the songs you play most, kept up to date as you listen.",
    default: true,
  },
  frequentMinPlays: {
    key: "frequentMinPlays",
    type: "integer",
    group: "Playlists",
    label: "Plays to join Frequent Plays",
    description: "How many times you need to play a song before it's added to Frequent Plays.",
    default: 5,
    min: 2,
    max: 100,
    fromEnv: (env) => env.FREQUENT_MIN_PLAYS || undefined,
  },
  artistPlaylists: {
    key: "artistPlaylists",
    type: "boolean",
    group: "Playlists",
    label: "Artist playlists",
    description: "A playlist for each artist you listen to a lot, updated every night.",
    default: true,
  },
  hindiFavorites: {
    key: "hindiFavorites",
    type: "boolean",
    group: "Playlists",
    label: "Hindi Favorites",
    description: "Your most-played Hindi and Desi songs (by artist genre), updated every night.",
    default: false,
    fromEnv: (env) => (env.SPOTIFY_HINDI_FAVORITES_PLAYLIST_ID ? true : undefined),
  },
  onThisDay: {
    key: "onThisDay",
    type: "boolean",
    group: "Playlists",
    label: "On This Day",
    description: "What you played on today's date in earlier years, refreshed every day.",
    default: true,
  },
  forgottenFavorites: {
    key: "forgottenFavorites",
    type: "boolean",
    group: "Playlists",
    label: "Forgotten Favorites",
    description: "Songs you used to play a lot but haven't heard in a year, refreshed every week.",
    default: true,
  },
  holiday: {
    key: "holiday",
    type: "boolean",
    group: "Playlists",
    label: "Holiday Favorites",
    description: "The holiday songs you play, collected in season (October to January 6).",
    default: true,
  },
  alerts: {
    key: "alerts",
    type: "boolean",
    group: "Emails",
    label: "Problem alerts",
    description: "An email when a job fails, a reminder while it keeps failing, and a note when it recovers.",
    default: true,
  },
  digestWeekly: {
    key: "digestWeekly",
    type: "boolean",
    group: "Emails",
    label: "Weekly digest",
    description: "Your week in music, every Monday morning.",
    default: true,
  },
  digestMonthly: {
    key: "digestMonthly",
    type: "boolean",
    group: "Emails",
    label: "Monthly recap",
    description: "Your month in music, on the 1st.",
    default: true,
  },
  aiEditor: {
    key: "aiEditor",
    type: "boolean",
    group: "Emails",
    label: "AI editor for digests",
    description: "An AI model arranges each digest and writes its headlines; every number still comes from your data. At most 10 calls a month.",
    default: false,
    fromEnv: (env) => (env.AI_EDITOR === "on" ? true : undefined),
    visible: (env) => !!env.OPENAI_API_KEY,
    force: (env) => (env.OPENAI_API_KEY ? undefined : false),
  },
  timeZone: {
    key: "timeZone",
    type: "timeZone",
    group: "General",
    label: "Time zone",
    description: "Decides when your day and week start: history playlists, the holiday season, digests and the times in emails.",
    default: "UTC",
    fromEnv: (env) => env.TIME_ZONE || undefined,
  },
};

/** Every key, in display order. */
export const SETTING_KEYS = Object.keys(REGISTRY) as SettingKey[];
/** The registry in display order (render the settings page from this). */
export const SETTING_DEFS: readonly SettingDef[] = SETTING_KEYS.map((key) => REGISTRY[key] as SettingDef);
/** Group order on the settings page. */
export const SETTING_GROUPS: readonly SettingGroup[] = ["Playlists", "Emails", "General"];

export const settingDef = <K extends SettingKey>(key: K): SettingDef<K> => REGISTRY[key];

const notImplemented = (what: string) => new Error(`not implemented: ${what} (WP-B)`);

/** Pure; never throws. `rows` are the `settings` table's rows. */
export function resolveSettings(rows: Array<{ key: string; value: string }>, env: Env): EffectiveSettings {
  throw notImplemented("resolveSettings");
}

/** Exactly one D1 query. */
export async function loadSettings(db: D1Database, env: Env): Promise<EffectiveSettings> {
  throw notImplemented("loadSettings");
}

/** Stores only overrides (a value equal to the lower layer deletes the row), ignores unknown keys, logs activity. */
export async function saveSettings(db: D1Database, env: Env, form: FormData): Promise<SaveSettingsResult> {
  throw notImplemented("saveSettings");
}
