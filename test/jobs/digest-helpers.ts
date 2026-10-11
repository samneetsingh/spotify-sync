// Shared by the digest job tests: a fake email binding, fake Spotify art, a config and a D1 seeder.

import { env } from "cloudflare:workers";
import type { AlertConfig } from "../../src/alerts";
import { loadConfig, type Config } from "../../src/config";
import type { Env, WriteMode } from "../../src/env";
import type { ArtSource } from "../../src/jobs/digest";

export const TZ = "America/Los_Angeles";

export type Sent = { subject: string; text: string; html?: string };

export function fakeEmail(opts: { fail?: boolean; publicUrl?: string } = {}) {
  const sent: Sent[] = [];
  const binding = {
    async send(msg: Sent) {
      if (opts.fail) throw new Error("boom");
      sent.push(msg);
      return { messageId: `m${sent.length}` };
    },
  } as unknown as SendEmail;
  return { sent, cfg: { binding, from: "spotify-sync@example.com", to: "me@example.com", timeZone: TZ, publicUrl: opts.publicUrl } as AlertConfig };
}

/** Spotify art lookups: 640/300/64 album covers and 640/320/160 artist photos, or an error. */
export function artSource(opts: { fail?: boolean } = {}) {
  const calls: string[] = [];
  const images = (id: string, sizes: number[]) => sizes.map((w) => ({ url: `https://i.test/${id}-${w}`, width: w }));
  const sp = {
    async getTracks(ids: string[]) {
      calls.push(`tracks:${ids.join(",")}`);
      if (opts.fail) throw new Error("Token refresh failed: 400 invalid_grant");
      return { tracks: ids.map((id) => ({ id, album: { images: images(id, [640, 300, 64]) } })) };
    },
    async getArtists(ids: string[]) {
      calls.push(`artists:${ids.join(",")}`);
      if (opts.fail) throw new Error("Token refresh failed: 400 invalid_grant");
      return { artists: ids.map((id) => ({ id, images: images(id, [640, 320, 160]) })) };
    },
  } as unknown as ArtSource;
  return { sp, calls };
}

export const config = (mode: WriteMode = "live"): Config =>
  loadConfig({ SPOTIFY_ALL_PLAYLIST_ID: "all1", WRITE_MODE: mode, TIME_ZONE: TZ } as Env);

/** One track per row, credited to one artist, played at the given UTC times. */
export async function seed(rows: Array<{ id: string; name: string; artist: [string, string]; at: string[]; durationMs?: number }>) {
  await env.DB.batch(
    rows.flatMap(({ id, name, artist, at, durationMs }) => [
      env.DB.prepare("INSERT INTO tracks(track_id, track_uri, name, artists, duration_ms) VALUES(?1, 'spotify:track:' || ?1, ?2, ?3, ?4)").bind(id, name, artist[1], durationMs ?? null),
      env.DB.prepare("INSERT OR IGNORE INTO track_artists(track_id, artist_id, artist_name, position) VALUES(?1, ?2, ?3, 0)").bind(id, artist[0], artist[1]),
      ...at.map((iso) =>
        env.DB.prepare("INSERT INTO plays(played_at_ms, track_id, track_uri, source) VALUES(?1, ?2, 'spotify:track:' || ?2, 'history_import')").bind(Date.parse(iso), id),
      ),
    ]),
  );
}

export const days = (prefix: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}-${String(from + i).padStart(2, "0")}T18:00:00Z`);
