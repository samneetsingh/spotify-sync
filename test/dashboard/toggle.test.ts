// POST /settings/toggle: Home's one-key settings switches. Only allowlisted keys, Liked Songs only
// off (on goes to the confirmation on /settings), the AI editor only with OPENAI_API_KEY; a valid
// toggle saves just that key. Also: owner pages refuse a session that isn't the owner's.

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSession } from "../../src/auth/session";
import { handleDashboard } from "../../src/dashboard";
import { migrate } from "../../src/db/schema";
import worker from "../../src/index";
import { resetDb } from "../parity/spotify-fixture";
import { ctx, get, ORIGIN, post, session, settingsReady, testEnv } from "./helpers";

beforeAll(() => migrate(env.DB));
beforeEach(() => resetDb(env.DB));

const e = (over = {}) => testEnv({ SETTINGS: "{}", ...over });
const toggle = (fields: Record<string, string>, environment = e()) => handleDashboard(post("/settings/toggle", fields), environment, ctx, session).then((r) => r!);
const rows = async () =>
  Object.fromEntries((await env.DB.prepare("SELECT key, value FROM settings ORDER BY key").all<{ key: string; value: string }>()).results.map((r) => [r.key, JSON.parse(r.value)]));

describe.skipIf(!settingsReady)("[integration: WP-B saveSettings] POST /settings/toggle", () => {
  it.each(["digestWeekly", "digestMonthly", "frequent", "onThisDay", "forgottenFavorites"])("switches %s off and on again, saving only that key", async (key) => {
    // Defaults are on, so off stores a row and on again deletes it (back to the default).
    const off = await toggle({ key, value: "false" });
    expect(off.status).toBe(303);
    expect(off.headers.get("Location")).toBe("/?ok=saved#settings");
    expect(await rows()).toEqual({ [key]: false });
    const on = await toggle({ key, value: "true" });
    expect(on.headers.get("Location")).toBe("/?ok=saved#settings");
    expect(await rows()).toEqual({});
  });

  it("logs the change like the settings form", async () => {
    await toggle({ key: "digestWeekly", value: "false" });
    const event = await env.DB.prepare("SELECT kind, summary FROM activity ORDER BY id DESC LIMIT 1").first<{ kind: string; summary: string }>();
    expect(event).toEqual({ kind: "settings", summary: "Settings changed: Weekly digest off" });
  });

  it("ignores other fields in the request", async () => {
    await toggle({ key: "frequent", value: "false", digestWeekly: "false", liked: "true", confirm_liked: "yes", reset: "timeZone" });
    expect(await rows()).toEqual({ frequent: false });
  });

  it("switches Liked Songs off", async () => {
    await env.DB.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('liked', 'true', datetime('now'))`).run();
    const res = await toggle({ key: "liked", value: "false" });
    expect(res.headers.get("Location")).toBe("/?ok=saved#settings");
    expect(await rows()).toEqual({});
  });

  it("sends Liked Songs on to the confirmation in Settings without saving, even with a confirmation posted", async () => {
    const res = await toggle({ key: "liked", value: "true", confirm_liked: "yes" });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/settings#s-liked");
    expect(await rows()).toEqual({});
  });

  it.each([
    ["an unknown key", { key: "nope", value: "false" }],
    ["a key that isn't on the allowlist", { key: "timeZone", value: "UTC" }],
    ["a boolean that isn't on the allowlist", { key: "alerts", value: "false" }],
    ["a missing key", { value: "false" }],
    ["a missing value", { key: "frequent" }],
    ["a value that isn't true or false", { key: "frequent", value: "yes" }],
    ["a prototype key", { key: "__proto__", value: "false" }],
  ])("refuses %s and saves nothing", async (_, fields) => {
    const res = await toggle(fields as Record<string, string>);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/?error=toggle-refused");
    expect(await rows()).toEqual({});
  });

  it("refuses the AI editor without OPENAI_API_KEY, and switches it with one", async () => {
    const refused = await toggle({ key: "aiEditor", value: "true" });
    expect(refused.headers.get("Location")).toBe("/?error=toggle-refused");
    expect(await rows()).toEqual({});
    const saved = await toggle({ key: "aiEditor", value: "true" }, e({ OPENAI_API_KEY: "sk-test" }));
    expect(saved.headers.get("Location")).toBe("/?ok=saved#settings");
    expect(await rows()).toEqual({ aiEditor: true });
  });

  it("shows the fixed flash texts on Home", async () => {
    for (const [query, text] of [
      ["ok=saved", "Settings saved."],
      ["error=toggle-refused", "That setting can&#39;t be switched from here."],
      ["error=toggle-failed", "That setting couldn&#39;t be saved."],
    ]) {
      expect(await (await handleDashboard(get(`/?${query}`), e(), ctx, session))!.text()).toContain(text);
    }
  });
});

describe("owner-only routes", () => {
  it("refuse a toggle without a session (401) and from GET (405), changing nothing", async () => {
    const res = (await handleDashboard(post("/settings/toggle", { key: "frequent", value: "false" }), e(), ctx, null))!;
    expect(res.status).toBe(401);
    const viaGet = (await handleDashboard(get("/settings/toggle?key=frequent&value=false"), e(), ctx, session))!;
    expect(viaGet.status).toBe(405);
    expect(await rows()).toEqual({});
  });

  it("treat a session of an account that isn't the owner as no session", async () => {
    await env.DB.prepare("INSERT INTO state(key, value) VALUES('owner:spotify_id', 'owner-1')").run();
    const environment = e({ SPOTIFY_USER_ID: "" });
    const cookie = (await createSession(env.DB, environment, "someone-else", null)).split(";")[0]!;
    const fetch = (request: Request) => worker.fetch(request, environment, ctx);

    const page = await fetch(new Request(`${ORIGIN}/manage`, { headers: { Cookie: cookie } }));
    expect(page.status).toBe(303);
    expect(page.headers.get("Location")).toBe(`/login?next=${encodeURIComponent("/manage")}`);

    const write = post("/settings/toggle", { key: "frequent", value: "false" });
    write.headers.set("Cookie", cookie);
    expect((await fetch(write)).status).toBe(401);
    expect(await rows()).toEqual({});
  });

  it("refuse a toggle from another origin before the dashboard sees it", async () => {
    const cookie = (await createSession(env.DB, e({ SPOTIFY_USER_ID: "owner-1" }), "owner-1", null)).split(";")[0]!;
    const res = await worker.fetch(
      new Request(`${ORIGIN}/settings/toggle`, {
        method: "POST",
        headers: { Origin: "https://evil.test", Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: "key=frequent&value=false",
      }),
      e({ SPOTIFY_USER_ID: "owner-1" }),
      ctx,
    );
    expect(res.status).toBe(403);
    expect(await rows()).toEqual({});
  });
});
