// The settings page: rendered from the registry, the form encoding saveSettings expects, the Liked
// Songs confirmation, errors, reset; and the round trip through saveSettings (WP-B) via the router.

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleDashboard } from "../../src/dashboard";
import { settingsBody, type SettingsView } from "../../src/dashboard/settings";
import { migrate } from "../../src/db/schema";
import { LIKED_SONGS_WARNING, SETTING_DEFS, SETTING_GROUPS } from "../../src/settings";
import { resetDb } from "../parity/spotify-fixture";
import { ctx, expectSafePage, get, ORIGIN, session, settingsReady, stubSettings, stubStatus, testEnv } from "./helpers";

beforeAll(() => migrate(env.DB));
beforeEach(() => resetDb(env.DB));

const XSS = `<script>alert("x")</script>`;
const render = (over: Partial<SettingsView> = {}) =>
  settingsBody({ session, settings: stubSettings(), env: testEnv(), status: stubStatus(), writeMode: "live", email: { configured: true, to: "you@example.com" }, ...over });

/**
 * The fields a browser would submit for the settings form in `html`, in tree order (checked boxes
 * only): controls inside the form without a `form` attribute, and controls anywhere with
 * form="settings" (General, after the save bar).
 */
function formFields(html: string): Array<[string, string]> {
  const start = html.indexOf('<form method="post" action="/settings" id="settings"');
  const end = html.indexOf("</form>", start);
  const out: Array<[string, string]> = [];
  for (const m of html.matchAll(/<input\b([^>]*)>|<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const attrs = m[1] ?? m[2]!;
    const attr = (name: string) => attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
    const name = attr("name");
    const owner = attr("form");
    const inside = m.index! > start && m.index! < end;
    if (!name || (owner ? owner !== "settings" : !inside)) continue;
    if (m[2] !== undefined) {
      out.push([name, m[3]!.match(/<option value="([^"]*)" selected="">/)![1]!]);
    } else if (attr("type") === "checkbox") {
      if (/\bchecked\b/.test(attrs)) out.push([name, attr("value")!]);
    } else {
      out.push([name, attr("value") ?? ""]);
    }
  }
  return out;
}

const postForm = (fields: Array<[string, string]>) =>
  new Request(`${ORIGIN}/settings`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });

describe("settings page rendering", () => {
  it("groups settings in registry order, one fieldset per group", () => {
    const html = render();
    const legends = [...html.matchAll(/<legend>([^<]+)<\/legend>/g)].map((m) => m[1]);
    expect(legends).toEqual([...SETTING_GROUPS]);
  });

  it("posts a hidden false before each checkbox's true, and labels every control", () => {
    const html = render();
    expect(html).toContain(
      `<input type="hidden" name="frequent" value="false"/><input class="toggle" type="checkbox" id="f-frequent" name="frequent" value="true" aria-describedby="d-frequent" checked=""/>`,
    );
    for (const id of html.matchAll(/<(?:input|select)[^>]*\bid="(f-[^"]+)"/g)) expect(html).toContain(`<label for="${id[1]}">`);
    const advanced = render({ settings: stubSettings({ advanced: true }) });
    expect(advanced).toMatch(/<select id="f-timeZone" name="timeZone"[^>]*><option value="UTC">UTC<\/option>/);
    expect(advanced).toContain(`<option value="America/Los_Angeles" selected="">America/Los Angeles</option>`);
    expect(html).toMatch(/<input type="number"[^>]*name="frequentMinPlays" value="5" min="2" max="100"/);
  });

  it("asks for the Liked Songs confirmation only when switching it on", () => {
    const off = render();
    expect(off).toContain(LIKED_SONGS_WARNING.replaceAll("'", "&#39;"));
    expect(off).toContain(`<input type="checkbox" name="confirm_liked" value="yes"/> I understand. Turn it on.`);
    expect(off).toMatch(/<div class="setting gated" id="s-liked">/);
    const on = render({ settings: stubSettings({ liked: true }) });
    expect(on).not.toContain("confirm_liked");
    expect(on).toMatch(/id="f-liked" name="liked" value="true"[^>]*checked/);
  });

  it("shows a refused save with the posted values, an alert summary and the field marked invalid", () => {
    const submitted = new FormData();
    submitted.append("liked", "false");
    submitted.append("liked", "true");
    submitted.append("frequentMinPlays", "500");
    const html = render({ submitted, errors: { liked: "Confirm to turn this on.", frequentMinPlays: "Use a number from 2 to 100." } });
    // A missing confirmation points at the box instead of repeating the whole warning.
    expect(html).toMatch(/<div class="notice notice-error" role="alert" id="errors">[^]*<a href="#f-liked">Add played songs to Liked Songs<\/a>: Tick “I understand” below to turn this on\./);
    expect(html).toContain(`<p class="field-error" id="e-liked">Tick “I understand” below to turn this on.</p>`);
    expect(html).toMatch(/id="f-liked" name="liked" value="true" aria-describedby="d-liked e-liked" checked="" aria-invalid="true"/);
    expect(html).toContain(`<div class="confirm invalid" id="c-liked">`);
    expect(html).toMatch(/name="frequentMinPlays" value="500"[^>]*aria-invalid="true"/);
    expect(html).toContain(`<p class="field-error" id="e-frequentMinPlays">Use a number from 2 to 100.</p>`);
    // The shown values are the posted ones, so the save bar stays visible (public/settings-form.js).
    expect(html).toContain(`<div class="savebar" id="savebar" data-always="">`);
    expect(render()).not.toContain("data-always");
  });

  it("tags each value's source and offers Reset for dashboard changes through its own form", () => {
    const html = render({ settings: stubSettings({ frequentMinPlays: 7, advanced: true }, { frequentMinPlays: "dashboard", timeZone: "deploy" }) });
    expect(html).toContain(`<div class="meta-row"><button type="submit" form="reset-frequentMinPlays"`); // Reset only, no "Changed here" label
    expect(html).not.toContain("Changed here");
    expect(html).toContain(`<form id="reset-frequentMinPlays" method="post" action="/settings" hidden=""><input type="hidden" name="reset" value="frequentMinPlays"/></form>`);
    expect(html).toContain(`<span class="source source-deploy">From deploy config</span>`);
    expect(html.match(/name="reset"/g)).toHaveLength(1);
  });

  it("hides the AI editor without an OpenAI key and lists problems and (Advanced) account actions", () => {
    expect(render()).not.toContain("f-aiEditor");
    expect(render({ env: testEnv({ OPENAI_API_KEY: "sk-test" }) })).toContain(`id="f-aiEditor"`);
    const html = render({ settings: stubSettings({ advanced: true }, {}, [`TIME_ZONE "Mars/Base" isn't a time zone <b>`]) });
    expect(html).toContain("Mars/Base");
    expect(html).not.toContain("<b>");
    expect(html).toMatch(/action="\/logout\/all"><button type="submit" class="btn btn-danger">Log out everywhere/);
    expect(html).toMatch(/action="\/logout"><button/);
  });

  it("shows problem alerts, the time zone and the account controls only with Advanced on, keeping their values", () => {
    const off = render({ settings: stubSettings({ alerts: false, timeZone: "Asia/Kolkata" }) });
    for (const id of ["s-alerts", "s-timeZone", "/logout/all"]) expect(off).not.toContain(id);
    expect(formFields(off).map(([k]) => k)).not.toEqual(expect.arrayContaining(["alerts", "timeZone"])); // not posted, so untouched
    expect(off).toContain(`id="f-advanced" name="advanced" value="true"`);
    const on = render({ settings: stubSettings({ alerts: false, timeZone: "Asia/Kolkata", advanced: true }) });
    for (const id of ["s-alerts", "s-timeZone", "/logout/all"]) expect(on).toContain(id);
    expect(on).toContain(`<option value="Asia/Kolkata" selected="">`);
  });
});

describe("settings page contract", () => {
  it("keeps every setting's ids and names (links such as /settings#s-liked rely on them)", () => {
    const e = testEnv({ OPENAI_API_KEY: "sk-test" });
    const html = render({ env: e, settings: stubSettings({ advanced: true }) });
    for (const def of SETTING_DEFS) {
      expect(html).toContain(`id="s-${def.key}"`);
      expect(html).toContain(`id="f-${def.key}" name="${def.key}"`);
      expect(html).toContain(`<p class="desc" id="d-${def.key}">`);
    }
    expect(html).toContain(`<form method="post" action="/settings" id="settings" class="dash dash-form">`);
  });

  it("escapes the account's display name and id", () => {
    const html = render({ session: { ...session, displayName: XSS, spotifyId: `id"><b>x` } });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>x");
    expect(html).toContain("&lt;script&gt;");
  });


  it("puts the rarer cards after the settings (General, Spotify, Account with the History import as built), then the save bar", () => {
    const html = render({ importHtml: `<div class="card-part" id="import"><b>trusted</b></div>`, settings: stubSettings({ advanced: true }) });
    expect(html.indexOf(`</form>`)).toBeLessThan(html.indexOf(`<fieldset class="group-general">`));
    expect(html.indexOf(`<fieldset class="group-general">`)).toBeLessThan(html.indexOf(`id="spotify"`));
    // General's controls still belong to the settings form.
    expect(html).toContain(`<input type="hidden" name="advanced" value="false" form="settings"/>`);
    expect(html).toMatch(/<select id="f-timeZone" name="timeZone" form="settings"/);
    expect(formFields(html).map(([k]) => k)).toEqual(expect.arrayContaining(["advanced", "timeZone"]));
    expect(html.indexOf(`id="spotify"`)).toBeLessThan(html.indexOf(`id="account"`));
    expect(html.indexOf(`id="account"`)).toBeLessThan(html.indexOf(`id="import"`));
    expect(html.indexOf(`id="import"`)).toBeLessThan(html.indexOf(`id="sign-in"`));
    expect(html.indexOf(`id="sign-in"`)).toBeLessThan(html.indexOf(`id="savebar"`));
    expect(html).toContain(`<div class="savebar" id="savebar"><button type="submit" form="settings" class="btn btn-primary">Save changes</button>`);
    expect(html).toContain("<b>trusted</b>");
    expect(render()).not.toContain(`id="import"`);
  });

  it("always shows the Account card with Log out (the dashboard's only one), the History import when set up, the rest of sign-in with Advanced", () => {
    const importHtml = `<div class="card-part" id="import">import</div>`;
    const plain = render();
    expect(plain).toContain(`<section class="card" id="account" aria-labelledby="account-title"><div class="card-head"><h2 id="account-title">Account</h2></div><div class="card-part" id="sign-in">`);
    expect(plain).toContain(`<div class="actions"><form class="inline" method="post" action="/logout"><button type="submit" class="btn btn-secondary">Log out</button></form></div>`);
    expect(plain).not.toContain(`id="import"`);
    const withImport = render({ importHtml });
    expect(withImport.indexOf(`id="import"`)).toBeLessThan(withImport.indexOf(`id="sign-in"`));
    const advanced = render({ settings: stubSettings({ advanced: true }) });
    expect(advanced).toContain(`href="/login?next=%2Fsettings"`);
    expect(advanced).toContain(`action="/logout/all"`);
  });
});

describe("settings page through the router: the History import card", () => {
  it("shows it with the import bindings and leaves it off without them", async () => {
    const page = async (environment: ReturnType<typeof testEnv>) => (await handleDashboard(get("/settings"), environment, ctx, session))!.text();
    const withImport = await page(testEnv());
    expect(withImport).toContain(`<div class="card-part" id="import"><div class="part-head"><h3>History import</h3>`);
    expect(withImport).toContain(`<script type="module" src="/settings-form.js"></script>`);
    expect(withImport).toContain(`href="/import"`);
    expect(withImport).not.toContain(`<a href="/import"`); // no nav item: the card is the way in
    expect(await page(testEnv({ IMPORTS: undefined }))).not.toContain(`id="import"`);
  });
});

describe.skipIf(!settingsReady)("[integration: WP-B saveSettings] settings round trip through the router", () => {
  const e = () => testEnv({ SETTINGS: "{}" });
  const page = async () => {
    const res = (await handleDashboard(get("/settings"), e(), ctx, session))!;
    expect(res.status).toBe(200);
    return expectSafePage(res);
  };
  const row = (key: string) => env.DB.prepare("SELECT value FROM settings WHERE key = ?1").bind(key).first<{ value: string }>();

  it("saves a change posted by the rendered form, then shows it as changed here", async () => {
    const fields = formFields(await page()).map(([k, v]): [string, string] => (k === "frequentMinPlays" ? [k, "7"] : [k, v]));
    const res = (await handleDashboard(postForm(fields), e(), ctx, session))!;
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/settings?ok=saved");
    expect(JSON.parse((await row("frequentMinPlays"))!.value)).toBe(7);
    const after = await page();
    expect(after).toMatch(/name="frequentMinPlays" value="7"/);
    expect(after).toContain(`form="reset-frequentMinPlays"`);
  });

  it("saves General (after the save bar, form=settings) with the rest of the form", async () => {
    const fields = formFields(await page()).flatMap((f): Array<[string, string]> => (f[0] === "advanced" ? [f, ["advanced", "true"]] : [f]));
    const res = (await handleDashboard(postForm(fields), e(), ctx, session))!;
    expect(res.headers.get("Location")).toBe("/settings?ok=saved");
    expect(JSON.parse((await row("advanced"))!.value)).toBe(true);
    expect(await page()).toContain(`id="f-timeZone"`);
  });

  it("posting the form unchanged stores nothing", async () => {
    const res = (await handleDashboard(postForm(formFields(await page())), e(), ctx, session))!;
    expect(res.headers.get("Location")).toBe("/settings?ok=unchanged");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM settings").first<{ n: number }>())!.n).toBe(0);
  });

  it("refuses to turn on Liked Songs without the confirmation, and saves it with one", async () => {
    const base = formFields(await page());
    const withLiked = base.flatMap((f): Array<[string, string]> => (f[0] === "liked" ? [f, ["liked", "true"]] : [f]));
    const refused = (await handleDashboard(postForm(withLiked), e(), ctx, session))!;
    expect(refused.status).toBe(400);
    const html = await expectSafePage(refused);
    expect(html).toContain('role="alert"');
    expect(html).toContain(`<div class="confirm invalid" id="c-liked">`);
    expect(await row("liked")).toBeNull();

    const confirmed = (await handleDashboard(postForm([...withLiked, ["confirm_liked", "yes"]]), e(), ctx, session))!;
    expect(confirmed.status).toBe(303);
    expect(JSON.parse((await row("liked"))!.value)).toBe(true);
  });

  it("resets one key back to the lower layer", async () => {
    const fields = formFields(await page()).map(([k, v]): [string, string] => (k === "frequentMinPlays" ? [k, "9"] : [k, v]));
    await handleDashboard(postForm(fields), e(), ctx, session);
    const res = (await handleDashboard(postForm([["reset", "frequentMinPlays"]]), e(), ctx, session))!;
    expect(res.headers.get("Location")).toBe("/settings?ok=reset");
    expect(await row("frequentMinPlays")).toBeNull();
    expect(await page()).toMatch(/name="frequentMinPlays" value="5"/);
  });
});
