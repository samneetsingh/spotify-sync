// Account emails: the setup ("claim") link and the welcome note
// after connecting. Same design as the alerts. They go through the ungated email config, so the
// `alerts` setting can't silence them, and they're sent in every write mode. The setup link appears
// only in the body: never in the subject or in logs.

import type { Email } from "../alerts";
import { actionButton, alertHeader, cardEnd, facts, smallPrint } from "../email/components";
import { shell } from "../email/layout";
import type { SettingValues } from "../settings";

const SUBJECT_PREFIX = "[spotify-sync] ";

/** The setup link for an unclaimed instance. `link` is the single-use /claim?k= URL. */
export function claimEmail(opts: { publicUrl: string; link: string }): Email {
  const host = new URL(opts.publicUrl).host;
  const title = "Connect your Spotify";
  const lead = `spotify-sync is running at ${host}. Connect your Spotify account to finish setup: it then saves what you play and keeps your playlists up to date.`;
  const button = { label: "Connect Spotify", note: "Works once, for 7 days." };
  const note = "Didn't expect this? Ignore it; nothing happens unless the link is used.";
  const subject = `${SUBJECT_PREFIX}Connect your Spotify to finish setup`;
  const body = [alertHeader("setup", title, lead), actionButton(button.label, opts.link, button.note), smallPrint(note), cardEnd].join("\n");
  const text = [title, lead, "", `${button.label}: ${opts.link}`, button.note, "", note].join("\n");
  return { subject, text, html: shell({ title: subject, preheader: lead, body }) };
}

const onOff = (on: boolean) => (on ? "On" : "Off");

/** What's switched on, in the welcome email's words. Liked Songs always spells out what it does. */
export function featureRows(s: SettingValues): Array<[string, string]> {
  return [
    ["Liked Songs", s.liked ? "On: every track you play is added to your Liked Songs" : "Off. When on, every track you play is added to your Liked Songs"],
    ["Frequent Plays", s.frequent ? `On: songs with ${s.frequentMinPlays}+ plays` : "Off"],
    ["Artist playlists", s.artistPlaylists ? "On, updated nightly" : "Off"],
    ["On This Day", onOff(s.onThisDay)],
    ["Forgotten Favorites", onOff(s.forgottenFavorites)],
    ["Holiday Favorites", onOff(s.holiday)],
    ["Hindi Favorites", onOff(s.hindiFavorites)],
    ["Weekly digest", s.digestWeekly ? "On, Monday mornings" : "Off"],
    ["Monthly recap", s.digestMonthly ? "On, on the 1st" : "Off"],
  ];
}

/**
 * "You're connected": the account, what runs when, what's on, and a link to the dashboard.
 * `settings` null (couldn't be read) leaves the feature list out and points to Settings instead.
 */
export function welcomeEmail(opts: { publicUrl: string; account: { id: string; displayName: string | null }; settings: SettingValues | null }): Email {
  const origin = new URL(opts.publicUrl).origin;
  const who = opts.account.displayName && opts.account.displayName !== opts.account.id ? `${opts.account.displayName} (${opts.account.id})` : opts.account.id;
  const title = "You're connected";
  const lead = "spotify-sync now runs for your Spotify account. The first sync runs within 10 minutes; you can change what it does in Settings before then.";
  const schedule: Array<[string, string]> = [
    ["Account", who],
    ["Syncs", "Every 10 minutes"],
    ["Playlists", "Updated nightly"],
    ["Digests", "Mondays (weekly) and the 1st (monthly)"],
  ];
  const features = opts.settings ? featureRows(opts.settings) : [];
  const button = { label: "Open your dashboard", url: `${origin}/`, note: "Log in with Spotify any time to change settings or see what ran." };
  const tip =
    "Tip: to fill in everything you played before today, request your Extended streaming history at spotify.com/account/privacy (it can take up to 30 days), then import it on the dashboard.";
  const subject = `${SUBJECT_PREFIX}You're connected`;
  const body = [
    alertHeader("connected", title, lead),
    actionButton(button.label, button.url, button.note),
    facts(schedule),
    features.length ? facts(features) : smallPrint("See Settings on the dashboard for what's switched on."),
    smallPrint(tip),
    cardEnd,
  ].join("\n");
  const text = [
    title,
    lead,
    "",
    `${button.label}: ${button.url}`,
    "",
    ...schedule.map(([k, v]) => `${k}: ${v}`),
    "",
    ...(features.length ? features.map(([k, v]) => `${k}: ${v}`) : ["See Settings on the dashboard for what's switched on."]),
    "",
    tip,
  ].join("\n");
  return { subject, text, html: shell({ title: subject, preheader: lead, body }) };
}
