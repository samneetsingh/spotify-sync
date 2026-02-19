from __future__ import annotations

from conftest import FakeSpotify, make_config

from src.db.connection import DB
from src.db import queries
from src.ingestion.backfill_playlist import backfill_playlist_cache


def _make_track_item(track_id: str, track_uri: str, name: str = "Track") -> dict:
    return {
        "track": {
            "id": track_id,
            "uri": track_uri,
            "name": name,
            "album": {"name": "Album"},
            "artists": [{"name": "Artist"}],
            "duration_ms": 200_000,
            "explicit": False,
        }
    }


def test_backfill_writes_tracks_and_cache(tmp_path) -> None:
    """Backfilling should upsert tracks and mark them in playlist_tracks."""
    cfg = make_config(tmp_path)
    db = DB(cfg.db.path)
    db.migrate()

    items = [
        _make_track_item("t1", "spotify:track:1", "Song A"),
        _make_track_item("t2", "spotify:track:2", "Song B"),
    ]
    fake = FakeSpotify(playlist_items_payload={"items": items, "next": None})

    result = backfill_playlist_cache(cfg, db, fake, playlist_id="test-playlist")
    assert result.tracks_seen == 2
    assert result.tracks_written == 2
    assert result.playlist_id == "test-playlist"

    # Check tracks table
    tracks = db.fetchall("SELECT track_id FROM tracks")
    assert {r["track_id"] for r in tracks} == {"t1", "t2"}

    # Check playlist_tracks cache
    known = queries.get_known_playlist_track_ids(db, "test-playlist")
    assert known == {"t1", "t2"}
    db.close()


def test_backfill_deduplicates_tracks(tmp_path) -> None:
    """Duplicate tracks in the playlist should be deduplicated."""
    cfg = make_config(tmp_path)
    db = DB(cfg.db.path)
    db.migrate()

    items = [
        _make_track_item("t1", "spotify:track:1"),
        _make_track_item("t1", "spotify:track:1"),  # duplicate
        _make_track_item("t2", "spotify:track:2"),
    ]
    fake = FakeSpotify(playlist_items_payload={"items": items, "next": None})

    result = backfill_playlist_cache(cfg, db, fake, playlist_id="dedup-test")
    assert result.tracks_seen == 2
    assert result.tracks_written == 2
    db.close()


def test_backfill_skips_items_without_track_id(tmp_path) -> None:
    """Items with null track id or uri should be skipped."""
    cfg = make_config(tmp_path)
    db = DB(cfg.db.path)
    db.migrate()

    items = [
        _make_track_item("t1", "spotify:track:1"),
        {"track": {"id": None, "uri": "spotify:track:2"}},
        {"track": {"id": "t3", "uri": None}},
        {"track": None},
    ]
    fake = FakeSpotify(playlist_items_payload={"items": items, "next": None})

    result = backfill_playlist_cache(cfg, db, fake, playlist_id="partial")
    assert result.tracks_seen == 1
    assert result.tracks_written == 1
    db.close()


def test_backfill_pagination(tmp_path) -> None:
    """Backfill should paginate through all playlist items."""
    cfg = make_config(tmp_path)
    db = DB(cfg.db.path)
    db.migrate()

    # We simulate pagination by making FakeSpotify return different results
    # based on offset. Since FakeSpotify.playlist_items doesn't support
    # offset-based pagination natively, we use a custom subclass.
    class PaginatingFake(FakeSpotify):
        def __init__(self):
            super().__init__()
            self._call_count = 0

        def playlist_items(self, playlist_id, limit=100, offset=0, fields=None):
            self._call_count += 1
            if self._call_count == 1:
                return {
                    "items": [_make_track_item("t1", "spotify:track:1")],
                    "next": "http://next-page",
                }
            else:
                return {
                    "items": [_make_track_item("t2", "spotify:track:2")],
                    "next": None,
                }

    fake = PaginatingFake()
    result = backfill_playlist_cache(cfg, db, fake, playlist_id="paginated")
    assert result.tracks_seen == 2
    assert result.tracks_written == 2
    assert fake._call_count == 2
    db.close()


def test_backfill_defaults_to_all_playlist(tmp_path) -> None:
    """When no playlist_id is given, should default to all_playlist_id from config."""
    cfg = make_config(tmp_path)
    db = DB(cfg.db.path)
    db.migrate()

    fake = FakeSpotify(playlist_items_payload={"items": [], "next": None})
    result = backfill_playlist_cache(cfg, db, fake, playlist_id=None)
    assert result.playlist_id == "playlist123"
    db.close()


def test_backfill_empty_playlist(tmp_path) -> None:
    """Backfilling an empty playlist should succeed with zero counts."""
    cfg = make_config(tmp_path)
    db = DB(cfg.db.path)
    db.migrate()

    fake = FakeSpotify(playlist_items_payload={"items": [], "next": None})
    result = backfill_playlist_cache(cfg, db, fake, playlist_id="empty")
    assert result.tracks_seen == 0
    assert result.tracks_written == 0
    db.close()
