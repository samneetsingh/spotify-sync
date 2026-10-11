// The editor's input for a loaded digest: the facts, the highlights (the only extra queries), the
// section catalog, the themes this period allows and the copy the email uses without the editor.

import { digestCopy, sectionSpecs } from "../email/sections";
import { seasonalTheme, themeOptions } from "../email/themes";
import type { DigestData } from "../jobs/digest";
import { addDays } from "../utils/time";
import { buildFacts } from "./facts";
import { loadHighlights } from "./highlights";
import type { EditorInput } from "./types";

export async function buildEditorInput(db: D1Database, data: DigestData, timeZone: string): Promise<EditorInput> {
  const { kind } = data.period;
  const lastDay = addDays(data.period.end, -1);
  const copy = digestCopy(data);
  return {
    kind,
    facts: buildFacts(data),
    highlights: await loadHighlights(db, kind, data.period, timeZone, data),
    specs: sectionSpecs(kind, data),
    themes: themeOptions(lastDay),
    defaultTheme: seasonalTheme(lastDay),
    // The default hero has no headline line; its title reads "September 2026" / "Sep 28 to Oct 4".
    defaults: { headline: copy.label, lead: copy.lead, preheader: copy.preheader },
  };
}
