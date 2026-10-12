// The TSX page shell (layout.tsx): favicon, the nav (Activity only with showActivity), the head
// order, the sidebar hook, and the trusted body. Escaping and nonces are covered in pages.test.ts
// through renderPage.

import { describe, expect, it } from "vitest";
import { Page, renderPage } from "../../src/dashboard/layout";
import { raw, render } from "../../src/dashboard/render";
import { expectSafePage, session } from "./helpers";

describe("page shell", () => {
  it("links the favicon and keeps the head in order", async () => {
    const body = await expectSafePage(renderPage({ title: "Import", session, body: "", refreshSeconds: 5, scripts: ["/import.js"] }));
    expect(body.startsWith(`<!doctype html><html lang="en"><head><meta charset="utf-8"/>`)).toBe(true);
    expect(body).toMatch(
      /<meta http-equiv="refresh" content="5"\/><title>Import · spotify-sync<\/title><link rel="icon" href="\/favicon.svg" type="image\/svg\+xml"\/><style nonce="[^"]+">[\s\S]*<\/style><script type="module" src="\/import.js"><\/script><\/head>/,
    );
  });

  it("lists Home and Settings, Activity only with showActivity, and marks the current one", () => {
    const page = (showActivity?: boolean) =>
      render(
        <Page title="Settings" session={session} nav="settings" nonce="n" showActivity={showActivity}>
          {raw("<p>x</p>")}
        </Page>,
      );
    const labels = (out: string) => [...out.matchAll(/<li><a href="([^"]+)"[^>]*>([^<]+)<\/a><\/li>/g)].map((m) => `${m[2]} ${m[1]}`);
    const out = page();
    expect(labels(out)).toEqual(["Home /", "Settings /settings"]);
    expect(labels(page(true))).toEqual(["Home /", "Settings /settings", "Activity /activity"]);
    expect(out).toContain(`<a href="/settings" aria-current="page">Settings</a>`);
    expect(out).toContain(`<body class="with-nav">`);
    expect(out).not.toContain(`action="/logout"`); // Log out is in Settings (the Account card)
  });

  it("loads no web fonts", async () => {
    const body = await expectSafePage(renderPage({ title: "Home", session, body: "" }));
    expect(body).not.toMatch(/rel="preload"|@font-face|\.woff2/);
  });

  it("puts the notice and the h1 before the trusted body, without a nav for visitors", () => {
    const out = render(
      <Page title="Almost ready" session={null} notice={{ kind: "error", text: "Nope" }} layout="narrow" nonce="n">
        {raw("<p>body</p>")}
      </Page>,
    );
    expect(out).toContain(`<body><a class="skip" href="#main">`);
    expect(out).toContain(`<header class="top bare"><a class="brand" href="/"><span class="mark" aria-hidden="true"></span>spotify-sync</a></header>`);
    expect(out).toContain(`<main id="main" class="narrow"><div class="notice notice-error" role="alert">Nope</div><h1>Almost ready</h1><p>body</p></main>`);
    expect(out).not.toContain("<nav");
  });
});
