// The TSX page shell (layout.tsx): favicon, the Manage nav item, the head order, and the trusted
// body. Escaping, nonces and Import hiding are covered in pages.test.ts through renderPage.

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

  it("lists Manage between Home and Settings, and marks it current", () => {
    const out = render(
      <Page title="Manage" session={session} nav="manage" nonce="n">
        {raw("<p>x</p>")}
      </Page>,
    );
    const labels = [...out.matchAll(/<li><a href="([^"]+)"[^>]*>([^<]+)<\/a><\/li>/g)].map((m) => `${m[2]} ${m[1]}`);
    expect(labels).toEqual(["Home /", "Manage /manage", "Settings /settings", "Activity /activity", "Import /import"]);
    expect(out).toContain(`<a href="/manage" aria-current="page">Manage</a>`);
    expect(out).toContain(`<form class="inline" method="post" action="/logout"><button type="submit" class="btn btn-secondary btn-small">Log out</button></form>`);
  });

  it("puts the notice and the h1 before the trusted body, without a nav for visitors", () => {
    const out = render(
      <Page title="Almost ready" session={null} notice={{ kind: "error", text: "Nope" }} layout="narrow" nonce="n">
        {raw("<p>body</p>")}
      </Page>,
    );
    expect(out).toContain(`<header class="top bare"><a class="brand" href="/"><span class="mark" aria-hidden="true"></span>spotify-sync</a></header>`);
    expect(out).toContain(`<main id="main" class="narrow"><div class="notice notice-error" role="alert">Nope</div><h1>Almost ready</h1><p>body</p></main>`);
    expect(out).not.toContain("<nav");
  });
});
