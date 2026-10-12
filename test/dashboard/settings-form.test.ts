// public/settings-form.js: which controls count as changed (the save bar shows only then). The
// script's DOM wiring is a no-op here (no document); controls are plain objects with the DOM's
// default* properties.

import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module (served as-is from public/) without type declarations
import { changed } from "../../public/settings-form.js";

describe("changed", () => {
  it("compares checkboxes, selects and text fields with the values the page loaded with", () => {
    expect(changed({ type: "checkbox", checked: true, defaultChecked: true })).toBe(false);
    expect(changed({ type: "checkbox", checked: false, defaultChecked: true })).toBe(true);
    const select = (selected: boolean[], loaded: boolean[]) => ({ tagName: "SELECT", type: "select-one", options: selected.map((s, i) => ({ selected: s, defaultSelected: loaded[i] })) });
    expect(changed(select([true, false], [true, false]))).toBe(false);
    expect(changed(select([false, true], [true, false]))).toBe(true);
    expect(changed({ type: "number", value: "5", defaultValue: "5" })).toBe(false);
    expect(changed({ type: "number", value: "7", defaultValue: "5" })).toBe(true);
  });

  it("never counts hidden inputs or buttons", () => {
    expect(changed({ type: "hidden", value: "true", defaultValue: "false" })).toBe(false);
    for (const type of ["submit", "button", "reset"]) expect(changed({ type, value: "x", defaultValue: "y" })).toBe(false);
  });
});
