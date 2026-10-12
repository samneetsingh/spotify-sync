// The settings page, rendered from the registry (src/settings.ts): one fieldset per group, each
// control with its description, where its value comes from (with Reset for dashboard changes), and
// the Liked Songs confirmation. The form follows saveSettings' encoding (see src/settings.ts):
// booleans post a hidden "false" then the checkbox "true", `confirm_<key>=yes` acknowledges a
// `confirmOn` warning, and Reset posts only `reset=<key>` from its own form. Field ids and names are
// fixed: tests and links (Home's /settings#s-liked) rely on them.

import type { Session } from "../auth";
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
import { Card, Facts, LinkButton, PostButton } from "./components/primitives";
import { render } from "./render";

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

/** Where the value comes from, and Reset (which submits the key's own form) for dashboard changes. */
function MetaRow({ v, def }: { v: SettingsView; def: SettingDef }) {
  const source = v.settings.source[def.key];
  return (
    <div class="meta-row">
      <span class={`source source-${source}`}>{SOURCE_LABEL[source]}</span>
      {source === "dashboard" ? (
        <button type="submit" form={`reset-${def.key}`} class="btn btn-small" aria-label={`Reset ${def.label}`}>
          Reset
        </button>
      ) : null}
    </div>
  );
}

/** A refused save's message for `def`; a missing confirmation points at the box right below. */
function errorFor(v: SettingsView, def: SettingDef): string | undefined {
  const error = v.errors?.[def.key];
  if (!error || !def.confirmOn) return error;
  const wantsOn = v.submitted?.getAll(def.key).at(-1) === "true";
  return wantsOn && v.submitted?.get(confirmField(def.key)) !== "yes" ? "Tick “I understand” below to turn this on." : error;
}

/** The time zone <select>: UTC first, then one <optgroup> per region. */
function TimeZoneSelect({ id, name, value, describedBy, invalid }: { id: string; name: string; value: string; describedBy: string; invalid: boolean }) {
  return (
    <select id={id} name={name} aria-describedby={describedBy} aria-invalid={invalid ? "true" : undefined}>
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

function Control({ v, def }: { v: SettingsView; def: SettingDef }) {
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
    <p class="desc" id={`d-${def.key}`}>
      {def.description}
    </p>
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
            <input type="checkbox" name={confirmField(def.key)} value="yes" checked={ack} /> I understand. Turn it on.
          </label>
        </div>
      ) : null;
    return (
      <div class={`setting${def.confirmOn ? " gated" : ""}`} id={`s-${def.key}`}>
        <div class="control">
          <input type="hidden" name={def.key} value="false" />
          <input class="toggle" type="checkbox" id={id} name={def.key} value="true" aria-describedby={describedBy} checked={shown(v, def) === true} aria-invalid={invalid} />
        </div>
        <label for={id}>{def.label}</label>
        {desc}
        <MetaRow v={v} def={def} />
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
        value={value}
        min={def.min}
        max={def.max}
        required
        aria-describedby={describedBy}
        aria-invalid={invalid}
      />
    ) : (
      <TimeZoneSelect id={id} name={def.key} value={value} describedBy={describedBy} invalid={!!error} />
    );
  return (
    <div class="setting field" id={`s-${def.key}`}>
      <label for={id}>{def.label}</label>
      {desc}
      {input}
      <MetaRow v={v} def={def} />
      {errorText}
    </div>
  );
}

function AccountCard({ session }: { session: Session }) {
  const name = session.displayName ? (
    <>
      {session.displayName}
      <span class="sub">{session.spotifyId}</span>
    </>
  ) : (
    session.spotifyId
  );
  const actions = (
    <>
      <LinkButton href="/login?next=%2Fsettings" label="Reconnect Spotify" />
      <PostButton action="/logout" label="Log out" />
      <PostButton action="/logout/all" label="Log out everywhere" variant="danger" />
    </>
  );
  return (
    <Card title="Account" id="account" actions={actions}>
      <Facts rows={[["Spotify account", name]]} />
      <p class="note">Reconnect if Spotify asks you to log in again; only your account is accepted. Log out everywhere ends the dashboard on every device.</p>
    </Card>
  );
}

export function Settings({ v }: { v: SettingsView }) {
  const errors = SETTING_DEFS.flatMap((def) => {
    const message = errorFor(v, def);
    return message ? [[def, message] as const] : [];
  });
  const visible = SETTING_DEFS.filter((d) => d.visible?.(v.env) ?? true);
  return (
    <>
      {v.welcome ? (
        <div class="notice notice-ok" role="status">
          <strong>You're connected.</strong> Your first sync runs within 10 minutes with these settings. Change anything now or later.
        </div>
      ) : null}
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
      <form method="post" action="/settings" id="settings">
        {SETTING_GROUPS.map((group) => {
          const defs = visible.filter((d) => d.group === group);
          return defs.length ? (
            <fieldset>
              <legend>{group}</legend>
              {defs.map((d) => (
                <Control v={v} def={d} />
              ))}
            </fieldset>
          ) : null;
        })}
        <div class="savebar">
          <button type="submit" class="btn btn-primary">
            Save changes
          </button>
          <span class="small muted">Changes apply from the next run.</span>
        </div>
      </form>
      {/* Reset buttons live inside the settings form but submit these (form="reset-<key>"): only reset=<key> is posted. */}
      {visible
        .filter((d) => v.settings.source[d.key] === "dashboard")
        .map((d) => (
          <form id={`reset-${d.key}`} method="post" action="/settings" hidden>
            <input type="hidden" name="reset" value={d.key} />
          </form>
        ))}
      <AccountCard session={v.session} />
    </>
  );
}

/** The settings page's body as HTML, for renderPage. */
export const settingsBody = (v: SettingsView): string => render(<Settings v={v} />);
