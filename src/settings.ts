// Owner-adjustable settings.
// The types, keys and registry are the contract between the jobs (src/config.ts, src/runtime.ts)
// and the settings page (src/dashboard).
//
// Precedence per key: a `settings` row (changed on the dashboard), then the deploy config (the
// SETTINGS JSON var, handled generically, then the legacy vars in `fromEnv`), then `default`.
// Jobs read them once per run (loadSettings in withJob); new owners start from the defaults below.
// Invalid values never throw: they fall through to the next layer and are listed in `problems`.
// Infrastructure (bindings, domain, crons, secrets, WRITE_MODE, addresses, Spotify ids) stays out.
//
// Settings form encoding (POST /settings, read by saveSettings):
// - every visible setting posts its key; a boolean posts a hidden "false" followed by a checkbox
//   "true" (the last value wins), integers and time zones post their text;
// - `reset=<key>` removes that key's dashboard override (the lower layer applies again);
// - turning on a boolean with `confirmOn` also needs `confirmField(key)` = "yes", or saveSettings
//   returns an error for that key.

import { logActivity } from "./activity";
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

/** Whether `key` is a setting (form fields, `settings` rows and deploy keys can be anything). */
export const isSettingKey = (key: string): key is SettingKey => Object.hasOwn(REGISTRY, key);

/**
 * Deploy vars from before the dashboard. A deploy config renders
 * them only while it still has those keys. Until then TIME_ZONE, FREQUENT_MIN_PLAYS, AI_EDITOR and
 * the Hindi id feed the deploy layer (`fromEnv`), and the Worker copies all of them into `settings`
 * and `state` once (importLegacyConfig in src/runtime.ts), so removing them changes nothing.
 */
export const LEGACY_VARS = [
  "TIME_ZONE",
  "FREQUENT_MIN_PLAYS",
  "AI_EDITOR",
  "SPOTIFY_FREQUENT_PLAYLIST_ID",
  "SPOTIFY_HINDI_FAVORITES_PLAYLIST_ID",
  "SPOTIFY_USER_ID",
  "SPOTIFY_ALL_PLAYLIST_ID",
] as const satisfies ReadonlyArray<keyof Env>;

/** Whether any legacy var is set, even empty (older templates rendered every one of them). */
export const hasLegacyVars = (env: Env): boolean => LEGACY_VARS.some((name) => env[name] !== undefined);

/** `env` without the legacy vars: the deploy layer once they're gone. */
export function withoutLegacyVars(env: Env): Env {
  const rest = { ...env };
  for (const name of LEGACY_VARS) delete rest[name];
  return rest;
}

/** `tz` if it's a time zone Intl knows (as given: ICU would rename e.g. Asia/Kolkata to Asia/Calcutta), else undefined. */
export function validTimeZone(tz: string): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

type AnyValue = SettingValues[SettingKey];
const TRUE = new Set(["true", "on", "yes", "1"]);
const FALSE = new Set(["false", "off", "no", "0"]);

/** `raw` as a valid value for `def`, or undefined. Takes JSON values and their text forms (vars, form fields). */
function coerce(def: SettingDef, raw: unknown): AnyValue | undefined {
  switch (def.type) {
    case "boolean": {
      if (typeof raw === "boolean") return raw;
      const text = typeof raw === "string" ? raw.trim().toLowerCase() : "";
      return TRUE.has(text) ? true : FALSE.has(text) ? false : undefined;
    }
    case "integer": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\s*-?\d+\s*$/.test(raw) ? Number(raw) : NaN;
      return Number.isInteger(n) && n >= (def.min ?? -Infinity) && n <= (def.max ?? Infinity) ? n : undefined;
    }
    case "timeZone":
      return typeof raw === "string" ? validTimeZone(raw.trim()) : undefined;
  }
}

/** How a value reads on the page and in the activity log. */
export const displayValue = (def: SettingDef, value: AnyValue): string =>
  def.type === "boolean" ? (value ? "on" : "off") : String(value);

function expected(def: SettingDef): string {
  if (def.type === "boolean") return "on or off";
  if (def.type === "integer") return `a whole number from ${def.min} to ${def.max}`;
  return "a time zone such as America/Los_Angeles";
}

const shown = (raw: unknown): string => {
  const text = raw === undefined ? "(empty)" : JSON.stringify(raw);
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
};

/** A stored row's JSON value; a row that isn't JSON (edited by hand) is taken as text. */
function parseStored(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** The SETTINGS var as an object; anything unusable is reported and ignored. */
function deploySettings(env: Env, problems: string[]): Record<string, unknown> {
  const raw = env.SETTINGS?.trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    problems.push("The deploy config's settings aren't valid JSON, so they're ignored.");
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    problems.push("The deploy config's settings must be an object of setting names and values, so they're ignored.");
    return {};
  }
  const unknown = Object.keys(parsed).filter((key) => !isSettingKey(key));
  if (unknown.length) problems.push(`The deploy config's settings have names that don't exist, which are ignored: ${unknown.join(", ")}.`);
  return parsed as Record<string, unknown>;
}

/** Pure; never throws. `rows` are the `settings` table's rows. */
export function resolveSettings(rows: Array<{ key: string; value: string }>, env: Env): EffectiveSettings {
  const problems: string[] = [];
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  const deploy = deploySettings(env, problems);
  const values = {} as Record<SettingKey, AnyValue>;
  const source = {} as Record<SettingKey, SettingSource>;
  const rejected: Array<{ def: SettingDef; where: string; raw: unknown }> = [];

  for (const def of SETTING_DEFS) {
    const key = def.key;
    const forced = def.force?.(env);
    if (forced !== undefined) {
      values[key] = forced;
      source[key] = "default";
      continue;
    }
    // Highest first: the dashboard, the SETTINGS var, the legacy vars.
    const layers: Array<[SettingSource, string, unknown]> = [];
    if (stored.has(key)) layers.push(["dashboard", "saved value", parseStored(stored.get(key)!)]);
    if (Object.hasOwn(deploy, key)) layers.push(["deploy", "deploy config's value", deploy[key]]);
    const legacy = def.fromEnv?.(env);
    if (legacy !== undefined) layers.push(["deploy", "deploy config's value", legacy]);

    values[key] = def.default;
    source[key] = "default";
    for (const [layer, where, raw] of layers) {
      const value = coerce(def, raw);
      if (value === undefined) {
        rejected.push({ def, where, raw });
        continue;
      }
      values[key] = value;
      source[key] = layer;
      break;
    }
  }
  for (const { def, where, raw } of rejected) {
    problems.push(`${def.label}: the ${where} ${shown(raw)} isn't valid (expected ${expected(def)}), so ${displayValue(def, values[def.key])} is used.`);
  }
  return { values: values as unknown as SettingValues, source, problems };
}

const SELECT_ROWS = "SELECT key, value FROM settings";

/** Exactly one D1 query. */
export async function loadSettings(db: D1Database, env: Env): Promise<EffectiveSettings> {
  const { results } = await db.prepare(SELECT_ROWS).all<{ key: string; value: string }>();
  return resolveSettings(results, env);
}

function formError(def: SettingDef): string {
  if (def.type === "integer") return `Enter a whole number from ${def.min} to ${def.max}.`;
  if (def.type === "timeZone") return "Choose a time zone from the list.";
  return "Choose on or off.";
}

/**
 * Saves the settings form (encoding: the header comment). Only keys whose value changes are
 * written, and a value equal to what applies without a dashboard row deletes the row, so later
 * deploy-config or default changes still apply. Hidden or forced keys and unknown fields are
 * ignored. Turning on a `confirmOn` setting needs `confirmField(key)` = "yes". Nothing is saved
 * when any field is invalid. Logs the change to the activity log.
 */
export async function saveSettings(db: D1Database, env: Env, form: FormData): Promise<SaveSettingsResult> {
  const { results: rows } = await db.prepare(SELECT_ROWS).all<{ key: string; value: string }>();
  const current = resolveSettings(rows, env);
  // Without a row a key falls back to the deploy layer. A row is only dropped when that gives the
  // same value both now and once the legacy vars are removed (else removing them would change it).
  const lower = resolveSettings([], env).values;
  const lowerAfterLegacy = resolveSettings([], withoutLegacyVars(env)).values;
  const storedKeys = new Set(rows.map((r) => r.key));
  const resets = new Set(form.getAll("reset").map(String).filter(isSettingKey));

  const errors: Partial<Record<SettingKey, string>> = {};
  const writes = new Map<SettingKey, AnyValue | null>(); // null: delete the row
  for (const def of SETTING_DEFS) {
    const key = def.key;
    if (def.visible?.(env) === false || def.force?.(env) !== undefined) continue;
    if (resets.has(key)) {
      if (storedKeys.has(key)) writes.set(key, null);
      continue;
    }
    const posted = form.getAll(key);
    if (!posted.length) continue;
    const value = coerce(def, String(posted.at(-1))); // a checkbox's "true" follows its hidden "false"
    if (value === undefined) {
      errors[key] = formError(def);
      continue;
    }
    if (value === current.values[key]) continue;
    if (def.confirmOn && value === true && form.get(confirmField(key)) !== "yes") {
      errors[key] = `Confirm to turn this on: ${def.confirmOn}`;
      continue;
    }
    writes.set(key, value === lower[key] && value === lowerAfterLegacy[key] ? null : value);
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  if (!writes.size) return { ok: true, changed: [] };

  const statements = [...writes].map(([key, value]) =>
    value === null
      ? db.prepare("DELETE FROM settings WHERE key = ?1").bind(key)
      : db
          .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
          .bind(key, JSON.stringify(value)),
  );
  await db.batch(statements);

  const next = new Map(rows.map((r) => [r.key, r.value]));
  for (const [key, value] of writes) value === null ? next.delete(key) : next.set(key, JSON.stringify(value));
  const after = resolveSettings([...next].map(([key, value]) => ({ key, value })), env);
  const changed = SETTING_KEYS.filter((key) => after.values[key] !== current.values[key] || after.source[key] !== current.source[key]);
  if (changed.length) {
    const summary = `Settings changed: ${changed
      .map((key) => `${REGISTRY[key].label} ${displayValue(REGISTRY[key] as SettingDef, after.values[key])}${resets.has(key) ? " (reset)" : ""}`)
      .join("; ")}`;
    try {
      await logActivity(db, "settings", summary, true, summary.length > 200 ? summary : undefined);
    } catch (err) {
      // The settings are saved; a missing log line mustn't report the save as failed.
      console.error(JSON.stringify({ activityError: "settings", error: err instanceof Error ? err.message : String(err) }));
    }
  }
  return { ok: true, changed };
}
