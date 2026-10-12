// The TSX primitives every dashboard page builds on: their markup (the shared CSS classes), escaping
// of every text prop, and the Chip / Row markup the pages rely on.

import { describe, expect, it } from "vitest";
import { Card, Chip, Facts, LinkButton, Notice, Pill, PostButton, Row, Rows } from "../../src/dashboard/components/primitives";
import { raw, render } from "../../src/dashboard/render";

const XSS = `<script>alert("x")</script>`;
const ESCAPED = "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;";

/** JSX closes void elements with "/>", the string helpers with ">"; otherwise the markup must match. */
const same = (jsx: string, html: string) => expect(jsx.replace(/\/>/g, ">")).toBe(html);

describe("shared primitives", () => {
  it("Card: escaped title, labelled by its heading, head and actions slots", () => {
    expect(render(<Card title={XSS}>{raw("<p>body</p>")}</Card>)).toBe(
      `<section class="card"><div class="card-head"><h2>${ESCAPED}</h2></div><p>body</p></section>`,
    );
    const out = render(
      <Card title="Spotify" id="spotify" head={<Pill tone="ok" text="Connected" />} actions={<LinkButton href="/login" label="Reconnect" />} />,
    );
    expect(out).toContain('<section class="card" id="spotify" aria-labelledby="spotify-title">');
    expect(out).toContain('<h2 id="spotify-title">Spotify</h2><span class="pill pill-ok">Connected</span>');
    expect(out).toContain('<div class="actions"><a class="btn btn-secondary" href="/login">Reconnect</a></div>');
    expect(render(<Card title="x" id={`a"b`} />)).toContain('id="a&quot;b"');
  });

  it("Facts: label and value rows, text escaped, elements kept", () => {
    expect(render(<Facts rows={[[XSS, XSS], ["Plays", "1,204"]]} />)).toBe(`<dl class="facts"><dt>${ESCAPED}</dt><dd>${ESCAPED}</dd><dt>Plays</dt><dd>1,204</dd></dl>`);
    expect(render(<Facts rows={[["Status", <Pill tone="warn" text="Behind" />]]} />)).toContain('<dd><span class="pill pill-warn">Behind</span></dd>');
  });

  it("Pill, for every tone", () => {
    for (const tone of ["ok", "warn", "bad", "neutral"] as const) expect(render(<Pill tone={tone} text={XSS} />)).toBe(`<span class="pill pill-${tone}">${ESCAPED}</span>`);
  });

  it("PostButton: a one-button POST form with escaped hidden fields, variants, small and an aria-label", () => {
    expect(render(<PostButton action="/actions/sync" label="Sync now" />)).toBe(
      '<form class="inline" method="post" action="/actions/sync"><button type="submit" class="btn btn-secondary">Sync now</button></form>',
    );
    const out = render(<PostButton action="/actions/preview" label={XSS} fields={{ kind: `"><script>` }} variant="danger" small ariaLabel={`Send "week"`} />);
    expect(out).not.toContain("<script>");
    expect(out).toContain('<input type="hidden" name="kind" value="&quot;&gt;&lt;script&gt;"/>');
    expect(out).toContain('class="btn btn-danger btn-small" aria-label="Send &quot;week&quot;"');
  });

  it("LinkButton", () => {
    expect(render(<LinkButton href="/settings?a=1&b=2" label={XSS} />)).toBe(`<a class="btn btn-secondary" href="/settings?a=1&amp;b=2">${ESCAPED}</a>`);
    expect(render(<LinkButton href="/login" label="Log in" variant="primary" />)).toBe('<a class="btn btn-primary" href="/login">Log in</a>');
  });

  it("Notice: role=alert for errors, role=status otherwise", () => {
    expect(render(<Notice kind="error" text={XSS} />)).toBe(`<div class="notice notice-error" role="alert">${ESCAPED}</div>`);
    for (const kind of ["ok", "warn"] as const) expect(render(<Notice kind={kind} text="Saved" />)).toBe(`<div class="notice notice-${kind}" role="status">Saved</div>`);
  });
});

describe("Rows and Row", () => {
  it("render the rows markup: main, then actions under it, side on the right", () => {
    const out = render(
      <Rows>
        <Row side={<Pill tone="ok" text="On" />} actions={<PostButton action="/a" label="Recreate" small />}>
          <h3>{XSS}</h3>
        </Row>
        <Row>plain</Row>
      </Rows>,
    );
    expect(out).toBe(
      `<ul class="rows"><li><div class="main"><h3>${ESCAPED}</h3><div class="row-actions"><form class="inline" method="post" action="/a"><button type="submit" class="btn btn-secondary btn-small">Recreate</button></form></div></div><div class="side"><span class="pill pill-ok">On</span></div></li>` +
        `<li><div class="main">plain</div></li></ul>`,
    );
  });
});

describe("Chip", () => {
  it("is a status link whose text carries the meaning", () => {
    expect(render(<Chip tone="warn" text={XSS} href="/manage" />)).toBe(`<a class="chip chip-warn" href="/manage">${ESCAPED}</a>`);
  });
});
