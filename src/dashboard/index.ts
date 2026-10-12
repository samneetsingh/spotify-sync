// The owner dashboard: GET / (landing or home), GET /manage, GET/POST /settings, POST
// /settings/toggle, GET /activity and the POST /actions/*. Auth, import and 404s are handled
// elsewhere (src/index.ts routes in order: Origin check, auth, session, import, dashboard).
//
// renderPage (src/dashboard/layout.tsx) is shared with the auth and import pages. Escaping
// rule: arguments named `...Html`/`body` are trusted HTML, everything else is text and gets escaped.
// Classes only: the CSP blocks `style=` attributes.

import type { Session } from "../auth";
import type { Env } from "../env";
import { parseWriteMode } from "../env";
import { authRequired, redirect303, statusPage } from "../http";
import { importCard } from "../import";
import { emailConfig } from "../runtime";
import { isSettingKey, loadSettings, saveSettings, settingDef, type SettingKey } from "../settings";
import { activityBody, loadActivity } from "./activity";
import { fillArt } from "./art";
import { loadHome } from "./home-data";
import { HomeView } from "./home-view";
import { PREVIEW_COOLDOWN_MS, recreatePlaylist, sendPreview, syncNow } from "./actions";
import { renderLanding } from "./landing";
import { renderPage, type Notice } from "./layout";
import { manageBody } from "./manage";
import { render } from "./render";
import { settingsBody } from "./settings";
import { loadStatus } from "./status";

export { ago, localTime, renderPage, type ButtonVariant, type NavKey, type Notice, type PageOptions, type Tone } from "./layout";

/** Whether the import bindings exist (the Import nav item and card are hidden without them). */
export const importEnabled = (env: Env): boolean => !!(env.IMPORTS && env.IMPORT_WORKFLOW);

// ---------------------------------------------------------------------------- flash messages

/**
 * Fixed flash codes for `?ok=<code>` / `?error=<code>` after a redirect, so no user content ever
 * goes into a URL. Unknown codes are ignored. Other modules may redirect here with these codes.
 */
export const FLASH: { ok: Record<string, (env: Env) => string>; error: Record<string, (env: Env) => string> } = {
  ok: {
    synced: () => "Sync finished.",
    "preview-sent": (env) => `Preview sent to ${env.ALERT_EMAIL_TO ?? "your inbox"}. It can take a minute to arrive.`,
    "preview-logged": () => "Dry run: the preview was written to the Worker log instead of being sent.",
    saved: () => "Settings saved. They apply from the next run.",
    unchanged: () => "Nothing changed.",
    reset: () => "Setting reset.",
    recreate: () => "The playlist will be recreated at its next run.",
    "logged-out": () => "You're logged out.",
  },
  error: {
    "sync-busy": () => "A sync is already running. Try again in a minute or two.",
    "sync-failed": () => "The sync failed. The error is under Problems.",
    "email-off": () => "Email isn't set up for this dashboard, so previews can't be sent.",
    "preview-cooldown": () => `You asked for that preview a few minutes ago. You can ask again ${PREVIEW_COOLDOWN_MS / 60_000} minutes after the last one.`,
    "preview-empty-week": () => "There are no plays from last week to preview yet.",
    "preview-empty-month": () => "There are no plays from last month to preview yet.",
    "preview-failed": () => "The preview couldn't be sent. Check Activity for the error.",
    "toggle-refused": () => "That setting can't be switched from here. Change it in Settings.",
    "toggle-failed": () => "That setting couldn't be saved. Try again in Settings.",
  },
};

export function flashNotice(url: URL, env: Env): Notice | undefined {
  const ok = url.searchParams.get("ok");
  const error = url.searchParams.get("error");
  if (error && Object.hasOwn(FLASH.error, error)) return { kind: "error", text: FLASH.error[error]!(env) };
  if (ok && Object.hasOwn(FLASH.ok, ok)) return { kind: "ok", text: FLASH.ok[ok]!(env) };
  return undefined;
}

// ---------------------------------------------------------------------------- pages

/**
 * The owner's Home: one D1 batch (loadHome), then art for anything the cache lacks (at most two
 * Spotify calls, capped at 2.5 s; a warm view makes none).
 */
async function homePage(env: Env, ctx: ExecutionContext, session: Session, notice: Notice | undefined): Promise<Response> {
  const settings = await loadSettings(env.DB, env);
  const data = await fillArt(env, ctx, await loadHome(env.DB, { now: Date.now(), timeZone: settings.values.timeZone }));
  const body = render(HomeView({ data, settings: settings.values, aiAvailable: !!env.OPENAI_API_KEY, writeMode: parseWriteMode(env.WRITE_MODE) }));
  return renderPage({ title: "Home", session, nav: "home", layout: "wide", hideTitle: true, body, notice, importEnabled: importEnabled(env) });
}

async function managePage(env: Env, session: Session, url: URL): Promise<Response> {
  const db = env.DB;
  const [settings, status] = await Promise.all([loadSettings(db, env), loadStatus(db)]);
  const email = emailConfig(env, settings.values);
  let importHtml = "";
  if (importEnabled(env)) {
    try {
      importHtml = await importCard(db, settings.values.timeZone);
    } catch (err) {
      // The rest of the page still works without the import card.
      console.error(JSON.stringify({ dashboard: "import card failed", error: err instanceof Error ? err.message : String(err) }));
    }
  }
  const body = manageBody({
    session,
    status,
    values: settings.values,
    writeMode: parseWriteMode(env.WRITE_MODE),
    email: { configured: !!(email.binding && email.from && email.to), to: email.to ?? null },
    aiAvailable: !!env.OPENAI_API_KEY,
    importHtml,
  });
  return renderPage({ title: "Manage", session, nav: "manage", body, notice: flashNotice(url, env), importEnabled: importEnabled(env) });
}

async function settingsPage(env: Env, session: Session, url: URL): Promise<Response> {
  const settings = await loadSettings(env.DB, env);
  const body = settingsBody({ session, settings, env, welcome: url.searchParams.get("welcome") === "1" });
  return renderPage({ title: "Settings", session, nav: "settings", body, notice: flashNotice(url, env), importEnabled: importEnabled(env) });
}

/** POST /settings: saves through saveSettings; a refused save shows the form again with the errors. */
async function saveSettingsForm(request: Request, env: Env, session: Session): Promise<Response> {
  const form = await request.formData();
  const result = await saveSettings(env.DB, env, form);
  if (result.ok) return redirect303(`/settings?ok=${form.has("reset") ? "reset" : result.changed.length ? "saved" : "unchanged"}`);
  const settings = await loadSettings(env.DB, env);
  const body = settingsBody({ session, settings, env, submitted: form, errors: result.errors });
  return renderPage({ title: "Settings", session, nav: "settings", body, status: 400, importEnabled: importEnabled(env) });
}

/**
 * Settings the Home widget may switch with one POST /settings/toggle. Liked Songs only off: turning
 * it on needs the confirmation on /settings. Hidden or deploy-fixed settings (the AI editor without
 * OPENAI_API_KEY) are refused too.
 */
const TOGGLES = new Set<SettingKey>(["digestWeekly", "digestMonthly", "frequent", "onThisDay", "forgottenFavorites", "aiEditor", "liked"]);

/**
 * POST /settings/toggle (key, value=true|false): saves that one key through saveSettings (keys not
 * posted are untouched), then back to Home's settings widget.
 */
async function toggleSetting(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const key = String(form.get("key") ?? "");
  const value = form.get("value");
  if (key === "liked" && value === "true") return redirect303("/settings#s-liked");
  const def = isSettingKey(key) && TOGGLES.has(key) ? settingDef(key) : null;
  if (!def || (value !== "true" && value !== "false") || def.visible?.(env) === false || def.force?.(env) !== undefined) {
    return redirect303("/?error=toggle-refused");
  }
  const one = new FormData();
  one.set(def.key, value);
  const result = await saveSettings(env.DB, env, one);
  if (!result.ok) return redirect303("/?error=toggle-failed");
  return redirect303(`/?ok=${result.changed.length ? "saved" : "unchanged"}#settings`);
}

async function activityPage(env: Env, session: Session, url: URL): Promise<Response> {
  const [settings, data] = await Promise.all([loadSettings(env.DB, env), loadActivity(env.DB)]);
  return renderPage({ title: "Activity", session, nav: "activity", body: activityBody(data, settings.values.timeZone), notice: flashNotice(url, env), importEnabled: importEnabled(env) });
}

// ---------------------------------------------------------------------------- router

const PAGES = new Set(["/", "/manage", "/settings", "/activity"]);
const POSTS = new Set(["/settings", "/settings/toggle", "/actions/sync", "/actions/preview", "/actions/playlist/recreate"]);

/**
 * GET / (landing without a session, home with one), GET /manage, GET/POST /settings, POST
 * /settings/toggle, GET /activity and POST /actions/*; null for any other path. Owner pages without
 * a session: authRequired(request). The router has already checked Origin on non-GET requests.
 */
export async function handleDashboard(request: Request, env: Env, ctx: ExecutionContext, session: Session | null): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!PAGES.has(path) && !POSTS.has(path)) return null;
  const read = request.method === "GET" || request.method === "HEAD";

  if (path === "/" && read && !session) return renderLanding(env, env.DB, flashNotice(url, env));
  if (!session) return authRequired(request);

  if (read && PAGES.has(path)) {
    if (path === "/") return homePage(env, ctx, session, flashNotice(url, env));
    if (path === "/manage") return managePage(env, session, url);
    if (path === "/settings") return settingsPage(env, session, url);
    return activityPage(env, session, url);
  }
  if (request.method === "POST" && POSTS.has(path)) {
    if (path === "/settings") return saveSettingsForm(request, env, session);
    if (path === "/settings/toggle") return toggleSetting(request, env);
    if (path === "/actions/sync") return syncNow(env);
    const form = await request.formData();
    if (path === "/actions/preview") return sendPreview(form, env, await loadSettings(env.DB, env));
    return recreatePlaylist(form, env);
  }
  const res = statusPage(405, "Not allowed", "That page doesn't accept this kind of request.");
  res.headers.set("Allow", PAGES.has(path) && POSTS.has(path) ? "GET, HEAD, POST" : PAGES.has(path) ? "GET, HEAD" : "POST");
  return res;
}

/** The logged-out home page: "Log in with Spotify", "Almost ready" (unclaimed) or "still being set up". */
export async function landingPage(env: Env, db: D1Database, notice?: Notice): Promise<Response> {
  return renderLanding(env, db, notice);
}
