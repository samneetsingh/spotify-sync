// The settings page, most used and least risky first: problems (only while a job fails), the
// everyday settings (Playlists, Emails), then General, the Spotify card and the Account card
// (History import; with Advanced, sign-in), then the save bar. The Spotify card moves to the top
// while it needs the owner (not connected, or the login expired). The save bar sits outside the
// form (form="settings") and public/settings-form.js shows it only once a setting has changed.
// The form is rendered from the registry (src/settings.ts): one fieldset per group, each
// control with its description, its status line (settings-status.tsx), where its value comes from
// (with Reset for dashboard changes), and the Liked Songs confirmation. Settings marked
// `advancedOnly` show only while the `advanced` setting is on. The form follows saveSettings' encoding (see src/settings.ts):
// booleans post a hidden "false" then the checkbox "true", `confirm_<key>=yes` acknowledges a
// `confirmOn` warning, and Reset posts only `reset=<key>` from its own form. Field ids and names are
// fixed: tests and `#s-<key>` links rely on them. The History import section is importSection's
// escaped HTML, through raw().

import type { Child } from "hono/jsx";
import type { Session } from "../auth";
import type { Env, WriteMode } from "../env";
import {
  SETTING_DEFS,
  SETTING_GROUPS,
  confirmField,
  type EffectiveSettings,
  type SettingDef,
  type SettingGroup,
  type SettingKey,
  type SettingSource,
} from "../settings";
import { Card, LinkButton, PostButton } from "./components/primitives";
import { raw, render } from "./render";
import { ActionForms, emailsNote, ProblemsCard, settingLines, SpotifyCard, type StatusView } from "./settings-status";
import type { DashboardStatus } from "./status";
import { syncState } from "./sync-state";

export interface SettingsView {
  session: Session;
  settings: EffectiveSettings;
  env: Env;
  /** Live state for the Spotify and Problems cards and the status lines. */
  status: DashboardStatus;
  writeMode: WriteMode;
  /** Email binding and both addresses are set; `to` is where everything goes. */
  email: { configured: boolean; to: string | null };
  /** After a refused save: the posted form (shown again so nothing is lost) and the errors per key. */
  submitted?: FormData;
  errors?: Partial<Record<SettingKey, string>>;
  /** The History import section's HTML (already escaped); empty when import isn't set up. */
  importHtml?: string;
}

/** What a setting's control needs (the onboarding renders controls too). */
export type ControlView = Pick<SettingsView, "settings" | "env" | "submitted" | "errors">;

/** Where a value comes from; a value changed here shows only its Reset button. */
const SOURCE_LABEL: Record<Exclude<SettingSource, "dashboard">, string> = { deploy: "From deploy config", default: "Default" };

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
function shown(v: ControlView, def: SettingDef): string | boolean {
  if (v.submitted?.has(def.key)) {
    const posted = v.submitted.getAll(def.key).at(-1);
    return def.type === "boolean" ? posted === "true" : String(posted ?? "");
  }
  const value = v.settings.values[def.key];
  return def.type === "boolean" ? value === true : String(value);
}

/** Where the value comes from, or for a value changed here, Reset (which submits the key's own form). */
function MetaRow({ v, def }: { v: ControlView; def: SettingDef }) {
  const source = v.settings.source[def.key];
  return (
    <div class="meta-row">
      {source === "dashboard" ? (
        <button type="submit" form={`reset-${def.key}`} class="btn btn-small" aria-label={`Reset ${def.label}`}>
          Reset
        </button>
      ) : (
        <span class={`source source-${source}`}>{SOURCE_LABEL[source]}</span>
      )}
    </div>
  );
}

/** A refused save's message for `def`; a missing confirmation points at the box right below. */
function errorFor(v: ControlView, def: SettingDef): string | undefined {
  const error = v.errors?.[def.key];
  if (!error || !def.confirmOn) return error;
  const wantsOn = v.submitted?.getAll(def.key).at(-1) === "true";
  return wantsOn && v.submitted?.get(confirmField(def.key)) !== "yes" ? "Tick “I understand” below to turn this on." : error;
}

/** The time zone <select>: UTC first, then one <optgroup> per region. */
function TimeZoneSelect({ id, name, value, describedBy, invalid, form }: { id: string; name: string; value: string; describedBy: string; invalid: boolean; form?: string }) {
  return (
    <select id={id} name={name} form={form} aria-describedby={describedBy} aria-invalid={invalid ? "true" : undefined}>
      {[...timeZones(value)].map(([region, zones]) => {
        const options = zones.map((z) => (
          <option value={z} selected={z === value}>
            {z.replaceAll("_", " ")}
          </option>
        ));
        return region === "UTC" ? options : <optgroup label={region}>{options}</optgroup>;
      })}
    </select>
  );
}

/**
 * One setting. `form`: the settings form's id, for a control rendered outside that form (General).
 * `plain`: without the source and Reset row (the onboarding).
 */
export function Control({ v, def, line, form, plain }: { v: ControlView; def: SettingDef; line?: Child; form?: string; plain?: boolean }) {
  const id = `f-${def.key}`;
  const error = errorFor(v, def);
  const describedBy = `d-${def.key}${error ? ` e-${def.key}` : ""}`;
  const invalid = error ? "true" : undefined;
  const errorText = error ? (
    <p class="field-error" id={`e-${def.key}`}>
      {error}
    </p>
  ) : null;
  const desc = (
    <>
      <p class="desc" id={`d-${def.key}`}>
        {def.description}
      </p>
      {line ? <div class="setting-status">{line}</div> : null}
    </>
  );
  const forced = def.force?.(v.env);

  if (forced !== undefined) {
    // Fixed by the deploy (e.g. the AI editor without a key): nothing to post.
    return (
      <div class="setting field" id={`s-${def.key}`}>
        <label>{def.label}</label>
        {desc}
        <p class="desc">{`Fixed by the deploy: ${forced === true ? "on" : forced === false ? "off" : String(forced)}.`}</p>
      </div>
    );
  }

  if (def.type === "boolean") {
    const effective = v.settings.values[def.key] === true;
    const ack = v.submitted?.get(confirmField(def.key)) === "yes";
    // Switching on needs an explicit acknowledgement; shown when the box is ticked (or always, without :has).
    const confirm =
      def.confirmOn && !effective ? (
        <div class={`confirm${error ? " invalid" : ""}`} id={`c-${def.key}`}>
          <p>
            <strong>Before you turn this on</strong>
          </p>
          <p>{def.confirmOn}</p>
          <label>
            <input type="checkbox" name={confirmField(def.key)} value="yes" checked={ack} form={form} /> I understand. Turn it on.
          </label>
        </div>
      ) : null;
    return (
      <div class={`setting${def.confirmOn ? " gated" : ""}`} id={`s-${def.key}`}>
        <div class="control">
          <input type="hidden" name={def.key} value="false" form={form} />
          <input class="toggle" type="checkbox" id={id} name={def.key} value="true" form={form} aria-describedby={describedBy} checked={shown(v, def) === true} aria-invalid={invalid} />
        </div>
        <label for={id}>{def.label}</label>
        {desc}
        {plain ? null : <MetaRow v={v} def={def} />}
        {errorText}
        {confirm}
      </div>
    );
  }

  const value = String(shown(v, def));
  const input =
    def.type === "integer" ? (
      <input
        type="number"
        inputmode="numeric"
        step="1"
        id={id}
        name={def.key}
        form={form}
        value={value}
        min={def.min}
        max={def.max}
        required
        aria-describedby={describedBy}
        aria-invalid={invalid}
      />
    ) : (
      <TimeZoneSelect id={id} name={def.key} value={value} describedBy={describedBy} invalid={!!error} form={form} />
    );
  return (
    <div class="setting field" id={`s-${def.key}`}>
      <label for={id}>{def.label}</label>
      {desc}
      {input}
      {plain ? null : <MetaRow v={v} def={def} />}
      {errorText}
    </div>
  );
}

/** The History import section, then sign-in: Log out, and with Advanced, Reconnect and Log out everywhere (the dashboard's only log-outs). */
function AccountCard({ importHtml, advanced }: { importHtml: string; advanced: boolean }) {
  return (
    <Card title="Account" id="account">
      {importHtml ? raw(importHtml) : null}
      <div class="card-part" id="sign-in">
        <div class="part-head">
          <h3>Sign-in</h3>
        </div>
        {advanced ? (
          <p class="note">Reconnect if Spotify asks you to log in again; only your account is accepted. Log out everywhere ends the dashboard on every device.</p>
        ) : null}
        <div class="actions">
          {advanced ? <LinkButton href="/login?next=%2Fsettings" label="Reconnect Spotify" /> : null}
          <PostButton action="/logout" label="Log out" />
          {advanced ? <PostButton action="/logout/all" label="Log out everywhere" variant="danger" /> : null}
        </div>
      </div>
    </Card>
  );
}

export function Settings({ v }: { v: SettingsView }) {
  const errors = SETTING_DEFS.flatMap((def) => {
    const message = errorFor(v, def);
    return message ? [[def, message] as const] : [];
  });
  const values = v.settings.values;
  const visible = SETTING_DEFS.filter((d) => (d.visible?.(v.env) ?? true) && (!d.advancedOnly || values.advanced));
  const sv: StatusView = { session: v.session, status: v.status, values, writeMode: v.writeMode, email: v.email };
  const state = syncState(v.status, v.status.now);
  const spotifyFirst = !v.status.connected || state.loginError;
  // General sits with the rarer cards, after the save bar; its controls still belong to the
  // settings form (form="settings"), so Save changes saves them too.
  const groupFieldset = (group: SettingGroup, form?: string) => {
    const defs = visible.filter((d) => d.group === group);
    return defs.length ? (
      <fieldset class={`group-${group.toLowerCase()}`}>
        <legend>{group}</legend>
        <div class="settings-list">
          {defs.map((d) => (
            <Control v={v} def={d} line={lines[d.key]} form={form} />
          ))}
        </div>
        {group === "Emails" ? <p class="note">{emailsNote(sv, !!v.env.OPENAI_API_KEY)}</p> : null}
        {group === "General" ? (
          <p class="note">
            <a href="/?tour=0">Take the tour again</a>
          </p>
        ) : null}
      </fieldset>
    ) : null;
  };
  const lines = settingLines(sv, Object.fromEntries(SETTING_DEFS.map((d) => [d.key, d.label])) as Record<SettingKey, string>);
  return (
    <>
      {v.settings.problems.length ? (
        <div class="notice notice-warn" role="status">
          Some saved or deployed values aren't valid and are being ignored:
          <ul>
            {v.settings.problems.map((p) => (
              <li>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {errors.length ? (
        <div class="notice notice-error" role="alert" id="errors">
          Nothing was saved. Fix these and save again:
          <ul>
            {errors.map(([def, message]) => (
              <li>
                <a href={`#f-${def.key}`}>{def.label}</a>: {message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {v.status.failing.length || spotifyFirst ? (
        <div class="dash dash-top">
          <ProblemsCard v={sv} />
          {spotifyFirst ? <SpotifyCard v={sv} /> : null}
        </div>
      ) : null}
      <form method="post" action="/settings" id="settings" class="dash dash-form">
        {SETTING_GROUPS.filter((g) => g !== "General").map((group) => groupFieldset(group))}
      </form>
      {/* Reset buttons live inside the settings form but submit these (form="reset-<key>"): only reset=<key> is posted. */}
      {visible
        .filter((d) => v.settings.source[d.key] === "dashboard")
        .map((d) => (
          <form id={`reset-${d.key}`} method="post" action="/settings" hidden>
            <input type="hidden" name="reset" value={d.key} />
          </form>
        ))}
      <ActionForms v={sv} />
      <div class="dash dash-more">
        {groupFieldset("General", "settings")}
        {spotifyFirst ? null : <SpotifyCard v={sv} />}
        <AccountCard importHtml={v.importHtml ?? ""} advanced={values.advanced} />
      </div>
      {/* After a refused save the posted values are what's shown, so the bar stays (data-always). */}
      <div class="savebar" id="savebar" data-always={errors.length ? "" : undefined}>
        <button type="submit" form="settings" class="btn btn-primary">
          Save changes
        </button>
        <span class="small muted">Changes apply from the next run.</span>
      </div>
    </>
  );
}

/** The settings page's body as HTML, for renderPage. */
export const settingsBody = (v: SettingsView): string => render(<Settings v={v} />);
