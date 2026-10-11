// The settings page, rendered from the registry (src/settings.ts): one fieldset per group, each
// control with its description, where its value comes from (with Reset for dashboard changes), and
// the Liked Songs confirmation. The form follows saveSettings' encoding (see src/settings.ts):
// booleans post a hidden "false" then the checkbox "true", `confirm_<key>=yes` acknowledges a
// `confirmOn` warning, and Reset posts only `reset=<key>` from its own form.

import type { Session } from "../auth";
import { esc } from "../email/layout";
import type { Env } from "../env";
import {
  SETTING_DEFS,
  SETTING_GROUPS,
  confirmField,
  type EffectiveSettings,
  type SettingDef,
  type SettingKey,
  type SettingSource,
} from "../settings";
import { ui } from "./layout";

export interface SettingsView {
  session: Session;
  settings: EffectiveSettings;
  env: Env;
  /** After a refused save: the posted form (shown again so nothing is lost) and the errors per key. */
  submitted?: FormData;
  errors?: Partial<Record<SettingKey, string>>;
  /** First visit after the claim: the "your first sync runs within 10 minutes" banner. */
  welcome?: boolean;
}

const SOURCE_LABEL: Record<SettingSource, string> = { dashboard: "Changed here", deploy: "From deploy config", default: "Default" };

/** IANA zones for the select, grouped by region ("America", "Europe", ...), with UTC first. */
function timeZones(current: string): Map<string, string[]> {
  const zones = new Set(typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []);
  zones.delete("UTC");
  zones.add(current);
  const groups = new Map<string, string[]>([["UTC", ["UTC"]]]);
  for (const z of [...zones].sort()) {
    if (z === "UTC") continue;
    const region = z.includes("/") ? z.slice(0, z.indexOf("/")) : "Other";
    groups.set(region, [...(groups.get(region) ?? []), z]);
  }
  return groups;
}

/** The value to show: what was just posted (after a refused save), else the effective value. */
function shown(v: SettingsView, def: SettingDef): string | boolean {
  if (v.submitted?.has(def.key)) {
    const posted = v.submitted.getAll(def.key).at(-1);
    return def.type === "boolean" ? posted === "true" : String(posted ?? "");
  }
  const value = v.settings.values[def.key];
  return def.type === "boolean" ? value === true : String(value);
}

function metaRow(v: SettingsView, def: SettingDef): string {
  const source = v.settings.source[def.key];
  const reset =
    source === "dashboard"
      ? `<button type="submit" form="reset-${def.key}" class="btn btn-small" aria-label="Reset ${esc(def.label)}">Reset</button>`
      : "";
  return `<div class="meta-row"><span class="source source-${source}">${SOURCE_LABEL[source]}</span>${reset}</div>`;
}

/** A refused save's message for `def`; a missing confirmation points at the box right below. */
function errorFor(v: SettingsView, def: SettingDef): string | undefined {
  const error = v.errors?.[def.key];
  if (!error || !def.confirmOn) return error;
  const wantsOn = v.submitted?.getAll(def.key).at(-1) === "true";
  return wantsOn && v.submitted?.get(confirmField(def.key)) !== "yes" ? "Tick “I understand” below to turn this on." : error;
}

function control(v: SettingsView, def: SettingDef): string {
  const id = `f-${def.key}`;
  const error = errorFor(v, def);
  const describedBy = `d-${def.key}${error ? ` e-${def.key}` : ""}`;
  const invalid = error ? ' aria-invalid="true"' : "";
  const errorHtml = error ? `<p class="field-error" id="e-${def.key}">${esc(error)}</p>` : "";
  const desc = `<p class="desc" id="d-${def.key}">${esc(def.description)}</p>`;
  const forced = def.force?.(v.env);

  if (forced !== undefined) {
    // Fixed by the deploy (e.g. the AI editor without a key): nothing to post.
    return `<div class="setting field" id="s-${def.key}"><label>${esc(def.label)}</label>${desc}<p class="desc">Fixed by the deploy: ${esc(String(forced === true ? "on" : forced === false ? "off" : forced))}.</p></div>`;
  }

  if (def.type === "boolean") {
    const checked = shown(v, def) === true;
    const effective = v.settings.values[def.key] === true;
    // Switching on needs an explicit acknowledgement; shown when the box is ticked (or always, without :has).
    const confirm =
      def.confirmOn && !effective
        ? (() => {
            const ack = v.submitted?.get(confirmField(def.key)) === "yes";
            return `<div class="confirm${error ? " invalid" : ""}" id="c-${def.key}"><p><strong>Before you turn this on</strong></p><p>${esc(def.confirmOn)}</p><label><input type="checkbox" name="${confirmField(def.key)}" value="yes"${ack ? " checked" : ""}> I understand. Turn it on.</label></div>`;
          })()
        : "";
    return `<div class="setting${def.confirmOn ? " gated" : ""}" id="s-${def.key}"><div class="control"><input type="hidden" name="${def.key}" value="false"><input class="toggle" type="checkbox" id="${id}" name="${def.key}" value="true" aria-describedby="${describedBy}"${checked ? " checked" : ""}${invalid}></div><label for="${id}">${esc(def.label)}</label>${desc}${metaRow(v, def)}${errorHtml}${confirm}</div>`;
  }

  const value = String(shown(v, def));
  let input: string;
  if (def.type === "integer") {
    const bounds = `${def.min !== undefined ? ` min="${def.min}"` : ""}${def.max !== undefined ? ` max="${def.max}"` : ""}`;
    input = `<input type="number" inputmode="numeric" step="1" id="${id}" name="${def.key}" value="${esc(value)}"${bounds} required aria-describedby="${describedBy}"${invalid}>`;
  } else {
    const groups = timeZones(value);
    const options = [...groups]
      .map(([region, zones]) => {
        const opts = zones.map((z) => `<option value="${esc(z)}"${z === value ? " selected" : ""}>${esc(z.replaceAll("_", " "))}</option>`).join("");
        return region === "UTC" ? opts : `<optgroup label="${esc(region)}">${opts}</optgroup>`;
      })
      .join("");
    input = `<select id="${id}" name="${def.key}" aria-describedby="${describedBy}"${invalid}>${options}</select>`;
  }
  return `<div class="setting field" id="s-${def.key}"><label for="${id}">${esc(def.label)}</label>${desc}${input}${metaRow(v, def)}${errorHtml}</div>`;
}

function accountCard(session: Session): string {
  const name = session.displayName ? `${esc(session.displayName)}<span class="sub">${esc(session.spotifyId)}</span>` : esc(session.spotifyId);
  return ui.card(
    "Account",
    `${ui.factsHtml([["Spotify account", name]])}<p class="note">Reconnect if Spotify asks you to log in again; only your account is accepted. Log out everywhere ends the dashboard on every device.</p>`,
    {
      id: "account",
      actionsHtml: `${ui.linkButton("/login?next=%2Fsettings", "Reconnect Spotify")}${ui.postButton("/logout", "Log out")}${ui.postButton("/logout/all", "Log out everywhere", { variant: "danger" })}`,
    },
  );
}

export function settingsBody(v: SettingsView): string {
  const parts: string[] = [];
  if (v.welcome) {
    parts.push(`<div class="notice notice-ok" role="status"><strong>You're connected.</strong> Your first sync runs within 10 minutes with these settings. Change anything now or later.</div>`);
  }
  if (v.settings.problems.length) {
    parts.push(
      `<div class="notice notice-warn" role="status">Some saved or deployed values aren't valid and are being ignored:<ul>${v.settings.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>`,
    );
  }
  const errors = SETTING_DEFS.flatMap((def) => {
    const message = errorFor(v, def);
    return message ? [[def, message] as const] : [];
  });
  if (errors.length) {
    parts.push(
      `<div class="notice notice-error" role="alert" id="errors">Nothing was saved. Fix these and save again:<ul>${errors
        .map(([def, message]) => `<li><a href="#f-${def.key}">${esc(def.label)}</a>: ${esc(message)}</li>`)
        .join("")}</ul></div>`,
    );
  }

  const visible = SETTING_DEFS.filter((d) => d.visible?.(v.env) ?? true);
  const fieldsets = SETTING_GROUPS.map((group) => {
    const defs = visible.filter((d) => d.group === group);
    return defs.length ? `<fieldset><legend>${esc(group)}</legend>${defs.map((d) => control(v, d)).join("")}</fieldset>` : "";
  }).join("");
  parts.push(
    `<form method="post" action="/settings" id="settings">${fieldsets}<div class="savebar"><button type="submit" class="btn btn-primary">Save changes</button><span class="small muted">Changes apply from the next run.</span></div></form>`,
  );
  // Reset buttons live inside the settings form but submit these (form="reset-<key>"): only reset=<key> is posted.
  parts.push(
    visible
      .filter((d) => v.settings.source[d.key] === "dashboard")
      .map((d) => `<form id="reset-${d.key}" method="post" action="/settings" hidden><input type="hidden" name="reset" value="${d.key}"></form>`)
      .join(""),
  );
  parts.push(accountCard(v.session));
  return parts.join("\n");
}
