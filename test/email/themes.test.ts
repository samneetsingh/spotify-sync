import { describe, expect, it } from "vitest";
import { THEME_IDS } from "../../src/editor/types";
import { THEMES, contrast, seasonalTheme, themeOptions, themeProblems, tokensFor, type Theme } from "../../src/email/themes";

describe("themes", () => {
  it.each(THEME_IDS)("%s is readable on the email surfaces", (id) => {
    expect(THEMES[id].id).toBe(id);
    expect(themeProblems(THEMES[id])).toEqual([]);
  });

  it("reports what makes a theme unreadable", () => {
    const bad: Theme = {
      ...THEMES.default,
      ornament: "🎃",
      colors: { ...THEMES.default.colors, accent: "#333333", scale: ["#1b3a28", "#178a45", "#1f5a39", "#19b04f", "#1ed760"] },
    };
    expect(themeProblems(bad)).toEqual([
      "accent on card 1.46 < 4.5",
      "accent on raised 1.35 < 4.5",
      "onAccent on accent 1.66 < 4.5",
      "accent vs accentDim 1.55 < 3",
      "scale[2] not brighter than scale[1]",
      "scale[4] is not the accent",
      "ornament not allowed: 🎃",
    ]);
    const lead = { ...THEMES.halloween.colors.hero, lead: "#ff8a1f" }; // the accent on its own gradient
    expect(themeProblems({ ...THEMES.halloween, colors: { ...THEMES.halloween.colors, hero: lead } })).toEqual([
      "hero lead on stop 0 1.16 < 4.5",
      "hero lead on stop 1 1.00 < 4.5",
      "hero lead on stop 2 1.19 < 4.5",
    ]);
  });

  it("measures WCAG contrast", () => {
    expect(contrast("#000", "#fff")).toBeCloseTo(21, 5);
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrast("#1ed760", "#1ed760")).toBe(1);
    expect(contrast("#8e8e8e", "#1c1c1c")).toBeGreaterThanOrEqual(4.5); // the mute text
  });

  it("keeps the default tokens the email had before themes", () => {
    expect(tokensFor("default")).toEqual({
      page: "#0a0a0a",
      card: "#141414",
      raised: "#1c1c1c",
      line: "#2a2a2a",
      empty: "#242424",
      text: "#ffffff",
      soft: "#b3b3b3",
      mute: "#8e8e8e",
      red: "#ff5c6c",
      accent: "#1ed760",
      accentDim: "#1f5a39",
      onAccent: "#000",
      scale: ["#1b3a28", "#1f5a39", "#178a45", "#19b04f", "#1ed760"],
      hero: { stops: ["#1ed760", "#19bd55", "#14a64b"], kicker: "#03280f", title: "#000", sub: "#0b4a25", lead: "#04230f" },
    });
    expect(THEMES.default.kicker).toBeNull();
    expect(THEMES.default.ornament).toBeNull();
  });

  it("only swaps accents and the hero, never the surfaces", () => {
    for (const id of THEME_IDS) {
      const { accent, accentDim, onAccent, scale, hero, ...surfaces } = tokensFor(id);
      const { accent: _a, accentDim: _d, onAccent: _o, scale: _s, hero: _h, ...fixed } = tokensFor("default");
      expect(surfaces).toEqual(fixed);
    }
    expect(tokensFor("halloween").accent).toBe("#ff8a1f");
  });

  it("picks the season from the period's last day", () => {
    const day = (month: number, d: number) => ({ year: 2026, month, day: d });
    // Months, by their last day
    expect(seasonalTheme(day(10, 31))).toBe("halloween");
    expect(seasonalTheme(day(11, 30))).toBe("default");
    expect(seasonalTheme(day(12, 31))).toBe("winter-holidays");
    expect(seasonalTheme(day(1, 31))).toBe("new-year");
    expect(seasonalTheme(day(7, 31))).toBe("summer");
    expect(seasonalTheme(day(9, 30))).toBe("default");
    // Weeks, by their Sunday
    expect(seasonalTheme(day(10, 25))).toBe("halloween");
    expect(seasonalTheme(day(11, 1))).toBe("halloween");
    expect(seasonalTheme(day(11, 8))).toBe("default");
    expect(seasonalTheme(day(12, 6))).toBe("winter-holidays");
    // Edges are inclusive
    expect(seasonalTheme(day(10, 14))).toBe("default");
    expect(seasonalTheme(day(10, 15))).toBe("halloween");
    expect(seasonalTheme(day(6, 20))).toBe("default");
    expect(seasonalTheme(day(6, 21))).toBe("summer");
    expect(seasonalTheme(day(8, 31))).toBe("summer");
    expect(seasonalTheme(day(9, 1))).toBe("default");
  });

  it("offers default plus the seasonal theme", () => {
    expect(themeOptions({ year: 2026, month: 10, day: 31 })).toEqual([
      { id: "default", label: "Spotify green", mood: "neutral" },
      { id: "halloween", label: "Pumpkin", mood: "spooky, playful" },
    ]);
    expect(themeOptions({ year: 2026, month: 9, day: 30 })).toEqual([{ id: "default", label: "Spotify green", mood: "neutral" }]);
  });
});
