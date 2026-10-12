// The TSX primitives: the ones that overlap a `ui` helper render the same markup (so the same CSS
// styles both), and Switch / Chip / Row render the markup the new pages rely on.

import { describe, expect, it } from "vitest";
import { ui } from "../../src/dashboard";
import { Card, Chip, Facts, LinkButton, Notice, Pill, PostButton, Row, Rows, Switch } from "../../src/dashboard/components/primitives";
import { raw, render } from "../../src/dashboard/render";

const XSS = `<script>alert("x")</script>`;
const ESCAPED = "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;";

/** JSX closes void elements with "/>", the string helpers with ">"; otherwise the markup must match. */
const same = (jsx: string, html: string) => expect(jsx.replace(/\/>/g, ">")).toBe(html);

describe("primitives match the ui helpers", () => {
  it("Card", () => {
    same(render(<Card title={XSS}>{raw("<p>body</p>")}</Card>), ui.card(XSS, "<p>body</p>"));
    same(
      render(
        <Card title="Spotify" id="spotify" head={<Pill tone="ok" text="Connected" />} actions={<LinkButton href="/login" label="Reconnect" />}>
          {raw("<p>body</p>")}
        </Card>,
      ),
      ui.card("Spotify", "<p>body</p>", { id: "spotify", headHtml: ui.pill("ok", "Connected"), actionsHtml: ui.linkButton("/login", "Reconnect") }),
    );
    same(render(<Card title="x" id={`a"b`} />), ui.card("x", "", { id: `a"b` }));
  });

  it("Facts, with text and with element values", () => {
    same(render(<Facts rows={[[XSS, XSS], ["Plays", "1,204"]]} />), ui.facts([[XSS, XSS], ["Plays", "1,204"]]));
    same(render(<Facts rows={[["Status", <Pill tone="warn" text="Behind" />]]} />), ui.factsHtml([["Status", ui.pill("warn", "Behind")]]));
  });

  it("Pill, for every tone", () => {
    for (const tone of ["ok", "warn", "bad", "neutral"] as const) same(render(<Pill tone={tone} text={XSS} />), ui.pill(tone, XSS));
  });

  it("PostButton, with hidden fields, variants, small and an aria-label", () => {
    same(render(<PostButton action="/actions/sync" label="Sync now" />), ui.postButton("/actions/sync", "Sync now"));
    const fields = { kind: `"><script>`, key: "frequent" };
    same(
      render(<PostButton action="/actions/preview" label={XSS} fields={fields} variant="danger" small ariaLabel={`Send "week"`} />),
      ui.postButton("/actions/preview", XSS, { fields, variant: "danger", small: true, ariaLabel: `Send "week"` }),
    );
    same(render(<PostButton action="/x" label="Go" variant="primary" ariaLabel="" />), ui.postButton("/x", "Go", { variant: "primary", ariaLabel: "" }));
  });

  it("LinkButton", () => {
    same(render(<LinkButton href="/settings?a=1&b=2" label={XSS} />), ui.linkButton("/settings?a=1&b=2", XSS));
    same(render(<LinkButton href="/login" label="Log in" variant="primary" />), ui.linkButton("/login", "Log in", "primary"));
  });

  it("Notice, for every kind", () => {
    for (const kind of ["ok", "warn", "error"] as const) same(render(<Notice kind={kind} text={XSS} />), ui.notice({ kind, text: XSS }));
  });
});

describe("Rows and Row", () => {
  it("render home.ts's row markup: main, then actions under it, side on the right", () => {
    const out = render(
      <Rows>
        <Row side={<Pill tone="ok" text="On" />} actions={<PostButton action="/a" label="Recreate" small />}>
          <h3>{XSS}</h3>
        </Row>
        <Row>plain</Row>
      </Rows>,
    );
    expect(out).toBe(
      `<ul class="rows"><li><div class="main"><h3>${ESCAPED}</h3><div class="row-actions">${ui.postButton("/a", "Recreate", { small: true })}</div></div><div class="side">${ui.pill("ok", "On")}</div></li>` +
        `<li><div class="main">plain</div></li></ul>`,
    );
  });
});

describe("Switch", () => {
  it("posts the opposite state of one key to /settings/toggle", () => {
    expect(render(<Switch setting="digestWeekly" label="Weekly digest" on />)).toBe(
      `<form class="inline" method="post" action="/settings/toggle"><input type="hidden" name="key" value="digestWeekly"/><input type="hidden" name="value" value="false"/>` +
        `<button type="submit" class="switch" role="switch" aria-checked="true"><span class="switch-label">Weekly digest</span> <span class="switch-state" aria-hidden="true">On</span></button></form>`,
    );
    const off = render(<Switch setting="frequent" label="Frequent plays" on={false} />);
    expect(off).toContain(`<input type="hidden" name="value" value="true"/>`);
    expect(off).toContain(`aria-checked="false"`);
    expect(off).toContain(`<span class="switch-state" aria-hidden="true">Off</span>`);
  });

  it("can be disabled and described, and escapes its text", () => {
    const out = render(<Switch setting={`a"b`} label={XSS} on={false} disabled describedBy="s-liked-desc" />);
    expect(out).toContain(`value="a&quot;b"`);
    expect(out).toContain(`aria-describedby="s-liked-desc" disabled=""`);
    expect(out).toContain(`<span class="switch-label">${ESCAPED}</span>`);
    expect(render(<Switch setting="x" label="X" on disabled={false} describedBy="" />)).not.toMatch(/disabled|aria-describedby/);
  });
});

describe("Chip", () => {
  it("is a status link whose text carries the meaning", () => {
    expect(render(<Chip tone="warn" text={XSS} href="/manage" />)).toBe(`<a class="chip chip-warn" href="/manage">${ESCAPED}</a>`);
  });
});
