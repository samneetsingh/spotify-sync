// The settings page: rendered from the registry, the form encoding saveSettings expects, the Liked
// Songs confirmation, errors, reset; and the round trip through saveSettings (WP-B) via the router.

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleDashboard } from "../../src/dashboard";
import { settingsBody, type SettingsView } from "../../src/dashboard/settings";
import { migrate } from "../../src/db/schema";
import { LIKED_SONGS_WARNING, SETTING_DEFS, SETTING_GROUPS } from "../../src/settings";
import { resetDb } from "../parity/spotify-fixture";
import { ctx, expectSafePage, get, ORIGIN, session, settingsReady, stubSettings, testEnv } from "./helpers";

beforeAll(() => migrate(env.DB));
beforeEach(() => resetDb(env.DB));

const XSS = `<script>alert("x")</script>`;
const render = (over: Partial<SettingsView> = {}) => settingsBody({ session, settings: stubSettings(), env: testEnv(), ...over });

/** The fields a browser would submit for the settings form in `html` (DOM order; checked boxes only). */
function formFields(html: string): Array<[string, string]> {
  const form = html.slice(html.indexOf('<form method="post" action="/settings" id="settings">'), html.indexOf("</form>", html.indexOf('id="settings"')));
  const out: Array<[string, string]> = [];
  for (const m of form.matchAll(/<input\b([^>]*)>|<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const attrs = m[1] ?? m[2]!;
    const attr = (name: string) => attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
    const name = attr("name");
    if (!name || /\bform="/.test(attrs)) continue;
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
    expect(html).toMatch(/<select id="f-timeZone" name="timeZone"[^>]*><option value="UTC">UTC<\/option>/);
    expect(html).toContain(`<option value="America/Los_Angeles" selected="">America/Los Angeles</option>`);
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
  });

  it("tags each value's source and offers Reset for dashboard changes through its own form", () => {
    const html = render({ settings: stubSettings({ frequentMinPlays: 7 }, { frequentMinPlays: "dashboard", timeZone: "deploy" }) });
    expect(html).toContain(`<span class="source source-dashboard">Changed here</span><button type="submit" form="reset-frequentMinPlays"`);
    expect(html).toContain(`<form id="reset-frequentMinPlays" method="post" action="/settings" hidden=""><input type="hidden" name="reset" value="frequentMinPlays"/></form>`);
    expect(html).toContain(`<span class="source source-deploy">From deploy config</span>`);
    expect(html.match(/name="reset"/g)).toHaveLength(1);
  });

  it("hides the AI editor without an OpenAI key and lists problems, the welcome banner and account actions", () => {
    expect(render()).not.toContain("f-aiEditor");
    expect(render({ env: testEnv({ OPENAI_API_KEY: "sk-test" }) })).toContain(`id="f-aiEditor"`);
    const html = render({ welcome: true, settings: stubSettings({}, {}, [`TIME_ZONE "Mars/Base" isn't a time zone <b>`]) });
    expect(html).toContain("Your first sync runs within 10 minutes");
    expect(html).toContain("Mars/Base");
    expect(html).not.toContain("<b>");
    expect(html).toMatch(/action="\/logout\/all"><button type="submit" class="btn btn-danger">Log out everywhere/);
    expect(html).toMatch(/action="\/logout"><button/);
  });
});

describe("settings page contract", () => {
  it("keeps every setting's ids and names (links such as /settings#s-liked rely on them)", () => {
    const e = testEnv({ OPENAI_API_KEY: "sk-test" });
    const html = render({ env: e });
    for (const def of SETTING_DEFS) {
      expect(html).toContain(`id="s-${def.key}"`);
      expect(html).toContain(`id="f-${def.key}" name="${def.key}"`);
      expect(html).toContain(`<p class="desc" id="d-${def.key}">`);
    }
    expect(html).toContain(`<form method="post" action="/settings" id="settings">`);
  });

  it("escapes the account's display name and id", () => {
    const html = render({ session: { ...session, displayName: XSS, spotifyId: `id"><b>x` } });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>x");
    expect(html).toContain("&lt;script&gt;");
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
