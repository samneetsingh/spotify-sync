// The guided tour's server side: Home carries #tour-data (auto=1 until the owner finishes or skips
// it) and the script; Settings carries it too (auto=0) with "Take the tour again"; GET /welcome
// replays it; POST /welcome/done marks it done (then Home, or the import). Owner only. The script's
// pure parts (steps, card placement) are tested against public/tour.js directly.

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleDashboard } from "../../src/dashboard";
import { getState, setState } from "../../src/db/state";
import { migrate } from "../../src/db/schema";
import { resetDb } from "../parity/spotify-fixture";
import { ctx, get, post, session, settingsReady, testEnv } from "./helpers";
// @ts-expect-error plain JS module (served as-is from public/) without type declarations
import { place, STEPS } from "../../public/tour.js";

beforeAll(() => migrate(env.DB));
beforeEach(() => resetDb(env.DB));

const XSS = `<script>alert("x")</script>`;
const e = (over = {}) => testEnv({ SETTINGS: "{}", ...over });
const html = async (path: string, s = session) => (await handleDashboard(get(path), e(), ctx, s))!.text();

describe.skipIf(!settingsReady)("tour on the pages", () => {
  it("starts on Home until it's done: #tour-data says auto=1, then auto=0", async () => {
    const before = await html("/");
    expect(before).toContain(`<div id="tour-data" data-auto="1" data-name="Sam" hidden=""></div>`);
    expect(before).toContain(`<script type="module" src="/tour.js"></script>`);
    await setState(env.DB, "onboarding:done", "2026-10-12T00:00:00.000Z");
    expect(await html("/")).toContain(`<div id="tour-data" data-auto="0"`);
  });

  it("carries on in Settings (never starting there on its own) and offers it again", async () => {
    const page = await html("/settings");
    expect(page).toContain(`<div id="tour-data" data-auto="0" data-name="Sam" hidden=""></div>`);
    expect(page).toContain(`<script type="module" src="/settings-form.js"></script><script type="module" src="/tour.js"></script>`);
    expect(page).toContain(`<a href="/?tour=0">Take the tour again</a>`);
  });

  it("escapes the owner's name in the data attribute", async () => {
    const page = await html("/", { ...session, displayName: XSS });
    expect(page).not.toContain("<script>alert");
    expect(page).toContain(`data-name="&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"`);
  });
});

describe("tour routes", () => {
  it("GET /welcome replays it from the start", async () => {
    const res = (await handleDashboard(get("/welcome"), e(), ctx, session))!;
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/?tour=0");
  });

  it("POST /welcome/done marks it done and goes Home, or to the import when that's set up", async () => {
    expect(await getState(env.DB, "onboarding:done")).toBeNull();
    const home = (await handleDashboard(post("/welcome/done", { then: "home" }), e(), ctx, session))!;
    expect(home.status).toBe(303);
    expect(home.headers.get("Location")).toBe("/");
    expect(await getState(env.DB, "onboarding:done")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((await handleDashboard(post("/welcome/done", { then: "import" }), e(), ctx, session))!.headers.get("Location")).toBe("/import");
    expect((await handleDashboard(post("/welcome/done", { then: "import" }), e({ IMPORTS: undefined }), ctx, session))!.headers.get("Location")).toBe("/");
  });

  it("needs the owner's session, and the old step pages are gone", async () => {
    const page = (await handleDashboard(get("/welcome"), e(), ctx, null))!;
    expect(page.status).toBe(303);
    expect(page.headers.get("Location")).toBe("/login?next=%2Fwelcome");
    expect((await handleDashboard(post("/welcome/done", { then: "home" }), e(), ctx, null))!.status).toBe(401);
    expect(await getState(env.DB, "onboarding:done")).toBeNull();
    expect(await handleDashboard(post("/welcome/choices", { digestWeekly: "false" }), e(), ctx, session)).toBeNull();
  });
});

describe("public/tour.js", () => {
  it("walks Home, then Settings, then ends back on Home on a step without a spotlight", () => {
    const pages = STEPS.map((s: { page: string }) => s.page);
    expect(pages.slice(0, 5).every((p: string) => p === "/")).toBe(true);
    expect(pages.slice(5, -1).every((p: string) => p === "/settings")).toBe(true);
    expect(pages.at(-1)).toBe("/");
    expect(STEPS[0].target).toBeUndefined();
    expect(STEPS.at(-1).target).toBeUndefined();
    expect(STEPS.find((s: { target?: string }) => s.target === "#import").link.href).toBe("https://www.spotify.com/account/privacy/");
  });

  it("places the card: centred without a target, a sheet on phones, else below, above, beside, or in the corner", () => {
    const card = { width: 360, height: 200 };
    const view = { width: 1440, height: 900 };
    const r = (top: number, height: number, left = 300, width = 400) => ({ top, bottom: top + height, left, right: left + width });
    expect(place(null, card, view)).toEqual({ mode: "center", left: 540, top: 350 });
    expect(place(r(100, 200), card, { width: 430, height: 932 })).toEqual({ mode: "sheet", left: 16, top: 716 });
    expect(place(r(100, 200), card, view)).toEqual({ mode: "below", left: 300, top: 314 });
    expect(place(r(600, 200), card, view)).toEqual({ mode: "above", left: 300, top: 386 });
    expect(place(r(40, 800), card, view)).toEqual({ mode: "right", left: 714, top: 40 });
    expect(place(r(40, 800, 900, 500), card, view)).toEqual({ mode: "left", left: 526, top: 40 });
    expect(place(r(40, 800, 100, 1300), card, view)).toEqual({ mode: "corner", left: 1064, top: 684 });
    expect(place(r(100, 200, 1300, 100), card, view).left).toBe(1064); // kept on screen
  });
});
