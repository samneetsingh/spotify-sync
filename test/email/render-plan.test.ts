import { describe, expect, it } from "vitest";
import { THEME_IDS } from "../../src/editor/types";
import { renderDigest, type DigestData } from "../../src/jobs/digest";
import { bold, unbold } from "../../src/email/layout";
import { defaultCopy, defaultLayout, sectionSpecs } from "../../src/email/sections";
import { tokensFor } from "../../src/email/themes";
import { monthData, monthPlan, weekData, weekPlan } from "./fixtures";

const sha256 = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");

// Hashes of the renderer's output before the AI editor (commit a931a19). The default email must stay
// byte-identical: without a plan, theme tokens and the section registry are a pure refactor.
const SNAPSHOT: Record<string, { data: () => DigestData; subject: string; html: string; text: string }> = {
  month: {
    data: monthData,
    subject: "Your September 2026 in music: 1,564 plays",
    html: "b85e33b5358965cfed36f1a8dcb4f52114183f401c1156c1ec0358ab1386099f",
    text: "72c4ba98f3b2e987c9aa6145895da1c6627b3f8fa2dea8e2f25a3ebe5848fd34",
  },
  week: {
    data: weekData,
    subject: "Your week in music, Sep 28 to Oct 4: 212 plays",
    html: "db45bc39634aba997d6c6e4a08eadd873f187fd1c1be028f0ace0004a825aad6",
    text: "b1562b9c6c50766c07f6f4340f39e8a543cf7a58ecc5902ee2cedb2a5ebdc0b4",
  },
};

describe("default output is unchanged", () => {
  for (const [name, want] of Object.entries(SNAPSHOT)) {
    it(`${name}`, async () => {
      for (const email of [renderDigest(want.data()), renderDigest(want.data(), { plan: null, theme: "default" })]) {
        expect(email.subject).toBe(want.subject);
        expect(await sha256(email.html!)).toBe(want.html);
        expect(await sha256(email.text)).toBe(want.text);
      }
    });
  }
});

/** Positions of each needle in `s`; -1 when missing. */
const positions = (s: string, needles: string[]) => needles.map((n) => s.indexOf(n));
const inOrder = (s: string, needles: string[]) => {
  const at = positions(s, needles);
  return at.every((x, i) => x >= 0 && (i === 0 || x > at[i - 1]!));
};
/** A section's HTML: from its heading to the next page-level row. */
const block = (html: string, heading: string) => {
  const from = html.indexOf(`>${heading}</div>`);
  expect(from).toBeGreaterThan(-1);
  const to = html.indexOf('<tr><td class="g"', from);
  return html.slice(from, to < 0 ? undefined : to);
};
const B = (s: string) => `<b style="color:#ffffff;font-weight:700">${s}</b>`;

describe("the section catalog", () => {
  it("lists each digest's sections in default order, with data and default copy", () => {
    const month = sectionSpecs("month", monthData());
    expect(month.map((s) => s.id)).toEqual(["song", "alsoOnRepeat", "topArtists", "sound", "dayByDay", "whenYouListen", "year", "newToYou", "welcomeBack", "throwback"]);
    expect(month.every((s) => s.available)).toBe(true);
    expect(month.filter((s) => s.required).map((s) => s.id)).toEqual(["song", "alsoOnRepeat", "topArtists"]);
    expect(month.filter((s) => !s.insightSlot).map((s) => s.id)).toEqual(["song", "alsoOnRepeat", "topArtists"]);
    expect(month[0]).toMatchObject({ component: "feature", defaultHeading: "Song of the month", defaultInsight: null });
    expect(month.find((s) => s.id === "dayByDay")!.defaultInsight).toBe("Your biggest day was **Sunday, September 13**, with 100 plays.");
    expect(month.find((s) => s.id === "year")!.defaultInsight).toBe("**1,564 plays**, down 14% from August. Your biggest month was **August**.");

    const week = sectionSpecs("week", weekData());
    expect(week.map((s) => s.id)).toEqual(["song", "alsoOnRepeat", "topArtists", "week", "timeOfDay", "newToYou"]);
    expect(week.map((s) => s.defaultHeading)).toEqual(["Song of the week", "Also on repeat", "Top artists", "Your week", "Time of day", "New to you"]);
    expect(defaultCopy("week", weekData())).toEqual({ heading: "Your week", insight: "**Friday** was your biggest day, with 47 plays." });
  });

  it("marks sections without data unavailable", () => {
    const data = { ...monthData(), topTracks: monthData().topTracks.slice(0, 1), genres: [], returning: [], throwbacks: [], newTrackCount: 0, newArtists: [] };
    data.year = data.year.map((m, i) => ({ ...m, plays: i === 11 ? m.plays : 0 }));
    const off = sectionSpecs("month", data).filter((s) => !s.available);
    expect(off.map((s) => s.id)).toEqual(["alsoOnRepeat", "sound", "year", "newToYou", "welcomeBack", "throwback"]);
    expect(off.find((s) => s.id === "year")!.defaultInsight).toBeNull();
    expect(defaultLayout("month", data).map((s) => s.id)).toEqual(["song", "topArtists", "dayByDay", "whenYouListen"]);
  });
});

describe("rendering a plan", () => {
  const data = monthData();
  const email = renderDigest(data, { plan: monthPlan(), theme: "default" });
  const html = email.html!;

  it("renders the plan's sections in its order and leaves the others out", () => {
    const headings = monthPlan().sections.map((s) => s.heading);
    expect(inOrder(html, headings.map((h) => `>${h}</div>`))).toBe(true);
    for (const absent of ["Your sound", "Your year", "Welcome back", "Throwback", "Day by day", "Also on repeat", "Top artists", "When you listen", "Song of the month"]) {
      expect(html).not.toContain(`>${absent}</div>`);
      expect(email.text).not.toContain(absent);
    }
    expect(html).not.toContain("Your top song that month"); // the throwback card itself
  });

  it("renders highlight cards: big number, sentence, then the song with its cover or a placeholder", () => {
    const streak = block(html, "Every single day");
    expect(streak).toContain('color:#1ed760">23</div>');
    expect(streak).toContain(">days in a row</div>");
    expect(streak).toContain(`You pressed play ${B("23 days in a row")}, Sep 3 to Sep 25.`); // null insight = the highlight's own
    expect(streak).not.toContain("<img");

    const comeback = block(html, "Back on rotation");
    expect(comeback).toContain(`${B("Midnight City")} came back after ${B("2 years")}.`);
    expect(comeback).toContain('<img src="https://i.test/t2-300" width="48" height="48" alt="Midnight City"');
    expect(comeback).toContain('href="https://open.spotify.com/track/t2"');
    expect(comeback).toContain(">M83</div>");

    const obsession = block(html, "New obsession");
    expect(obsession).toContain('">1,234</div>');
    expect(obsession).toContain("&#9834;");
    expect(obsession).toContain("Brand New &lt;3");
    expect(obsession).toContain("Fresh &amp; Co");
  });

  it("escapes all copy and turns **phrases** into bold", () => {
    expect(html).not.toContain("<Live>");
    expect(html).not.toContain("<b>no</b>");
    expect(block(html, "The big Sunday")).toContain(`Sunday the 13th: ${B("100 plays")} &amp; &lt;b&gt;no&lt;/b&gt; skips`);
    expect(block(html, "Fresh finds")).toContain(`${B("96")} tracks were new to you.`);
    expect(html).not.toContain("**");
    expect(bold("a **b & c** d **e**")).toBe(`a ${B("b &amp; c")} d ${B("e")}`);
    expect(unbold("a **b** c")).toBe("a b c");
  });

  it("keeps the default sentence of a chart whose insight is null; ignores insights where there is no slot", () => {
    const sentence = defaultCopy("whenYouListen", data).insight!;
    expect(block(html, "Your hours")).toContain(bold(sentence));
    expect(email.text).toContain(`  ${unbold(sentence)}`);

    const week = renderDigest(weekData(), { plan: weekPlan() });
    expect(week.html).not.toContain("ignored: no insight slot");
    expect(week.text).not.toContain("ignored");
  });

  it("puts the headline in the hero with the period label under it, and the plan's lead", () => {
    expect(html).toContain('>Tom &amp; Jerry &lt;Live&gt; month<br><span style="color:#0b4a25">September 2026</span>');
    expect(html).toContain(">1,564 plays, and Tom &amp; Jerry &lt;Live&gt; wouldn&#39;t leave.</div>");
    expect(html).toContain(">Your month in music</div>"); // default theme: default kicker
    const week = renderDigest(weekData(), { plan: weekPlan() }).html!;
    expect(week).toContain('>Friday did the heavy lifting<br><span style="color:#0b4a25">Sep 28 to Oct 4</span>');
  });

  it("replaces the preheader but not the subject", () => {
    expect(email.subject).toBe(SNAPSHOT.month!.subject);
    expect(html).toContain(`<title>${SNAPSHOT.month!.subject}</title>`);
    expect(html).toContain("opacity:0;color:transparent\">23 days in a row &amp; a comeback from 2024&#847;");
    expect(html).not.toContain("1,564 plays and 87 hours");
  });

  it("writes the plain-text part in the same order with the same copy", () => {
    const lines = [
      "Your month in music: September 2026",
      "Tom & Jerry <Live> month",
      "1,564 plays, and Tom & Jerry <Live> wouldn't leave.",
      "87 hours · 412 tracks · 187 artists",
      "Every single day",
      "  23 days in a row",
      "  You pressed play 23 days in a row, Sep 3 to Sep 25.",
      "Your song of September: Tom & Jerry <Live> by Alpha, Beta (48 plays)",
      "Who you played",
      "  1. Alpha (96 plays)",
      "Close behind",
      "  2. Midnight City — M83 (31 plays)",
      "Back on rotation",
      "  14 plays after 2 years away",
      "  Midnight City came back after 2 years.",
      "  Midnight City — M83",
      "The big Sunday",
      "  Sunday the 13th: 100 plays & <b>no</b> skips",
      "Fresh finds",
      "  96 tracks were new to you.",
      "  96 tracks you'd never played before",
      "New obsession",
      "  1,234 plays since you found it",
      "  Brand New <3 — Fresh & Co",
      "Your hours",
      "Still updating in your library: On This Day, Forgotten Favorites.",
    ];
    expect(positions(email.text, lines).filter((x) => x < 0)).toEqual([]);
    expect(inOrder(email.text, lines.map((l, i) => (i ? `\n${l}` : l)))).toBe(true);
    expect(email.text).not.toContain("**");

    const week = renderDigest(weekData(), { plan: weekPlan() }).text;
    const weekLines = ["Song of the week: This Week by Weekly (14 plays)", "Welcome back, Surfaces", "  3 years away", "  Surfaces again, for the first time since Aug 2023.", "  Surfaces", "Your week", "  Friday was the big one.", "Top artists", "Also on repeat"];
    expect(inOrder(week, weekLines.map((l) => `\n${l}\n`))).toBe(true);
  });

  it("renders an artist subject as a round photo", () => {
    const card = block(renderDigest(weekData(), { plan: weekPlan() }).html!, "Welcome back, Surfaces");
    expect(card).toContain('src="https://i.test/wa2-300" width="48" height="48" alt="Surfaces" style="display:block;width:48px;height:48px;border-radius:50%');
    expect(card).toContain('href="https://open.spotify.com/artist/wa2"');
  });

  it("stays under Gmail's clip limit with 3 highlights", () => {
    expect(new TextEncoder().encode(html).length).toBeLessThan(100_000);
  });
});

describe("themes in the email", () => {
  it("recolours a planned Halloween digest", () => {
    const html = renderDigest(monthData(), { plan: monthPlan("halloween"), theme: "halloween" }).html!;
    expect(html).toContain("#ff8a1f");
    expect(html).not.toContain("#1ed760");
    expect(html).toContain(">\u263E Spooky season</div>");
  });

  it("recolours the default email too, and never leaves the green behind", () => {
    const green = tokensFor("default");
    for (const id of THEME_IDS.filter((x) => x !== "default")) {
      const t = tokensFor(id);
      for (const data of [monthData(), weekData()]) {
        const { html, text, subject } = renderDigest(data, { theme: id });
        expect(subject).toBe(renderDigest(data).subject);
        expect(text).toBe(renderDigest(data).text); // themes are visual only
        expect(html).toContain(`linear-gradient(150deg,${t.hero.stops[0]} 0%,${t.hero.stops[1]} 55%,${t.hero.stops[2]} 100%)`);
        for (const c of [green.hero.stops[1], green.hero.stops[2], green.hero.sub, green.hero.lead, green.hero.kicker]) expect(html).not.toContain(c);
        if (t.accent !== green.accent) for (const c of [...green.scale, green.accentDim]) expect(html).not.toContain(c);
        expect(html).not.toContain("Your month in music");
        expect(html).not.toContain("Your week in music</div>");
      }
    }
  });
});
