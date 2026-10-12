// render() and raw(): hono/jsx compiles in vitest (TSX), escapes text and attributes, and passes
// trusted strings through.

import type { Child } from "hono/jsx";
import { describe, expect, it } from "vitest";
import { raw, render } from "../../src/dashboard/render";

const XSS = `<script>alert("x")</script>`;

describe("render", () => {
  it("renders a component tree to an HTML string", () => {
    const Item = ({ children }: { children?: Child }) => <li class="item">{children}</li>;
    const out = render(
      <ul class="rows">
        <Item>one</Item>
        {[2, 3].map((n) => (
          <Item>{n}</Item>
        ))}
        {false}
        {null}
      </ul>,
    );
    expect(out).toBe(`<ul class="rows"><li class="item">one</li><li class="item">2</li><li class="item">3</li></ul>`);
  });

  it("escapes text and attribute values", () => {
    expect(render(<p title={`a "b" & 'c' <d>`}>{XSS} & 'q'</p>)).toBe(
      `<p title="a &quot;b&quot; &amp; &#39;c&#39; &lt;d&gt;">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;</p>`,
    );
    expect(render(<a href={`/x?a=1&b="><script>`}>link</a>)).toBe(`<a href="/x?a=1&amp;b=&quot;&gt;&lt;script&gt;">link</a>`);
  });

  it("passes raw() strings through unescaped, as children and as attributes", () => {
    expect(render(<div>{raw("<b>trusted &amp; done</b>")}</div>)).toBe("<div><b>trusted &amp; done</b></div>");
    expect(render(<style nonce="n">{raw("a>b{color:red}")}</style>)).toBe(`<style nonce="n">a>b{color:red}</style>`);
    expect(render(raw("<i>x</i>"))).toBe("<i>x</i>");
  });

  it("renders boolean attributes and drops undefined ones", () => {
    expect(render(<button type="submit" disabled aria-label={undefined}>Go</button>)).toBe(`<button type="submit" disabled="">Go</button>`);
    expect(render(<button disabled={false}>Go</button>)).toBe("<button>Go</button>");
  });

  it("throws on async components instead of rendering a Promise", () => {
    const Later = async () => <p>later</p>;
    expect(() => render(<div>{(<Later />) as Child}</div>)).toThrow(/must be synchronous/);
    expect(() => render(Later())).toThrow(/must be synchronous/);
  });
});
