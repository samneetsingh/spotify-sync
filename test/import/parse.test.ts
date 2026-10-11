// The export parser shared by the CLI script and the dashboard import (src/import/parse.ts).
import { describe, expect, it } from "vitest";
import { ExportCollector, MIN_MS_PLAYED, SPAN_TAIL_MS, isAudioHistoryFile, parseRecord, parseRecordsText, parseTimestamp, playKey } from "../../src/import/parse";
// Synthetic files in the shapes of Streaming_History_Audio_*.json, endsong_*.json and the account
// data's StreamingHistory_music_*.json (renamed: .gitignore keeps real export files out of git).
import accountData from "./fixtures/account-data-format.json";
import audio from "./fixtures/audio-format.json";
import endsong from "./fixtures/older-format.json";
import { audioRecord } from "./helpers";

const text = (v: unknown) => JSON.stringify(v, null, 2);

describe("parseRecordsText", () => {
  it("reads a JSON array, a single object and NDJSON", () => {
    expect(parseRecordsText(text(audio))).toHaveLength(5);
    expect(parseRecordsText(JSON.stringify(audio[0]))).toEqual([audio[0]]);
    expect(parseRecordsText(audio.map((r) => JSON.stringify(r)).join("\n") + "\nnot json\n")).toHaveLength(5);
  });

  it("tolerates a byte-order mark and surrounding whitespace, and drops non-objects", () => {
    expect(parseRecordsText(`﻿\n ${text(audio)} \n`)).toHaveLength(5);
    expect(parseRecordsText(JSON.stringify([1, "x", null, { ts: "2020-01-01T00:00:00Z" }]))).toEqual([{ ts: "2020-01-01T00:00:00Z" }]);
  });
});

describe("parseRecord", () => {
  it("reads the current Streaming_History_Audio format with every per-play field", () => {
    const parsed = parseRecord(audio[0]!);
    expect(parsed).toEqual({
      play: {
        played_at_ms: Date.UTC(2019, 11, 31, 23, 59, 30),
        track_id: "4uLU6hMCjMI75M1A2tKUQC",
        track_uri: "spotify:track:4uLU6hMCjMI75M1A2tKUQC",
        fields: { ms_played: 214000, platform: "ios", conn_country: "US", reason_start: "trackdone", reason_end: "trackdone", shuffle: 1, skipped: 0, offline: 0, incognito_mode: 0 },
      },
      track: { track_id: "4uLU6hMCjMI75M1A2tKUQC", track_uri: "spotify:track:4uLU6hMCjMI75M1A2tKUQC", name: "Midnight", artists: "Arijit Singh", album: "Nights", explicit: null },
    });
  });

  it("reads the older endsong format (and null booleans stay null)", () => {
    const parsed = parseRecord(endsong[0]!);
    expect(parsed?.play.fields).toMatchObject({ ms_played: 201000, skipped: null, platform: "Android OS 6.0.1 API 23 (samsung, SM-G920F)" });
    expect(parsed?.track.name).toBe("Old Song");
  });

  it("skips podcasts and records without a track URI or a usable timestamp", () => {
    expect(parseRecord(audio[2]!)).toBeNull(); // episode
    expect(parseRecord({ ...audio[0]!, ts: "not a date" })).toBeNull();
    expect(parseRecord({ ...audio[0]!, ts: undefined })).toBeNull();
    expect(parseRecord({ ...audio[0]!, spotify_track_uri: "spotify:local:a:b:c:1" })).toBeNull();
  });

  it("never reads the account-data export (no track URIs)", () => {
    expect(accountData.map((r) => parseRecord(r))).toEqual([null, null]);
  });

  it("parses legacy endTime timestamps as UTC", () => {
    expect(parseTimestamp("2020-01-01 10:05")).toBe(Date.UTC(2020, 0, 1, 10, 5));
    expect(parseTimestamp("2020-01-01T10:05:00Z")).toBe(Date.UTC(2020, 0, 1, 10, 5));
    expect(parseTimestamp("garbage")).toBeNull();
  });
});

describe("ExportCollector", () => {
  it("keeps plays of at least 30 s, counts the rest, and spans every track record", () => {
    const c = new ExportCollector().add(parseRecordsText(text(audio)));
    expect({ seen: c.seen, skipped: c.skipped, short: c.short, plays: c.plays.size }).toEqual({ seen: 5, skipped: 1, short: 1, plays: 2 });
    // The 12 s play is short but still inside the span; the episode isn't a track record.
    expect(c.span()).toEqual({ from: Date.UTC(2019, 11, 31, 23, 59, 30), to: Date.UTC(2020, 0, 2, 18, 20) + SPAN_TAIL_MS });
    expect(MIN_MS_PLAYED).toBe(30_000);
  });

  it("lets the last duplicate win, and keeps each track's first metadata", () => {
    const c = new ExportCollector().add(parseRecordsText(text(audio)));
    const key = playKey(Date.UTC(2020, 0, 2, 18, 20), "1ccccccccccccccccccccc");
    expect(c.plays.get(key)?.fields).toMatchObject({ ms_played: 95000, offline: 0, incognito_mode: 0 });
    const later = audioRecord({ ms: Date.UTC(2020, 1, 1), track: "4uLU6hMCjMI75M1A2tKUQC", name: "Renamed" });
    c.add([later]);
    expect(c.tracks.get("4uLU6hMCjMI75M1A2tKUQC")?.name).toBe("Midnight");
  });

  it("has no span without track records", () => {
    expect(new ExportCollector().add(accountData).span()).toBeNull();
  });
});

describe("isAudioHistoryFile", () => {
  it.each([
    ["Streaming_History_Audio_2019-2020_0.json", true],
    ["Spotify Extended Streaming History/Streaming_History_Audio_2024_12.json", true],
    ["MyData/endsong_3.json", true],
    ["STREAMING_HISTORY_AUDIO_2020.JSON", true],
    ["Spotify Extended Streaming History/Streaming_History_Video_2020-2024.json", false],
    ["__MACOSX/Spotify Extended Streaming History/._Streaming_History_Audio_2020_1.json", false],
    ["._Streaming_History_Audio_2020_1.json", false],
    ["StreamingHistory_music_0.json", false],
    ["Streaming_History_Audio_2020_1.json.zip", false],
    ["ReadMeFirst_ExtendedStreamingHistory.pdf", false],
  ])("%s -> %s", (name, expected) => {
    expect(isAudioHistoryFile(name)).toBe(expected);
  });
});
