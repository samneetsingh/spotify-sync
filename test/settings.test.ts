import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recentActivity } from "../src/activity";
import { countingD1 } from "../src/db/counting";
import { migrate } from "../src/db/schema";
import type { Env } from "../src/env";
import {
  LIKED_SONGS_WARNING,
  SETTING_DEFS,
  validTimeZone,
  confirmField,
  hasLegacyVars,
  loadSettings,
  resolveSettings,
  saveSettings,
  withoutLegacyVars,
  type SettingKey,
} from "../src/settings";
import { resetDb } from "./parity/spotify-fixture";

/** An env with only what settings read: no SETTINGS, legacy vars or OpenAI key unless given. */
const bare = (overrides: Partial<Env> = {}): Env => ({ WRITE_MODE: "live", SETTINGS: undefined, OPENAI_API_KEY: "", ...overrides }) as Env;
const row = (key: string, value: unknown) => ({ key, value: JSON.stringify(value) });

describe("resolveSettings", () => {
  it("starts new owners with everything on except Liked Songs and Hindi Favorites (AI needs a key)", () => {
    const { values, source, problems } = resolveSettings([], bare());
    expect(values).toEqual({
      liked: false,
      frequent: true,
      frequentMinPlays: 5,
      artistPlaylists: true,
      hindiFavorites: false,
      onThisDay: true,
      forgottenFavorites: true,
      holiday: true,
      alerts: true,
      digestWeekly: true,
      digestMonthly: true,
      aiEditor: false,
      timeZone: "UTC",
    });
    expect(new Set(Object.values(source))).toEqual(new Set(["default"]));
    expect(problems).toEqual([]);
  });

  it("layers: a dashboard row, then the SETTINGS var, then legacy vars, then the default", () => {
    const e = bare({ SETTINGS: '{"timeZone":"Europe/Berlin","digestWeekly":false}', TIME_ZONE: "Asia/Tokyo", FREQUENT_MIN_PLAYS: "9" });
    const s = resolveSettings([row("timeZone", "America/Los_Angeles")], e);
    expect(s.values).toMatchObject({ timeZone: "America/Los_Angeles", digestWeekly: false, frequentMinPlays: 9, holiday: true });
    expect(s.source).toMatchObject({ timeZone: "dashboard", digestWeekly: "deploy", frequentMinPlays: "deploy", holiday: "default" });
    // Without the row, SETTINGS beats the legacy TIME_ZONE var.
    expect(resolveSettings([], e).values.timeZone).toBe("Europe/Berlin");
    expect(resolveSettings([], bare({ TIME_ZONE: "Asia/Tokyo" })).values.timeZone).toBe("Asia/Tokyo");
  });

  it("reads the legacy vars the way the old Worker did", () => {
    const s = resolveSettings([], bare({ AI_EDITOR: "on", OPENAI_API_KEY: "k", SPOTIFY_HINDI_FAVORITES_PLAYLIST_ID: "h1" }));
    expect(s.values).toMatchObject({ aiEditor: true, hindiFavorites: true });
    expect(resolveSettings([], bare({ AI_EDITOR: "off", OPENAI_API_KEY: "k", SPOTIFY_HINDI_FAVORITES_PLAYLIST_ID: "" })).values).toMatchObject({
      aiEditor: false,
      hindiFavorites: false,
    });
  });

  it("never throws: invalid values fall through to the next layer and are listed as problems", () => {
    const e = bare({ SETTINGS: '{"frequentMinPlays":500,"holiday":"maybe","nope":1}', TIME_ZONE: "Not/A_Zone" });
    const s = resolveSettings([{ key: "frequentMinPlays", value: "1" }, { key: "timeZone", value: "{bad json" }, row("unknown", true)], e);
    expect(s.values).toMatchObject({ frequentMinPlays: 5, holiday: true, timeZone: "UTC" });
    expect(s.source).toMatchObject({ frequentMinPlays: "default", holiday: "default", timeZone: "default" });
    expect(s.problems).toEqual([
      "The deploy config's settings have names that don't exist, which are ignored: nope.",
      "Plays to join Frequent Plays: the saved value 1 isn't valid (expected a whole number from 2 to 100), so 5 is used.",
      "Plays to join Frequent Plays: the deploy config's value 500 isn't valid (expected a whole number from 2 to 100), so 5 is used.",
      "Holiday Favorites: the deploy config's value \"maybe\" isn't valid (expected on or off), so on is used.",
      "Time zone: the saved value \"{bad json\" isn't valid (expected a time zone such as America/Los_Angeles), so UTC is used.",
      "Time zone: the deploy config's value \"Not/A_Zone\" isn't valid (expected a time zone such as America/Los_Angeles), so UTC is used.",
    ]);
    expect(resolveSettings([], bare({ SETTINGS: "{oops" })).problems).toEqual(["The deploy config's settings aren't valid JSON, so they're ignored."]);
    expect(resolveSettings([], bare({ SETTINGS: "[1]" })).problems).toEqual([
      "The deploy config's settings must be an object of setting names and values, so they're ignored.",
    ]);
  });

  it("accepts text forms of values (form fields, vars); time zones stay as given", () => {
    const s = resolveSettings([], bare({ SETTINGS: '{"liked":"on","holiday":"false","frequentMinPlays":" 12 ","timeZone":" Asia/Kolkata "}' }));
    expect(s.values).toMatchObject({ liked: true, holiday: false, frequentMinPlays: 12, timeZone: "Asia/Kolkata" });
    expect(validTimeZone("UTC")).toBe("UTC");
    expect(validTimeZone("")).toBeUndefined();
    expect(validTimeZone("Mars/Base")).toBeUndefined();
  });

  it("forces the AI editor off without an OpenAI key, whatever is saved, and only shows it with one", () => {
    const def = SETTING_DEFS.find((d) => d.key === "aiEditor")!;
    expect(resolveSettings([row("aiEditor", true)], bare()).values.aiEditor).toBe(false);
    expect(def.visible!(bare())).toBe(false);
    const withKey = bare({ OPENAI_API_KEY: "sk-test" });
    expect(resolveSettings([row("aiEditor", true)], withKey)).toMatchObject({ values: { aiEditor: true }, source: { aiEditor: "dashboard" } });
    expect(def.visible!(withKey)).toBe(true);
  });

  it("knows which deploy vars are legacy", () => {
    expect(hasLegacyVars(bare())).toBe(false);
    expect(hasLegacyVars(bare({ SPOTIFY_FREQUENT_PLAYLIST_ID: "" }))).toBe(true); // older templates rendered empty ones
    const e = bare({ TIME_ZONE: "Asia/Tokyo", SPOTIFY_USER_ID: "me", SETTINGS: "{}" });
    expect(withoutLegacyVars(e)).toEqual(bare({ SETTINGS: "{}" }));
    expect(e.TIME_ZONE).toBe("Asia/Tokyo"); // not mutated
  });
});

describe("loadSettings and saveSettings", () => {
  beforeAll(() => migrate(env.DB));
  beforeEach(() => resetDb(env.DB));

  const testEnv = (overrides: Partial<Env> = {}) => ({ ...(env as unknown as Env), SETTINGS: "{}", OPENAI_API_KEY: "", ...overrides }) as Env;
  /** A settings form: booleans post a hidden "false" then (when ticked) "true", like the page. */
  function form(fields: Partial<Record<SettingKey | `confirm_${string}` | "reset", string | boolean | number>>): FormData {
    const f = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value === "boolean") {
        f.append(key, "false");
        if (value) f.append(key, "true");
      } else f.append(key, String(value));
    }
    return f;
  }
  const rows = async () =>
    (await env.DB.prepare("SELECT key, value FROM settings ORDER BY key").all<{ key: string; value: string }>()).results.map((r) => [r.key, r.value]);

  it("loads with exactly one query", async () => {
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('holiday', 'false')").run();
    const { db, queries } = countingD1(env.DB);
    const s = await loadSettings(db, testEnv());
    expect(queries()).toBe(1);
    expect(s.values.holiday).toBe(false);
    expect(s.source.holiday).toBe("dashboard");
  });

  it("stores only overrides: a value back at the default deletes its row", async () => {
    const e = testEnv();
    expect(await saveSettings(env.DB, e, form({ holiday: false, frequentMinPlays: "8", timeZone: "Europe/Paris", digestWeekly: true }))).toEqual({
      ok: true,
      changed: ["frequentMinPlays", "holiday", "timeZone"],
    });
    expect(await rows()).toEqual([["frequentMinPlays", "8"], ["holiday", "false"], ["timeZone", '"Europe/Paris"']]);

    expect(await saveSettings(env.DB, e, form({ holiday: true, frequentMinPlays: "8" }))).toEqual({ ok: true, changed: ["holiday"] });
    expect(await rows()).toEqual([["frequentMinPlays", "8"], ["timeZone", '"Europe/Paris"']]);
    // Resubmitting what's there changes nothing and logs nothing.
    const before = (await recentActivity(env.DB)).length;
    expect(await saveSettings(env.DB, e, form({ holiday: true, frequentMinPlays: "8", timeZone: "Europe/Paris" }))).toEqual({ ok: true, changed: [] });
    expect((await recentActivity(env.DB)).length).toBe(before);
  });

  it("logs each change to the activity log", async () => {
    await saveSettings(env.DB, testEnv(), form({ digestMonthly: false, timeZone: "Asia/Kolkata" }));
    const [event] = await recentActivity(env.DB, 1);
    expect(event).toMatchObject({ kind: "settings", ok: true, summary: "Settings changed: Monthly recap off; Time zone Asia/Kolkata" });
  });

  it("resets a key to the deploy config", async () => {
    const e = testEnv({ SETTINGS: '{"frequentMinPlays":3}' });
    await saveSettings(env.DB, e, form({ frequentMinPlays: "10", holiday: false }));
    expect(await saveSettings(env.DB, e, form({ reset: "frequentMinPlays", frequentMinPlays: "10", holiday: false }))).toEqual({ ok: true, changed: ["frequentMinPlays"] });
    expect(await rows()).toEqual([["holiday", "false"]]);
    const s = await loadSettings(env.DB, e);
    expect(s.values.frequentMinPlays).toBe(3);
    expect(s.source.frequentMinPlays).toBe("deploy");
    expect((await recentActivity(env.DB, 1))[0]!.summary).toBe("Settings changed: Plays to join Frequent Plays 3 (reset)");
  });

  it("needs the confirmation to turn Liked Songs on, but not to keep it on or turn it off", async () => {
    const e = testEnv();
    const refused = await saveSettings(env.DB, e, form({ liked: true }));
    expect(refused).toEqual({ ok: false, errors: { liked: `Confirm to turn this on: ${LIKED_SONGS_WARNING}` } });
    expect(await saveSettings(env.DB, e, form({ liked: true, [confirmField("liked")]: "no" }))).toMatchObject({ ok: false });
    expect(await rows()).toEqual([]);

    expect(await saveSettings(env.DB, e, form({ liked: true, confirm_liked: "yes" }))).toEqual({ ok: true, changed: ["liked"] });
    expect(await saveSettings(env.DB, e, form({ liked: true, holiday: false }))).toEqual({ ok: true, changed: ["holiday"] });
    expect(await saveSettings(env.DB, e, form({ liked: false }))).toEqual({ ok: true, changed: ["liked"] });
    expect(await rows()).toEqual([["holiday", "false"]]);
  });

  it("refuses the whole form when a field is invalid", async () => {
    const result = await saveSettings(env.DB, testEnv(), form({ holiday: false, frequentMinPlays: "1", timeZone: "Mars/Base" }));
    expect(result).toEqual({
      ok: false,
      errors: { frequentMinPlays: "Enter a whole number from 2 to 100.", timeZone: "Choose a time zone from the list." },
    });
    expect(await rows()).toEqual([]);
  });

  it("ignores unknown fields and settings the owner can't see", async () => {
    const f = form({ holiday: false, aiEditor: true });
    f.append("bogus", "1");
    f.append("reset", "bogus");
    expect(await saveSettings(env.DB, testEnv(), f)).toEqual({ ok: true, changed: ["holiday"] });
    expect(await rows()).toEqual([["holiday", "false"]]);
    // With a key the AI editor is shown, so it can be saved.
    expect(await saveSettings(env.DB, testEnv({ OPENAI_API_KEY: "sk-test" }), form({ aiEditor: true }))).toEqual({ ok: true, changed: ["aiEditor"] });
  });

  it("keeps a row equal to a legacy var, so removing the var later changes nothing", async () => {
    const e = testEnv({ TIME_ZONE: "America/Los_Angeles" });
    await saveSettings(env.DB, e, form({ timeZone: "Europe/Paris" }));
    await saveSettings(env.DB, e, form({ timeZone: "America/Los_Angeles" }));
    expect(await rows()).toEqual([["timeZone", '"America/Los_Angeles"']]);
    expect((await loadSettings(env.DB, testEnv())).values.timeZone).toBe("America/Los_Angeles");
  });
});
