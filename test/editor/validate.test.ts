import { describe, expect, it } from "vitest";
import { LIMITS } from "../../src/editor/prompt";
import type { EditorInput } from "../../src/editor/types";
import { allowedNumbers, numbersIn, validatePlan } from "../../src/editor/validate";
import { monthInput, monthSpecs, validPlan, weekInput } from "./fixtures";

type Mutable = { [k: string]: any };

/** "ok" or the rejection reason for validPlan() after `edit`. */
function verdict(edit: (p: Mutable) => void = () => {}, input: EditorInput = monthInput()): string {
  const plan = structuredClone(validPlan()) as Mutable;
  edit(plan);
  const result = validatePlan(plan, input);
  return result.ok ? "ok" : result.reason;
}
const section = (p: Mutable, id: string) => p.sections.find((s: Mutable) => s.id === id);
const setInsight = (id: string, text: string | null) => (p: Mutable) => (section(p, id).insight = text);

describe("validatePlan", () => {
  it("resolves a valid plan: trims copy, attaches highlights, fills and drops insights", () => {
    const raw = structuredClone(validPlan()) as Mutable;
    raw.headline = "  Espresso all October ";
    section(raw, "song").insight = "<b>ignored</b> 1,600"; // no insight slot: dropped without checks
    const result = validatePlan(raw, monthInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { plan } = result;
    expect(plan.theme).toBe("halloween");
    expect(plan.headline).toBe("Espresso all October");
    expect(plan.sections.map((s) => s.id)).toEqual(validPlan().sections.map((s) => s.id));
    expect(plan.sections[0]!.highlight?.kind).toBe("streak");
    expect(plan.sections[1]).toEqual({ id: "song", heading: "Song of the month", insight: null });
    const comeback = plan.sections.find((s) => s.id === "hl:comebackTrack")!;
    expect(comeback.insight).toBe("**Yellow** is back: 9 plays, last heard in May 2024."); // the highlight's default
    expect(plan.sections.find((s) => s.id === "sound")!.insight).toBe("Pop took **38%** of your plays.");
    expect(plan.sections.find((s) => s.id === "sound")!.highlight).toBeUndefined();
  });

  it("treats an empty insight on a slot as no insight", () => {
    const result = validatePlan({ ...validPlan(), sections: validPlan().sections.map((s) => (s.id === "sound" ? { ...s, insight: "  " } : s)) }, monthInput());
    expect(result.ok && result.plan.sections.find((s) => s.id === "sound")!.insight).toBeNull();
  });

  describe("1. shape", () => {
    it.each<[string, (p: Mutable) => void, string]>([
      ["missing key", (p) => delete p.preheader, "shape: preheader"],
      ["extra key", (p) => (p.subject = "Hi"), "shape: subject"],
      ["wrong type", (p) => (p.headline = 5), "shape: headline"],
      ["empty sections", (p) => (p.sections = []), "shape: sections"],
      ["sections not an array", (p) => (p.sections = {}), "shape: sections"],
      ["section not an object", (p) => (p.sections[1] = "song"), "shape: sections[1]"],
      ["section extra key", (p) => (p.sections[2].note = "x"), "shape: sections[2].note"],
      ["section missing insight", (p) => delete p.sections[1].insight, "shape: sections[1].insight"],
      ["insight wrong type", (p) => (p.sections[2].insight = 5), "shape: sections[2].insight"],
      ["id wrong type", (p) => (p.sections[0].id = 1), "shape: sections[0].id"],
    ])("%s", (_name, edit, reason) => {
      expect(verdict(edit)).toBe(reason);
    });

    it("rejects non-objects", () => {
      for (const raw of [null, "plan", [validPlan()], 5]) expect(validatePlan(raw, monthInput())).toEqual({ ok: false, reason: "shape: plan" });
    });
  });

  it("2. theme must be offered this period", () => {
    expect(verdict((p) => (p.theme = "summer"))).toBe("theme not allowed: summer");
    expect(verdict((p) => (p.theme = "default"))).toBe("ok");
  });

  describe("3. sections", () => {
    it("rejects duplicates, unavailable, unknown and unoffered highlight ids", () => {
      expect(verdict((p) => p.sections.push({ id: "dayByDay", heading: "Again", insight: null }))).toBe("duplicate section: dayByDay");
      expect(verdict((p) => p.sections.push({ id: "throwback", heading: "Throwbacks", insight: null }))).toBe("unavailable section: throwback");
      expect(verdict((p) => p.sections.push({ id: "week", heading: "Your week", insight: null }))).toBe("unavailable section: week");
      expect(verdict((p) => p.sections.push({ id: "hl:genreShift", heading: "New sound", insight: null }))).toBe("unavailable section: hl:genreShift");
    });

    it("requires every required, available section", () => {
      expect(verdict((p) => (p.sections = p.sections.filter((s: Mutable) => s.id !== "topArtists")))).toBe("missing required section: topArtists");
      const input = monthInput();
      input.specs.find((s) => s.id === "topArtists")!.available = false;
      expect(verdict((p) => (p.sections = p.sections.filter((s: Mutable) => s.id !== "topArtists")), input)).toBe("ok");
    });

    it("puts song first or second", () => {
      expect(verdict((p) => p.sections.unshift(p.sections.splice(1, 1)[0]))).toBe("ok"); // song first
      expect(verdict((p) => p.sections.splice(2, 0, p.sections.splice(1, 1)[0]))).toBe("song position: 2");
    });

    it("caps highlights and sections per kind", () => {
      const hl = (id: string) => ({ id, heading: "Late nights", insight: null });
      expect(verdict((p) => p.sections.push(hl("hl:lateNight")))).toBe("ok");
      expect(verdict((p) => p.sections.push(hl("hl:lateNight"), hl("hl:binge")))).toBe("too many highlights: 4");
      expect(verdict((p) => p.sections.push(hl("hl:lateNight")), weekInput())).toBe("unavailable section: sound");
      const week = (p: Mutable) => (p.sections = p.sections.filter((s: Mutable) => !["sound", "dayByDay"].includes(s.id)));
      expect(verdict(week, weekInput())).toBe("ok");
      expect(verdict((p) => (week(p), p.sections.push(hl("hl:lateNight"))), weekInput())).toBe("too many highlights: 3");

      const input = monthInput();
      input.specs.find((s) => s.id === "throwback")!.available = true;
      const all = (p: Mutable) => {
        const extra = ["whenYouListen", "year", "welcomeBack", "throwback"].map((id) => ({ id, heading: "More", insight: null }));
        p.sections.push(...extra, hl("hl:lateNight"));
      };
      expect(LIMITS.maxSections.month).toBe(13);
      expect(verdict(all, input)).toBe("ok"); // every monthly section plus 3 highlights fits

      const allWeek = (p: Mutable) => (week(p), p.sections.push(...["week", "timeOfDay"].map((id) => ({ id, heading: "More", insight: null }))));
      expect(LIMITS.maxSections.week).toBe(8);
      expect(verdict(allWeek, weekInput())).toBe("ok"); // every weekly section plus 2 highlights fits
      // A catalog bigger than the limit allows (never the case for real digests) still trips the cap.
      expect(verdict((p) => p.sections.push(hl("hl:lateNight")), { ...weekInput(), specs: monthSpecs() })).toBe("too many highlights: 3");
      expect(verdict((p) => p.sections.push({ id: "whenYouListen", heading: "More", insight: null }), { ...weekInput(), specs: monthSpecs() })).toBe("too many sections: 9");
    });
  });

  describe("4. copy", () => {
    it.each<[string, (p: Mutable) => void, string]>([
      ["empty headline", (p) => (p.headline = "   "), "copy: headline empty"],
      ["empty heading", (p) => (section(p, "song").heading = ""), "copy: heading song empty"],
      ["long headline", (p) => (p.headline = "x".repeat(LIMITS.headline + 1)), "copy: headline too long (29 > 28)"],
      ["long insight", setInsight("sound", "x".repeat(LIMITS.insight + 1)), "copy: insight sound too long (161 > 160)"],
      ["newline", (p) => (p.lead = "Espresso.\nAgain."), "copy: lead control character"],
      ["tag", (p) => (p.preheader = "Open <b>now</b>"), 'copy: preheader contains "<"'],
      ["brace", setInsight("sound", "Pop {38%}"), 'copy: insight sound contains "{"'],
      ["backtick", setInsight("sound", "Pop `38%`"), 'copy: insight sound contains "`"'],
      ["link", (p) => (p.lead = "See HTTPS://example.com"), 'copy: lead contains "http"'],
      ["www", (p) => (p.lead = "See www.example.com"), 'copy: lead contains "www."'],
      ["mention", setInsight("newToYou", "Say hi to @chappell"), 'copy: insight newToYou contains "@"'],
      ["hashtag", setInsight("newToYou", "#newmusic"), 'copy: insight newToYou contains "#"'],
      ["emoji", setInsight("sound", "Pop all month 🎃"), "copy: insight sound emoji"],
      ["bold outside insights", (p) => (p.headline = "**Espresso**"), "copy: headline bold"],
      ["bold heading", (p) => (section(p, "sound").heading = "Your **sound**"), "copy: heading sound bold"],
      ["three bold phrases", setInsight("sound", "**a** and **b** and **c**"), "copy: insight sound bold"],
      ["unbalanced bold", setInsight("sound", "**Pop took over"), "copy: insight sound bold"],
      ["empty bold", setInsight("sound", "Pop ** ** took over"), "copy: insight sound bold"],
      ["nested bold", setInsight("sound", "***Pop*** took over"), "copy: insight sound bold"],
      ["italics", setInsight("sound", "*Pop* took over"), "copy: insight sound bold"],
    ])("rejects %s", (_name, edit, reason) => {
      expect(verdict(edit)).toBe(reason);
    });

    it("allows two bold phrases and doesn't count the markers toward the limit", () => {
      expect(verdict(setInsight("sound", "**Pop** and **k-pop** led."))).toBe("ok");
      expect(verdict(setInsight("sound", `**${"x".repeat(LIMITS.insight - 2)}** a`))).toBe("ok");
    });

    it("allows song titles in curly quotes and curly apostrophes", () => {
      const quoted = (p: Mutable) => {
        p.lead = "“Espresso” by Sabrina Carpenter was your song of the month, and “Two Weeks” wasn’t far behind.";
        p.headline = "“Espresso” all October";
        section(p, "sound").insight = "**“The Feels”** kept k-pop close.";
      };
      expect(verdict(quoted)).toBe("ok");
      // Number words inside a quoted title are part of the name, not a claim.
      expect(verdict((p) => (p.lead = "“Seventeen Going Under” and “Two Weeks” stayed close."))).toBe("ok");
    });
  });

  describe("5. number guard", () => {
    const lead = (text: string) => verdict((p) => (p.lead = text));
    const sound = (text: string) => verdict(setInsight("sound", text));

    it("allows numbers from the input, with or without separators", () => {
      expect(lead("1,564 plays in October 2026.")).toBe("ok");
      expect(lead("1564 plays this month.")).toBe("ok");
      expect(lead("About 1,600 plays this month.")).toBe("number: lead 1,600");
      expect(lead("Your 412 songs.")).toBe("ok");
      expect(lead("Your 413 songs.")).toBe("number: lead 413");
    });

    it("only allows percentages that are percentages in the input", () => {
      expect(sound("Plays were down 48% on September.")).toBe("ok");
      expect(sound("Plays were down 48 percent.")).toBe("ok");
      expect(sound("Pop took 50% of your plays.")).toBe("number: insight sound 50");
      expect(sound("87% of it on a Friday.")).toBe("percent: insight sound 87%"); // 87 is a play count
    });

    it("allows digits inside names and labels", () => {
      expect(sound("Lots of 5 Seconds of Summer.")).toBe("ok");
      expect(sound("Mondays around 11 PM, as usual.")).toBe("ok");
      expect(sound("Friday, October 16 was the peak.")).toBe("ok");
    });

    it("checks number words, including compounds", () => {
      expect(sound("Three songs did the heavy lifting.")).toBe("ok");
      expect(sound("Nineteen songs did the heavy lifting.")).toBe("number word: insight sound Nineteen");
      expect(sound("Fifty new artists.")).toBe("number word: insight sound Fifty");
      expect(sound("A dozen new artists.")).toBe("ok"); // 12 is the hours change
      expect(sound("One song above all.")).toBe("ok"); // "one" is not policed
    });

    it("lets highlight numbers through only when the highlight is featured", () => {
      expect(verdict()).toBe("ok"); // "Twenty-two days straight" with hl:streak picked
      const withoutStreak = (text: string) =>
        verdict((p) => {
          p.sections = p.sections.filter((s: Mutable) => s.id !== "hl:streak");
          section(p, "dayByDay").insight = text;
        });
      expect(withoutStreak("You listened 22 days in a row.")).toBe("number: insight dayByDay 22");
      expect(withoutStreak("You listened twenty-two days in a row.")).toBe("number word: insight dayByDay twenty-two");
      expect(withoutStreak("Late nights were 4% of plays.")).toBe("percent: insight dayByDay 4%"); // lateNight's sharePct
      const swap = (heading: string) =>
        verdict((p) => {
          Object.assign(section(p, "hl:streak"), { id: "hl:lateNight", heading, insight: null });
          section(p, "dayByDay").insight = "Late nights were 4% of plays.";
        });
      expect(swap("Night owl")).toBe("ok");
      expect(swap("Twenty-two nights")).toBe("number word: heading hl:lateNight Twenty-two"); // the streak's number left with it
    });

    it("rejects ratio words but not names that contain them", () => {
      expect(sound("Pop played twice as much as k-pop.")).toBe("ratio: insight sound twice");
      expect(sound("K-pop doubled.")).toBe("ratio: insight sound doubled");
      expect(sound("Half of it was pop.")).toBe("ratio: insight sound Half");
      expect(sound("TWICE kept coming back.")).toBe("ok");
      expect(sound("Two Weeks and The Feels by TWICE.")).toBe("ok");
      expect(sound("Seventeen Going Under stuck around.")).toBe("ok");
      expect(sound("Seventeen days of Sam Fender.")).toBe("number word: insight sound Seventeen");
    });

    it("never treats scores or ids as citable", () => {
      const allowed = allowedNumbers(monthInput(), monthInput().highlights);
      expect(allowed.numbers.has(0.73)).toBe(false); // streak score
      expect(allowed.numbers.has(48271)).toBe(false); // digits in a track id
      expect(allowed.numbers.has(4.5)).toBe(true);
      expect(allowed.pcts.has(4)).toBe(true); // lateNight sharePct
      expect(allowed.pcts.has(87)).toBe(false);
      expect(sound("Scored 0.73 by the editor.")).toBe("number: insight sound 0.73");
    });

    it("finds digit tokens", () => {
      expect(numbersIn("1,564 plays, 4.5 hours, Sep 1, 2025.")).toEqual([
        { raw: "1,564", value: 1564 },
        { raw: "4.5", value: 4.5 },
        { raw: "1", value: 1 },
        { raw: "2025", value: 2025 },
      ]);
    });
  });
});
