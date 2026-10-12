// Home's settings widget: one switch per everyday setting, each a one-key POST to /settings/toggle
// (`key`, and `value` the new state). Liked Songs can only be switched off here: switching it on needs
// the confirmation on the settings page, so while it's off the row links there instead.

import type { SettingKey, SettingValues } from "../../settings";
import { Switch } from "./primitives";

interface Toggle {
  key: SettingKey;
  label: string;
}

const EMAILS: Toggle[] = [
  { key: "digestWeekly", label: "Weekly digest" },
  { key: "digestMonthly", label: "Monthly recap" },
  { key: "aiEditor", label: "AI editor" },
];

const PLAYLISTS: Toggle[] = [
  { key: "frequent", label: "Frequent Plays" },
  { key: "onThisDay", label: "On This Day" },
  { key: "forgottenFavorites", label: "Forgotten Favorites" },
];

export interface SettingsWidgetProps {
  settings: SettingValues;
  /** OPENAI_API_KEY is set: the AI editor switch shows. */
  aiAvailable: boolean;
}

/** The switches, grouped (Emails, Playlists), and a link to every other setting. `id="settings"` is the toggle's redirect target. */
export function SettingsWidget({ settings, aiAvailable }: SettingsWidgetProps) {
  const row = (t: Toggle) => (
    <li>
      <Switch setting={t.key} label={t.label} on={settings[t.key] === true} />
    </li>
  );
  return (
    <section class="card home-settings" id="settings" aria-labelledby="settings-title">
      <div class="card-head">
        <h2 id="settings-title">Settings</h2>
      </div>
      <h3 class="switch-group">Emails</h3>
      <ul class="switches">{EMAILS.filter((t) => t.key !== "aiEditor" || aiAvailable).map(row)}</ul>
      <h3 class="switch-group">Playlists</h3>
      <ul class="switches">
        <li>
          {settings.liked ? (
            <Switch setting="liked" label="Liked Songs" on />
          ) : (
            <div class="switch-link">
              <span class="switch-label">Liked Songs</span>
              <a href="/settings#s-liked">Turn on in Settings</a>
            </div>
          )}
        </li>
        {PLAYLISTS.map(row)}
      </ul>
      <div class="card-foot">
        <a href="/settings">All settings</a>
      </div>
    </section>
  );
}
