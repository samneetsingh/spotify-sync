// The settings page's save bar (src/dashboard/settings.tsx): hidden until a setting differs from the
// value the page loaded with, so "Save changes" only shows when there's something to save. Without
// this script the bar always shows; after a refused save (data-always) it stays. `changed` is
// exported for tests.

/** Whether a form control differs from the value the page loaded with (hidden inputs and buttons never do). */
export function changed(el) {
  if (el.type === "checkbox" || el.type === "radio") return el.checked !== el.defaultChecked;
  if (el.tagName === "SELECT") return [...el.options].some((o) => o.selected !== o.defaultSelected);
  if (["hidden", "submit", "button", "reset"].includes(el.type)) return false;
  return typeof el.defaultValue === "string" && el.value !== el.defaultValue;
}

const form = typeof document === "undefined" ? null : document.getElementById("settings");
const bar = typeof document === "undefined" ? null : document.getElementById("savebar");
if (form && bar && !bar.hasAttribute("data-always")) {
  // form.elements includes the controls outside the form (form="settings"), whose events don't
  // bubble through it, so listen on the document.
  const update = () => {
    bar.hidden = ![...form.elements].some(changed);
  };
  document.addEventListener("input", update);
  document.addEventListener("change", update);
  window.addEventListener("pageshow", update); // the browser may restore edited values on Back
  update();
}
