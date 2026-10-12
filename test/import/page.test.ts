// The Import page's markup (src/import/page.tsx): the hooks public/import.js relies on, every state
// without style= attributes, the per-year table, and escaping of what an import row carries.
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/auth";
import { migrate } from "../../src/db/schema";
import type { Env } from "../../src/env";
import { importSection } from "../../src/import";
import { LIMITS, PART_SIZE } from "../../src/import/limits";
import { importPage, STUCK_MS } from "../../src/import/page";
import type { Preview } from "../../src/import/store";
// @ts-expect-error Vite's ?raw import (the uploader's source as text) has no type declarations here
import IMPORT_JS from "../../public/import.js?raw";
import { resetDb } from "../parity/spotify-fixture";
import { insertImport } from "./helpers";

const testEnv = (): Env => ({ ...(env as unknown as Env), PUBLIC_URL: "https://sync.test", WRITE_MODE: "dry_run" });
const session: Session = { spotifyId: "test-user", displayName: "Test", expiresAt: Date.now() + 86_400_000 };
const db = env.DB;

const PREVIEW: Preview = {
  from: Date.UTC(2016, 2, 5),
  to: Date.UTC(2020, 0, 2),
  records: 1200,
  skipped: 30,
  short: 170,
  plays: 1000,
  months: { "2016-03": [400, 0, 2], "2019-11": [100, 0, 0], "2019-12": [450, 10, 40] },
  totals: [950, 10, 42],
  warnings: {},
};

/** The page's HTML after checking what every page must: a nonce'd <style>, no style= attributes, no inline script. */
async function html(res: Response | Promise<Response>): Promise<string> {
  const r = await res;
  const nonce = r.headers.get("Content-Security-Policy")?.match(/style-src 'nonce-([^']+)'/)?.[1];
  expect(nonce).toBeTruthy();
  const body = await r.text();
  for (const tag of body.match(/<style\b[^>]*>/g) ?? []) expect(tag).toBe(`<style nonce="${nonce}">`);
  expect(body).not.toMatch(/\sstyle\s*=/i);
  expect(body).not.toMatch(/<script(?![^>]*\bsrc=)/i);
  return body;
}

const page = (opts: Parameters<typeof importPage>[3] = {}) => html(importPage(testEnv(), db, session, opts));

/** Each element matching `selector` in `body` (lol-html selectors: descendant and attribute selectors work), with its attributes. */
async function select(body: string, selector: string): Promise<Array<{ tag: string; attrs: Record<string, string> }>> {
  const found: Array<{ tag: string; attrs: Record<string, string> }> = [];
  await new HTMLRewriter()
    .on(selector, { element: (e) => void found.push({ tag: e.tagName, attrs: Object.fromEntries(e.attributes) }) })
    .transform(new Response(body))
    .text();
  return found;
}

beforeAll(() => migrate(db));
beforeEach(() => resetDb(db));

describe("uploader hooks", () => {
  // Read from public/import.js itself, so a hook it starts using can't go unnoticed.
  const selectors = [...(IMPORT_JS as string).matchAll(/querySelector\((["'])(.+?)\1\)/g)].map((m) => m[2]!);
  const dataset = [...new Set([...(IMPORT_JS as string).matchAll(/dataset\.(\w+)/g)].map((m) => m[1]!))];
  const FORM = "form[data-import-upload]";

  it("finds the hooks import.js uses", () => {
    expect(selectors.sort()).toEqual(['input[type="file"]', "[data-import-progress]", "[data-import-status]", "[data-import-submit]", "[data-import-upload]"].sort());
    expect(dataset.sort()).toEqual(["maxFiles", "maxJson", "maxTotal", "maxZip"]);
  });

  it("keeps every element and limit import.js reads, inside the upload form", async () => {
    const body = await page();
    expect(body).toContain('<script type="module" src="/import.js"></script>');

    const [form, ...more] = await select(body, FORM);
    expect(more).toEqual([]);
    expect(form!.tag).toBe("form");
    const kebab = (k: string) => `data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    const limits: Record<string, number> = { maxFiles: LIMITS.files, maxZip: LIMITS.zipBytes, maxJson: LIMITS.jsonBytes, maxTotal: LIMITS.totalBytes };
    for (const key of dataset) expect(form!.attrs[kebab(key)], key).toBe(String(limits[key]));
    expect(form!.attrs["data-part-size"]).toBe(String(PART_SIZE));

    // Everything else import.js finds with form.querySelector: one of each, inside the form.
    for (const s of selectors.filter((s) => s !== "[data-import-upload]")) expect(await select(body, `${FORM} ${s}`), s).toHaveLength(1);
    const [input] = await select(body, `${FORM} input[type="file"]`);
    expect(input!.attrs).toMatchObject({ id: "import-files", multiple: "", required: "", "aria-describedby": "import-files-help" });
    expect(await select(body, `${FORM} label[for="import-files"]`)).toHaveLength(1);
    const [submit] = await select(body, `${FORM} [data-import-submit]`);
    expect(submit).toMatchObject({ tag: "button", attrs: { type: "submit" } });
    const [bar] = await select(body, `${FORM} [data-import-progress]`);
    expect(bar).toMatchObject({ tag: "progress", attrs: { max: "100", value: "0", hidden: "" } });
    const [status] = await select(body, `${FORM} [data-import-status]`);
    expect(status!.attrs).toMatchObject({ role: "status", "aria-live": "polite" });
  });

  it("serves the uploader only while uploading is possible", async () => {
    await insertImport(db, { status: "reading" });
    const body = await page();
    expect(body).not.toContain("/import.js");
    expect(await select(body, "[data-import-upload]")).toEqual([]);
  });
});

describe("every state", () => {
  const stuckAgo = Date.now() - STUCK_MS - 60_000;
  const states: Array<[name: string, setup: () => Promise<unknown>, expected: string[]]> = [
    ["nothing yet", async () => {}, ["Upload your history", "Your export"]],
    ["an interrupted upload", () => insertImport(db, { status: "uploading" }), ["An earlier upload didn&#39;t finish"]],
    ["reading", () => insertImport(db, { status: "reading" }), ["Reading your export", "In progress", "This page refreshes itself", 'http-equiv="refresh"']],
    ["preparing the review", () => insertImport(db, { status: "review" }), ["Preparing the review", 'http-equiv="refresh"']],
    ["review", () => insertImport(db, { status: "review", preview: PREVIEW }), ["Ready to review", "Waiting for you", "Also add to your library", "Changed your mind?"]],
    ["applying", () => insertImport(db, { status: "applying", preview: PREVIEW }), ["Importing", "it&#39;s done", 'http-equiv="refresh"']],
    ["applying, stuck", () => insertImport(db, { status: "applying", preview: PREVIEW, createdAt: stuckAgo }), ["No progress", "/retry", "/cancel"]],
    ["failed", () => insertImport(db, { status: "failed" }), ["The import stopped", "Unknown error", "Discard"]],
    ["done", () => insertImport(db, { status: "done", preview: PREVIEW }), ["Upload your history", "Last import", "Imported", "<dt>Plays added</dt><dd>950</dd>"]],
    ["expired", () => insertImport(db, { status: "expired", preview: PREVIEW }), ["Upload your history", "The review expired after 7 days"]],
  ];
  for (const [name, setup, expected] of states) {
    it(`renders ${name}`, async () => {
      await setup();
      const body = await page();
      for (const text of expected) expect(body).toContain(text);
      expect(body.match(/<h1>/g)).toHaveLength(1);
      expect(body).toContain("<h1>Import history</h1>");
    });
  }

  it("shows how many files are read while reading", async () => {
    const id = await insertImport(db, { status: "reading" });
    const entries = { "1/0": { done: true }, "1/9": {} };
    await db.prepare("UPDATE imports SET entries = ?2, progress = 'Read file 1 of 2' WHERE id = ?1").bind(id, JSON.stringify(entries)).run();
    const body = await page();
    expect(body).toContain("Read file 1 of 2");
    expect(body).toContain("<dt>Files read</dt><dd>1 of 2</dd>");
    expect(body).toContain('<progress class="files-read" max="2" value="1" aria-hidden="true"></progress>');
  });

  it("shows the flash messages by their fixed codes only", async () => {
    expect(await page({ url: new URL("https://sync.test/import?ok=approved") })).toContain('role="status">Importing. You can close this page');
    expect(await page({ url: new URL("https://sync.test/import?err=retry") })).toContain('role="alert">Couldn&#39;t restart the import.');
    expect(await page({ url: new URL("https://sync.test/import?ok=%3Cb%3Ehi") })).not.toContain('class="notice');
  });
});

describe("review", () => {
  it("shows the changes per year as a table, with a total row", async () => {
    await insertImport(db, { status: "review", preview: PREVIEW });
    const body = await page();
    expect(body).toContain('<details><summary>By year</summary><div class="table-wrap"><table class="years"><caption class="vh">Plays changed by year</caption>');
    expect(body).toContain('<th scope="col">Year</th><th scope="col" class="num">Added</th><th scope="col" class="num">Completed</th><th scope="col" class="num">Removed</th>');
    const row = (head: string, ...cells: string[]) => `<tr><th scope="row">${head}</th>${cells.map((c) => `<td class="num">${c}</td>`).join("")}</tr>`;
    expect(body).toContain(row("2016", "+400", "0", "−2"));
    expect(body).toContain(row("2019", "+550", "10", "−40"));
    expect(body).toContain(`<tfoot>${row("Total", "+950", "10", "−42")}</tfoot>`);
    expect(body).toContain("<dt>Plays to add</dt><dd><span class=\"num\">950</span></dd>");
  });

  it("says so when nothing changes, and leaves out the total for a single year", async () => {
    await insertImport(db, { status: "review", preview: { ...PREVIEW, months: {}, totals: [0, 0, 0] } });
    expect(await page()).toContain("No changes: your plays already match the export.");
    await resetDb(db);
    await insertImport(db, { status: "review", preview: { ...PREVIEW, months: { "2016-03": [400, 0, 0] }, totals: [400, 0, 0] } });
    const body = await page();
    expect(body).toContain('<tr><th scope="row">2016</th><td class="num">+400</td><td class="num">0</td><td class="num">0</td></tr>');
    expect(body).not.toContain("<tfoot>");
  });

  it("shows both warnings and asks for 'I understand'", async () => {
    await insertImport(db, { status: "review", preview: { ...PREVIEW, warnings: { accountMismatch: { synced: 40, matched: 2 }, historyLoss: { deletes: 30, imported: 50 } } } });
    const body = await page();
    expect(body).toContain("<strong>Is this your export?</strong> Only 2 of the 40 plays spotify-sync recorded in these years appear in it.");
    expect(body).toContain("<strong>This removes earlier imported plays.</strong> 30 of the 50 plays from an earlier import aren&#39;t in this export.");
    expect(body).toContain('<input type="checkbox" id="f-understand" name="understand"/>');
    expect(body).toContain("pill pill-warn");
  });
});

describe("escaping", () => {
  const EVIL = `<img src=x onerror=alert(1)>"q" & 'a'.zip`;
  const ESCAPED = "&lt;img src=x onerror=alert(1)&gt;&quot;q&quot; &amp; &#39;a&#39;.zip";

  it("escapes an error and the progress text from the import row, and never shows file names", async () => {
    const files = [{ n: 1, name: EVIL, size: 10, key: "imports/x/1.zip", uploadId: "u", done: true }];
    const id = await insertImport(db, { status: "failed", files });
    await db.prepare("UPDATE imports SET error = ?2 WHERE id = ?1").bind(id, `${EVIL} can't be read`).run();
    const failed = await page();
    expect(failed).toContain(`<span class="error-text">${ESCAPED} can&#39;t be read</span>`);
    expect(failed).not.toContain("<img");

    await db.prepare("UPDATE imports SET status = 'reading', error = NULL, progress = ?2 WHERE id = ?1").bind(id, EVIL).run();
    const reading = await page();
    expect(reading).toContain(`<dt>Status</dt><dd>${ESCAPED}</dd>`);
    expect(reading).not.toContain("<img");
    const card = await importSection(db);
    expect(card).toContain(`<p>${ESCAPED}</p>`);
    expect(card).not.toContain("<img");
  });

  it("escapes the approve form's errors", async () => {
    await insertImport(db, { status: "review", preview: PREVIEW });
    const body = await page({ errors: [EVIL], status: 400 });
    expect(body).toContain(`<li>${ESCAPED}</li>`);
    expect(body).not.toContain("<img");
  });
});

describe("Import section", () => {
  it("is an HTML string for the Settings page's Account card in each state", async () => {
    expect(await importSection(db)).toBe(
      '<div class="card-part" id="import"><div class="part-head"><h3>History import</h3></div><p>Add everything you played before spotify-sync started, from Spotify&#39;s Extended streaming history.</p><div class="actions"><a class="btn btn-primary" href="/import">Import history</a></div></div>',
    );
    await insertImport(db, { status: "review", preview: PREVIEW });
    const review = await importSection(db);
    expect(review).toContain('<span class="pill pill-warn">Ready to review</span>');
    expect(review).toContain('<a class="btn btn-primary" href="/import">Review the import</a>');
  });
});
