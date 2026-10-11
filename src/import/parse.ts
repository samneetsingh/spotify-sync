// Spotify "Extended streaming history" parsing, shared by the dashboard import (src/import) and
// `npm run import-history` (scripts/import-history.ts), so both read an export identically.
// No Worker or Node imports: the script's tsconfig compiles this file too.

import type { EXPORT_PLAY_FIELDS } from "../db/schema";

/** Spotify counts a stream at 30 s; recently-played (the live sync) only reports those. */
export const MIN_MS_PLAYED = 30_000;
/** Covers the API's twin of the export's last play, which lands ~2 s after its ts. */
export const SPAN_TAIL_MS = 30_000;

export type ExportRecord = Record<string, unknown>;
export type ExportFields = Record<(typeof EXPORT_PLAY_FIELDS)[number][0], string | number | null> & { ms_played: number | null };

export interface ExportPlay {
  played_at_ms: number;
  track_id: string;
  track_uri: string;
  fields: ExportFields;
}

export interface ExportTrack {
  track_id: string;
  track_uri: string;
  name: string | null;
  artists: string | null;
  album: string | null;
  explicit: number | null;
}

/**
 * The export files that hold music plays: Streaming_History_Audio_*.json (current exports) and
 * endsong_*.json (older ones). Video history, podcasts-only files and the regular "Account data"
 * export (StreamingHistory_music_*.json, no track URIs) don't match.
 */
export const AUDIO_HISTORY_FILE = /^(?:Streaming_History_Audio_.*|endsong_.*)\.json$/i;

/** Whether `path` (a file or zip entry name; directories are ignored) is an audio history file. */
export function isAudioHistoryFile(path: string): boolean {
  const parts = path.split(/[\\/]/);
  const base = parts.pop() ?? "";
  if (parts.includes("__MACOSX") || base.startsWith("._")) return false;
  return AUDIO_HISTORY_FILE.test(base);
}

/** Port of _parse_record: needs a spotify:track URI and a timestamp; everything else is optional. */
export function parseRecord(r: ExportRecord): { play: ExportPlay; track: ExportTrack } | null {
  const uri = [r.spotify_track_uri, r.track_uri, r.trackUri].find((u) => typeof u === "string" && u) as string | undefined;
  if (!uri?.startsWith("spotify:track:")) return null;
  const trackId = uri.split(":").pop()!;
  const ts = (r.ts ?? r.endTime) as string | undefined;
  if (!ts || typeof ts !== "string") return null;
  const ms = parseTimestamp(ts);
  if (ms === null) return null;
  const flagKey = "explicit" in r ? "explicit" : "is_explicit" in r ? "is_explicit" : null;
  const explicit = flagKey === null ? null : r[flagKey] === true ? 1 : r[flagKey] === false ? 0 : null;
  const str = (...vals: unknown[]) => (vals.find((v) => typeof v === "string" && v) as string | undefined) ?? null;
  const bool = (v: unknown) => (typeof v === "boolean" ? (v ? 1 : 0) : null);
  const fields: ExportFields = {
    ms_played: ([r.ms_played, r.msPlayed].find((v) => typeof v === "number") as number | undefined) ?? null,
    platform: str(r.platform),
    conn_country: str(r.conn_country),
    reason_start: str(r.reason_start),
    reason_end: str(r.reason_end),
    shuffle: bool(r.shuffle),
    skipped: bool(r.skipped),
    offline: bool(r.offline),
    incognito_mode: bool(r.incognito_mode),
  };
  return {
    play: { played_at_ms: ms, track_id: trackId, track_uri: uri, fields },
    track: {
      track_id: trackId,
      track_uri: uri,
      name: str(r.master_metadata_track_name, r.trackName),
      artists: str(r.master_metadata_album_artist_name, r.artistName),
      album: str(r.master_metadata_album_album_name),
      explicit,
    },
  };
}

/** ISO 8601 (extended export `ts`), or legacy "YYYY-MM-DD HH:MM" (`endTime`) treated as UTC. */
export function parseTimestamp(ts: string): number | null {
  const legacy = ts.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
  const ms = legacy ? Date.UTC(+legacy[1]!, +legacy[2]! - 1, +legacy[3]!, +legacy[4]!, +legacy[5]!) : Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

/** A file's records: a JSON array, a single object, or newline-delimited JSON. */
export function parseRecordsText(raw: string): ExportRecord[] {
  const text = raw.trim();
  try {
    const parsed = JSON.parse(text);
    return (Array.isArray(parsed) ? parsed : [parsed]).filter((r) => r && typeof r === "object");
  } catch {
    return text.split("\n").flatMap((line) => {
      try {
        const r = JSON.parse(line);
        return r && typeof r === "object" ? [r] : [];
      } catch {
        return [];
      }
    });
  }
}

export const playKey = (ms: number, trackId: string): string => `${ms}:${trackId}`;

/**
 * Collects records the way the script always has: plays of at least MIN_MS_PLAYED keyed by
 * (time, track) with the last duplicate winning; each track's metadata from its first such play;
 * the span over every track record, shorter streams included (they are deleted inside it too).
 * Feed files in order (sorted by name); the CLI collects the whole export, a dashboard import one
 * file or zip entry per step.
 */
export class ExportCollector {
  readonly plays = new Map<string, ExportPlay>();
  readonly tracks = new Map<string, ExportTrack>();
  seen = 0;
  /** Records without a spotify:track URI or a timestamp (podcasts, audiobooks, videos, junk). */
  skipped = 0;
  /** Track records under MIN_MS_PLAYED. */
  short = 0;
  /** Epoch ms of the first and last track record (any length); Infinity / -Infinity when none. */
  first = Infinity;
  last = -Infinity;

  add(records: Iterable<ExportRecord>): this {
    for (const r of records) {
      this.seen++;
      const parsed = parseRecord(r);
      if (!parsed) {
        this.skipped++;
        continue;
      }
      const { play, track } = parsed;
      this.first = Math.min(this.first, play.played_at_ms);
      this.last = Math.max(this.last, play.played_at_ms);
      if ((play.fields.ms_played ?? 0) < MIN_MS_PLAYED) {
        this.short++;
        continue;
      }
      this.plays.set(playKey(play.played_at_ms, play.track_id), play);
      if (!this.tracks.has(track.track_id)) this.tracks.set(track.track_id, track);
    }
    return this;
  }

  /** The reconcile span [from, to): first record to last record + SPAN_TAIL_MS; null without track records. */
  span(): { from: number; to: number } | null {
    return this.first > this.last ? null : { from: this.first, to: this.last + SPAN_TAIL_MS };
  }
}
