from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable, List, Tuple

from src.config import AppConfig
from src.db import queries
from src.db.connection import DB
from src.utils.time import iso8601_to_ms

log = logging.getLogger("history_import")

HistoryTrackRow = Tuple[str, str, str | None, str | None, str | None, int | None, int | None]
HistoryPlayRow = Tuple[int, str, str, str | None, str | None, str]


@dataclass(frozen=True)
class ImportResult:
    files_processed: int
    plays_written: int
    tracks_written: int
    records_seen: int
    records_skipped: int


def _parse_end_time(end_time: str) -> int:
    # Legacy privacy export uses "YYYY-MM-DD HH:MM" in local time; treat as naive UTC.
    dt = datetime.strptime(end_time, "%Y-%m-%d %H:%M")
    return int(dt.timestamp() * 1000)


def _parse_record(record: dict) -> tuple[HistoryPlayRow | None, HistoryTrackRow | None]:
    # Try spotify track URI first
    uri = record.get("spotify_track_uri") or record.get("track_uri") or record.get("trackUri")
    track_id = None
    if uri and isinstance(uri, str) and uri.startswith("spotify:track:"):
        track_id = uri.split(":")[-1]
    if not track_id:
        return None, None

    played_at_str = record.get("ts") or record.get("endTime")
    if not played_at_str:
        return None, None

    try:
        played_at_ms = iso8601_to_ms(played_at_str)
    except Exception:
        try:
            played_at_ms = _parse_end_time(played_at_str)
        except Exception:
            return None, None

    track_name = record.get("master_metadata_track_name") or record.get("trackName")
    album_name = record.get("master_metadata_album_album_name")
    artist_name = record.get("master_metadata_album_artist_name") or record.get("artistName")
    explicit_flag = record.get("explicit") or record.get("is_explicit")
    explicit_int = 1 if explicit_flag is True else 0 if explicit_flag is False else None

    track_row: HistoryTrackRow = (
        track_id,
        uri,
        track_name,
        artist_name,
        album_name,
        record.get("ms_played") if isinstance(record.get("ms_played"), int) else None,
        explicit_int,
    )
    play_row: HistoryPlayRow = (
        played_at_ms,
        track_id,
        uri,
        None,
        None,
        "history_import",
    )
    return play_row, track_row


def _load_records(path: Path) -> Iterable[dict]:
    text = path.read_text(encoding="utf-8")
    try:
        data = json.loads(text)
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            return [data]
    except json.JSONDecodeError:
        pass

    # Try newline-delimited JSON
    records: List[dict] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
            if isinstance(obj, dict):
                records.append(obj)
        except json.JSONDecodeError:
            continue
    return records


def import_history_file(cfg: AppConfig, db: DB, path: str) -> ImportResult:
    """
    Import streaming history from a Spotify privacy export JSON file.
    Expected fields: ts (ISO8601) and spotify_track_uri (or track_uri/trackUri).
    Legacy exports with endTime/trackName/artistName are partially supported if URIs exist.
    """
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(path)

    records = list(_load_records(p))
    plays: List[HistoryPlayRow] = []
    tracks: List[HistoryTrackRow] = []
    skipped = 0

    for rec in records:
        play_row, track_row = _parse_record(rec)
        if play_row is None or track_row is None:
            skipped += 1
            continue
        plays.append(play_row)
        tracks.append(track_row)

    queries.upsert_tracks(db, tracks)
    queries.insert_plays(db, plays)

    log.info(
        "Imported history file %s | records=%s plays_written=%s tracks_written=%s skipped=%s",
        path,
        len(records),
        len(plays),
        len(tracks),
        skipped,
    )
    return ImportResult(
        files_processed=1,
        plays_written=len(plays),
        tracks_written=len(tracks),
        records_seen=len(records),
        records_skipped=skipped,
    )


def import_history_path(cfg: AppConfig, db: DB, path: str) -> ImportResult:
    """
    Accepts a file or a directory. If a directory, imports every *.json file (non-recursive).
    Aggregates counts across files. Safe to run multiple times; duplicates are ignored.
    """
    p = Path(path)
    if p.is_file():
        return import_history_file(cfg, db, path)

    if not p.is_dir():
        raise FileNotFoundError(path)

    json_files = sorted([f for f in p.iterdir() if f.is_file() and f.suffix.lower() == ".json"])
    if not json_files:
        raise FileNotFoundError(f"No JSON files found in directory: {path}")

    total_files = 0
    total_records = 0
    total_skipped = 0
    total_plays = 0
    total_tracks = 0

    for jf in json_files:
        result = import_history_file(cfg, db, str(jf))
        total_files += 1
        total_records += result.records_seen
        total_skipped += result.records_skipped
        total_plays += result.plays_written
        total_tracks += result.tracks_written

    log.info(
        "Imported history directory %s | files=%s records=%s plays_written=%s tracks_written=%s skipped=%s",
        path,
        total_files,
        total_records,
        total_plays,
        total_tracks,
        total_skipped,
    )
    return ImportResult(
        files_processed=total_files,
        plays_written=total_plays,
        tracks_written=total_tracks,
        records_seen=total_records,
        records_skipped=total_skipped,
    )
