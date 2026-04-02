# src/db/queries.py
from __future__ import annotations

from importlib import resources
from typing import TYPE_CHECKING, Iterable, NamedTuple, Sequence

from .connection import DB

if TYPE_CHECKING:
    from src.config import ArtistDiscoveryConfig


class TrackRow(NamedTuple):
    track_id: str
    track_uri: str
    name: str | None
    artists: str | None
    album: str | None
    duration_ms: int | None
    explicit: int | None
    popularity: int | None = None
    release_date: str | None = None
    isrc: str | None = None


class PlayRow(NamedTuple):
    played_at_ms: int
    track_id: str
    track_uri: str
    context_type: str | None
    context_uri: str | None
    source: str


class PlaylistTrackRow(NamedTuple):
    track_id: str
    track_uri: str


class TrackArtistRow(NamedTuple):
    track_id: str
    artist_id: str
    artist_name: str
    position: int


class ArtistRow(NamedTuple):
    artist_id: str
    name: str
    genres: str | None  # JSON array string
    popularity: int | None
    followers: int | None


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


def discover_artists(db: DB, discovery: ArtistDiscoveryConfig | None = None) -> list[dict]:
    if discovery is None:
        from src.config import ArtistDiscoveryConfig as _ADC
        discovery = _ADC()
    rows = db.fetchall(
        _load_sql("discover_artists.sql"),
        (
            discovery.plays_per_song_threshold,
            discovery.songs_over_threshold,
            discovery.total_streams_threshold,
            discovery.alt_song_count,
            discovery.alt_streams_threshold,
        ),
    )
    return [
        {
            "artist": str(r["artist"]),
            "song_count": int(r["song_count"]),
            "total_streams": int(r["total_streams"]),
            "songs_over_threshold": int(r["songs_over_threshold"]),
        }
        for r in rows
    ]


def get_artist_playlist(db: DB, artist_name: str) -> str | None:
    row = db.fetchone(
        _load_sql("get_artist_playlist.sql"),
        (artist_name,),
    )
    return str(row["playlist_id"]) if row else None


def register_playlist(
    db: DB,
    playlist_id: str,
    name: str,
    artist_name: str | None,
    playlist_type: str = "artist",
) -> None:
    db.execute(
        _load_sql("insert_playlist.sql"),
        (playlist_id, name, artist_name, playlist_type),
    )


def delete_playlist(db: DB, playlist_id: str) -> None:
    """Remove a playlist and its track associations from the local DB."""
    db.execute("DELETE FROM playlist_tracks WHERE playlist_id = ?", (playlist_id,))
    db.execute("DELETE FROM playlist_removals WHERE playlist_id = ?", (playlist_id,))
    db.execute("DELETE FROM playlists WHERE playlist_id = ?", (playlist_id,))


def get_playlist_removal_ids(db: DB, playlist_id: str) -> set[str]:
    """Return track IDs the user has manually removed from this playlist."""
    rows = db.fetchall(
        "SELECT track_id FROM playlist_removals WHERE playlist_id = ?",
        (playlist_id,),
    )
    return {str(r["track_id"]) for r in rows}


def record_playlist_removals(
    db: DB,
    playlist_id: str,
    rows: Iterable[PlaylistTrackRow],
) -> None:
    """Record tracks the user manually removed from a playlist."""
    payload = [(playlist_id, tid, uri) for (tid, uri) in rows]
    if not payload:
        return
    db.executemany(
        """INSERT INTO playlist_removals(playlist_id, track_id, track_uri)
           VALUES(?, ?, ?)
           ON CONFLICT(playlist_id, track_id) DO NOTHING""",
        payload,
    )


def remove_from_playlist_tracks(
    db: DB,
    playlist_id: str,
    track_ids: Iterable[str],
) -> None:
    """Delete specific tracks from playlist_tracks (after user removed them)."""
    for tid in track_ids:
        db.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?",
            (playlist_id, tid),
        )


def get_excluded_artists(db: DB) -> set[str]:
    """Return artist names the user has excluded from playlist generation."""
    rows = db.fetchall("SELECT artist_name FROM playlist_exclusions")
    return {str(r["artist_name"]) for r in rows}


def exclude_artist(db: DB, artist_name: str, playlist_id: str | None = None) -> None:
    """Record that the user does not want an auto-generated playlist for this artist."""
    db.execute(
        """INSERT INTO playlist_exclusions(artist_name, playlist_id)
           VALUES(?, ?)
           ON CONFLICT(artist_name) DO NOTHING""",
        (artist_name, playlist_id),
    )


def get_all_artist_playlists(db: DB) -> list[dict]:
    """Return all artist-type playlists with their track counts."""
    rows = db.fetchall(
        """
        SELECT p.playlist_id, p.name, p.artist_name,
               COUNT(pt.track_id) AS track_count
        FROM playlists p
        LEFT JOIN playlist_tracks pt ON p.playlist_id = pt.playlist_id
        WHERE p.playlist_type = 'artist'
        GROUP BY p.playlist_id
        """,
    )
    return [
        {
            "playlist_id": str(r["playlist_id"]),
            "name": str(r["name"]),
            "artist_name": str(r["artist_name"]) if r["artist_name"] else None,
            "track_count": int(r["track_count"]),
        }
        for r in rows
    ]


def get_artist_tracks_over_threshold(
    db: DB, artist_name: str, min_plays: int = 30,
) -> list[dict]:
    rows = db.fetchall(
        _load_sql("get_artist_tracks_over_threshold.sql"),
        (f"%{artist_name.lower()}%", min_plays),
    )
    return [
        {
            "track_id": str(r["track_id"]),
            "track_uri": str(r["track_uri"]),
            "track_name": str(r["track_name"]),
            "play_count": int(r["play_count"]),
        }
        for r in rows
    ]


def get_artist_top_tracks(
    db: DB, artist_name: str, limit: int = 50,
) -> list[dict]:
    rows = db.fetchall(
        _load_sql("get_artist_top_tracks.sql"),
        (f"%{artist_name.lower()}%", limit),
    )
    return [
        {
            "track_id": str(r["track_id"]),
            "track_uri": str(r["track_uri"]),
            "play_count": int(r["play_count"]),
        }
        for r in rows
    ]


def get_frequent_tracks(db: DB, min_plays: int) -> list[dict]:
    rows = db.fetchall(
        _load_sql("get_frequent_tracks_full.sql"),
        (min_plays,),
    )
    return [
        {
            "track_id": str(r["track_id"]),
            "track_uri": str(r["track_uri"]),
            "play_count": int(r["play_count"]),
        }
        for r in rows
    ]


def get_yearly_tracks(
    db: DB, start_ms: int, end_ms: int, limit: int,
) -> list[dict]:
    rows = db.fetchall(
        _load_sql("get_yearly_tracks.sql"),
        (start_ms, end_ms, limit),
    )
    return [
        {
            "track_id": str(r["track_id"]),
            "track_uri": str(r["track_uri"]),
            "play_count": int(r["play_count"]),
        }
        for r in rows
    ]


def get_hindi_favorites(db: DB, min_plays: int = 5) -> list[PlaylistTrackRow]:
    rows = db.fetchall(
        _load_sql("get_hindi_favorites.sql"),
        (min_plays,),
    )
    return [PlaylistTrackRow(track_id=str(r["track_id"]), track_uri=str(r["track_uri"])) for r in rows]


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


def upsert_track_artists(db: DB, rows: Sequence[TrackArtistRow]) -> None:
    if not rows:
        return
    db.executemany(_load_sql("upsert_track_artists.sql"), list(rows))


def upsert_artists(db: DB, rows: Sequence[ArtistRow]) -> None:
    if not rows:
        return
    db.executemany(_load_sql("upsert_artists.sql"), list(rows))


def get_unenriched_artist_ids(db: DB) -> list[str]:
    rows = db.fetchall(_load_sql("get_unenriched_artist_ids.sql"))
    return [str(r["artist_id"]) for r in rows]
