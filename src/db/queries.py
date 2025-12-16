# src/db/queries.py
from __future__ import annotations

from importlib import resources
from typing import Iterable, Sequence, Tuple

from .connection import DB

TrackRow = Tuple[str, str, str | None, str | None, str | None, int | None, int | None]
PlayRow = Tuple[int, str, str, str | None, str | None, str]
PlaylistTrackRow = Tuple[str, str]

_SQL_CACHE: dict[str, str] = {}


def _load_sql(name: str) -> str:
    if name not in _SQL_CACHE:
        _SQL_CACHE[name] = resources.files("src.db.sql").joinpath(name).read_text(encoding="utf-8")
    return _SQL_CACHE[name]


def get_known_playlist_track_ids(db: DB, playlist_id: str) -> set[str]:
    rows = db.fetchall(
        _load_sql("get_known_playlist_track_ids.sql"),
        (playlist_id,),
    )
    return {str(r["track_id"]) for r in rows}


def upsert_tracks(db: DB, rows: Sequence[TrackRow]) -> None:
    if not rows:
        return
    db.executemany(
        _load_sql("upsert_tracks.sql"),
        list(rows),
    )


def insert_plays(db: DB, rows: Sequence[PlayRow]) -> None:
    if not rows:
        return
    db.executemany(
        _load_sql("insert_plays.sql"),
        list(rows),
    )


def mark_tracks_in_playlist(
    db: DB,
    playlist_id: str,
    rows: Iterable[PlaylistTrackRow],
) -> None:
    payload = [(playlist_id, tid, uri) for (tid, uri) in rows]
    if not payload:
        return
    db.executemany(
        _load_sql("mark_tracks_in_playlist.sql"),
        payload,
    )


def create_sync_run(db: DB, cursor_in_ms: int) -> int:
    cur = db.conn.execute(
        "INSERT INTO sync_runs(cursor_in_ms, status) VALUES(?, 'running')",
        (cursor_in_ms,),
    )
    db.conn.commit()
    return int(cur.lastrowid)


def finish_sync_run(
    db: DB,
    run_id: int,
    *,
    cursor_out_ms: int | None,
    plays_fetched: int,
    tracks_added: int,
    status: str,
    error: str | None = None,
) -> None:
    db.execute(
        _load_sql("finish_sync_run.sql"),
        (cursor_out_ms, plays_fetched, tracks_added, status, error, run_id),
    )
