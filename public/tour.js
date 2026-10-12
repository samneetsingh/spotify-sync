// The dashboard's guided tour: the page dims except for a spotlight on one part of it, with a card
// beside it (a title, a line, "3 of 10", Back / Next / Skip). It starts on Home while the owner
// hasn't finished it (the page's #tour-data says so), or with ?tour=<step> ("Take the tour again" in
// Settings, and carrying on between pages): Home, then Settings, then back Home to finish. Steps
// whose part isn't on the page (e.g. the charts before the first plays) are skipped. On Settings,
// every tour button (and key) first saves whatever the owner changed: "Saved" shows in the card, or
// the reason it was refused (the tour then stays put). Finishing or skipping posts /welcome/done, so
// it doesn't start again. Esc skips; the arrow keys go back and forward. Without this script there's
// simply no tour. `STEPS` and `place` are exported for tests.

export const STEPS = [
  { page: "/", title: "Welcome", text: "Here's a quick look around your music dashboard." },
  { page: "/", target: ".hero", title: "Your song of the week", text: "The track you've had on repeat, front and center." },
  { page: "/", target: ".home-sofar", title: "This week and month", text: "How much you've listened, next to the same point last time." },
  { page: "/", target: ".home-days", title: "Year over year", text: "Your listening next to past years. Tap a year under the chart to show or hide it." },
  { page: "/", target: ".home-hours", title: "When you listen", text: "Your busiest days and hours at a glance." },
  { page: "/settings", target: ".group-playlists", title: "Your playlists", text: "Switch on the playlists you want. Your choices are saved when you move on." },
  { page: "/settings", target: ".group-emails", title: "Your emails", text: "A weekly digest and a monthly recap. Send yourself a preview anytime." },
  {
    page: "/settings",
    target: "#import",
    title: "Your full history",
    text: "Bring in everything you've ever played: request your data from Spotify, then upload it here. Now or anytime.",
    link: { href: "https://www.spotify.com/account/privacy/", label: "Request it from Spotify" },
  },
  { page: "/settings", target: "#s-advanced", title: "Want more?", text: "Advanced adds your activity log, alerts, time zone and account controls." },
  { page: "/", title: "You're all set", text: "Enjoy your music. Your playlists fill in as you listen." },
];

const GAP = 14;
const EDGE = 16;
/** Below this width the card is a bottom sheet. */
const SHEET_BELOW = 640;

/**
 * Where the card goes for a target `rect` (viewport px; null = no target) in a `view`: centred
 * without a target, a bottom sheet on narrow screens, else below the target if it fits, above,
 * to the right, to the left, or the bottom-right corner. Returns the card's top-left and its mode.
 */
export function place(rect, card, view) {
  if (!rect) return { mode: "center", left: Math.max(EDGE, (view.width - card.width) / 2), top: Math.max(EDGE, (view.height - card.height) / 2) };
  if (view.width < SHEET_BELOW) return { mode: "sheet", left: EDGE, top: view.height - card.height - EDGE };
  const clampX = (x) => Math.min(Math.max(EDGE, x), view.width - card.width - EDGE);
  const clampY = (y) => Math.min(Math.max(EDGE, y), view.height - card.height - EDGE);
  if (rect.bottom + GAP + card.height <= view.height - EDGE) return { mode: "below", left: clampX(rect.left), top: rect.bottom + GAP };
  if (rect.top - GAP - card.height >= EDGE) return { mode: "above", left: clampX(rect.left), top: rect.top - GAP - card.height };
  if (rect.right + GAP + card.width <= view.width - EDGE) return { mode: "right", left: rect.right + GAP, top: clampY(rect.top) };
  if (rect.left - GAP - card.width >= EDGE) return { mode: "left", left: rect.left - GAP - card.width, top: clampY(rect.top) };
  return { mode: "corner", left: view.width - card.width - EDGE, top: view.height - card.height - EDGE };
}

/**
 * On Settings, saves the settings form if the owner changed anything (the save bar shows then). On
 * success the loaded values become the saved ones (the save bar hides) and it returns { saved };
 * a refused save returns { error } with the page's first error line.
 */
async function saveChanges() {
  const form = document.getElementById("settings");
  const bar = document.getElementById("savebar");
  if (location.pathname !== "/settings" || !form || !bar || bar.hidden) return {};
  const res = await fetch(form.action, { method: "POST", body: new FormData(form), redirect: "manual", credentials: "same-origin" }).catch(() => null);
  if (res && (res.type === "opaqueredirect" || res.ok)) {
    for (const el of form.elements) {
      if (el.type === "checkbox" || el.type === "radio") el.defaultChecked = el.checked;
      else if (el.tagName === "SELECT") for (const o of el.options) o.defaultSelected = o.selected;
      else if (el.type !== "hidden" && "defaultValue" in el) el.defaultValue = el.value;
    }
    document.dispatchEvent(new Event("change")); // settings-form.js hides the save bar
    return { saved: true };
  }
  let error = "Your changes couldn't be saved. Try again, or use Save changes at the bottom.";
  if (res) {
    try {
      const item = new DOMParser().parseFromString(await res.text(), "text/html").querySelector("#errors li");
      if (item) error = item.textContent.trim();
    } catch {}
  }
  return { error };
}

function start(first, name) {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const root = document.createElement("div");
  root.className = "tour";
  root.innerHTML = `<div class="tour-spot"></div>
<div class="tour-card" role="dialog" aria-labelledby="tour-title" aria-describedby="tour-text">
  <div class="tour-bar"><span></span></div>
  <p class="tour-count"></p>
  <h2 id="tour-title"></h2>
  <p id="tour-text" aria-live="polite"></p>
  <a class="tour-link" target="_blank" rel="noopener noreferrer"></a>
  <p class="tour-note" role="status" hidden></p>
  <div class="tour-actions">
    <button type="button" class="tour-skip">Skip tour</button>
    <button type="button" class="btn btn-secondary btn-small tour-back">Back</button>
    <button type="button" class="btn btn-primary btn-small tour-next">Next</button>
  </div>
</div>`;
  document.body.append(root);
  const $ = (sel) => root.querySelector(sel);
  const spot = $(".tour-spot");
  const card = $(".tour-card");
  let index = first;
  let target = null;
  let frame = 0;
  let busy = false;
  let savedHere = false;
  const note = $(".tour-note");

  const position = () => {
    const r = target ? target.getBoundingClientRect() : null;
    const pad = 8;
    if (r) Object.assign(spot.style, { top: `${r.top - pad}px`, left: `${r.left - pad}px`, width: `${r.width + 2 * pad}px`, height: `${r.height + 2 * pad}px`, opacity: "1" });
    else Object.assign(spot.style, { top: "50%", left: "50%", width: "0px", height: "0px" });
    const p = place(r && { top: r.top, bottom: r.bottom, left: r.left, right: r.right }, { width: card.offsetWidth, height: card.offsetHeight }, { width: innerWidth, height: innerHeight });
    card.dataset.mode = p.mode;
    Object.assign(card.style, { left: `${p.left}px`, top: `${p.top}px` });
  };
  const queue = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(position);
  };

  const finish = (saved = savedHere) => {
    removeEventListener("scroll", queue, true);
    removeEventListener("resize", queue);
    document.removeEventListener("keydown", keys);
    root.classList.add("is-leaving");
    setTimeout(() => root.remove(), reduce ? 0 : 250);
    const url = new URL(location.href);
    url.searchParams.delete("tour");
    history.replaceState(null, "", url);
    const done = fetch("/welcome/done", { method: "POST", body: new URLSearchParams({ then: "home" }), redirect: "manual", credentials: "same-origin" }).catch(() => {});
    // Saved from the tour on Settings: reload so each setting's source and Reset are current.
    if (saved && location.pathname === "/settings") done.then(() => location.replace(url.pathname));
  };

  /** Shows step `i`, going on in `dir` past steps whose part isn't on this page, or to the step's page. */
  const show = (i, dir) => {
    for (; i >= 0 && i < STEPS.length; i += dir) {
      const step = STEPS[i];
      if (step.page !== location.pathname) {
        location.href = `${step.page}?tour=${i}`;
        return;
      }
      const el = step.target ? document.querySelector(step.target) : null;
      if (step.target && !el) continue;
      index = i;
      target = el;
      $(".tour-count").textContent = `${i + 1} of ${STEPS.length}`;
      $(".tour-bar span").style.width = `${((i + 1) / STEPS.length) * 100}%`;
      $("#tour-title").textContent = i === 0 && name ? `Welcome, ${name}` : step.title;
      $("#tour-text").textContent = step.text;
      const link = $(".tour-link");
      link.hidden = !step.link;
      if (step.link) Object.assign(link, { href: step.link.href, textContent: step.link.label });
      $(".tour-back").hidden = i === 0;
      $(".tour-next").textContent = i === 0 ? "Show me around" : i === STEPS.length - 1 ? "Done" : "Next";
      $(".tour-skip").hidden = i === STEPS.length - 1;
      card.classList.remove("is-in");
      note.hidden = true;
      if (el) {
        const r = el.getBoundingClientRect();
        const tall = r.height > innerHeight * 0.6 || innerWidth < SHEET_BELOW;
        el.scrollIntoView({ block: tall ? "start" : "center", behavior: reduce ? "auto" : "smooth" });
      }
      position();
      setTimeout(() => {
        position();
        card.classList.add("is-in");
        $(".tour-next").focus({ preventScroll: true });
      }, el && !reduce ? 450 : 0);
      return;
    }
    finish();
  };

  /** Every tour action saves the owner's changes first; a refused save keeps the tour on this step and says why. */
  const act = async (then) => {
    if (busy) return;
    busy = true;
    root.classList.add("is-busy");
    const result = await saveChanges();
    busy = false;
    root.classList.remove("is-busy");
    if (result.error) {
      Object.assign(note, { hidden: false, textContent: result.error, className: "tour-note is-error" });
      queue();
      return;
    }
    if (result.saved) {
      savedHere = true;
      Object.assign(note, { hidden: false, textContent: "Saved", className: "tour-note is-ok" });
      if (location.pathname === "/settings" && STEPS[index + 1]?.page === "/settings" && then !== "finish") await new Promise((r) => setTimeout(r, reduce ? 0 : 600));
    }
    if (then === "finish") finish();
    else show(then === "next" ? index + 1 : index - 1, then === "next" ? 1 : -1);
  };
  const keys = (e) => {
    if (e.key === "Escape") act("finish");
    else if (e.target.closest && e.target.closest("input, select, textarea")) return;
    else if (e.key === "ArrowRight") act(index === STEPS.length - 1 ? "finish" : "next");
    else if (e.key === "ArrowLeft" && index > 0) act("back");
  };
  $(".tour-next").addEventListener("click", () => act(index === STEPS.length - 1 ? "finish" : "next"));
  $(".tour-back").addEventListener("click", () => act("back"));
  $(".tour-skip").addEventListener("click", () => act("finish"));
  addEventListener("scroll", queue, true);
  addEventListener("resize", queue);
  document.addEventListener("keydown", keys);
  requestAnimationFrame(() => root.classList.add("is-on"));
  show(first, 1);
}

if (typeof document !== "undefined") {
  const data = document.getElementById("tour-data");
  const asked = new URLSearchParams(location.search).get("tour");
  const first = asked !== null ? Number(asked) : data?.dataset.auto === "1" && location.pathname === "/" ? 0 : NaN;
  if (data && Number.isInteger(first) && first >= 0 && first < STEPS.length) start(first, data.dataset.name ?? "");
}
