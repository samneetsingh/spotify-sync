from __future__ import annotations

from datetime import datetime, timedelta, timezone
from dataclasses import replace

import pytest

from conftest import FakeSpotify, make_config, make_config_with_freq

from src.db.connection import DB
from src.db import queries, state
from src.ingestion.sync_recent import sync_recent, sync_all_tracks
from src.utils.time import iso8601_to_ms


def _play_item(played_at: str, track_id: str, track_uri: str) -> dict:
    return {
        "played_at": played_at,
        "track": {
            "id": track_id,
            "uri": track_uri,
            "name": f"Track {track_id}",
            "album": {"name": "Album"},
            "artists": [{"name": "Artist"}],
            "duration_ms": 1000,
            "explicit": False,
        },
        "context": {"type": "playlist", "uri": "spotify:playlist:context"},
    }


def test_sync_recent_persists_and_advances_cursor(tmp_path) -> None:
    cfg = make_config(tmp_path)
    db = DB(cfg.db.path)
    db.migrate()

    payload = {
        "items": [
            _play_item("2024-01-01T00:00:00Z", "t1", "spotify:track:1"),
            _play_item("2024-01-01T00:05:00Z", "t2", "spotify:track:2"),
        ]
    }
    fake = FakeSpotify(payload)

    result = sync_recent(cfg, db, fake)
    assert result.plays_fetched == 2
    assert len(fake.saved_calls) == 1
    assert fake.add_calls == []

    tracks = db.fetchall("SELECT track_id FROM tracks")
    assert {row["track_id"] for row in tracks} == {"t1", "t2"}

    plays = db.fetchall("SELECT played_at_ms FROM plays")
    assert len(plays) == 2

    cursor_row = db.fetchone(
        "SELECT value FROM state WHERE key = ?", ("cursor_after_ms:playlist123",)
    )
    assert cursor_row is not None
    expected_cursor = iso8601_to_ms("2024-01-01T00:05:00Z") + 1
    assert int(cursor_row["value"]) == expected_cursor

    # Running again with same payload should be idempotent
    sync_recent(cfg, db, fake)
    assert len(db.fetchall("SELECT played_at_ms FROM plays")) == 2
    assert len(fake.saved_calls) == 1
    assert fake.add_calls == []
    db.close()


def test_sync_all_tracks_adds_missing(tmp_path) -> None:
    cfg = make_config(tmp_path)
    db = DB(cfg.db.path)
    db.migrate()

    queries.upsert_tracks(
        db,
        [
            ("t1", "spotify:track:1", "Name", "Artist", "Album", 123, 0),
            ("t2", "spotify:track:2", "Name2", "Artist2", "Album2", 456, 0),
        ],
    )

    fake = FakeSpotify({})
    added = sync_all_tracks(cfg, db, fake)
    assert added == 2
    assert fake.saved_calls and sorted(fake.saved_calls[0]) == ["t1", "t2"]
    assert fake.add_calls == []


def test_sync_all_tracks_skips_already_liked(tmp_path) -> None:
    cfg = make_config(tmp_path)
    db = DB(cfg.db.path)
    db.migrate()

    queries.upsert_tracks(
        db,
        [
            ("t1", "spotify:track:1", "Name", "Artist", "Album", 123, 0),
            ("t2", "spotify:track:2", "Name2", "Artist2", "Album2", 456, 0),
        ],
    )
    queries.mark_tracks_in_playlist(db, "__liked__", [("t1", "spotify:track:1")])
    fake = FakeSpotify({})
    added = sync_all_tracks(cfg, db, fake)
    assert added == 1
    assert fake.saved_calls and fake.saved_calls[0] == ["t2"]


def test_sync_recent_skips_known_playlist_tracks(tmp_path) -> None:
    cfg = make_config(tmp_path)
    db = DB(cfg.db.path)
    db.migrate()

    queries.upsert_tracks(
        db,
        [("track-1", "spotify:track:1", "Name", "Artist", "Album", 123, 0)],
    )
    queries.mark_tracks_in_playlist(
        db, "__liked__", [("track-1", "spotify:track:1")]
    )

    payload = {"items": [_play_item("2024-01-01T00:00:00Z", "track-1", "spotify:track:1")]}
    fake = FakeSpotify(payload)

    sync_recent(cfg, db, fake)
    assert fake.saved_calls == []
    assert fake.add_calls == []
    db.close()


def test_sync_recent_paginates(tmp_path) -> None:
    cfg = replace(make_config(tmp_path), recently_played_limit=1)
    db = DB(cfg.db.path)
    db.migrate()
    state.save_cursor_ms(db, cfg.spotify.all_playlist_id, 0)

    first_play = _play_item("2024-01-01T00:00:00Z", "t1", "spotify:track:1")
    second_play = _play_item("2024-01-01T00:05:00Z", "t2", "spotify:track:2")
    ms1 = iso8601_to_ms(first_play["played_at"])
    pages = {
        0: {"items": [first_play]},
        ms1: {"items": [second_play]},
    }
    fake = FakeSpotify(pages=pages)

    result = sync_recent(cfg, db, fake)
    assert result.plays_fetched == 2
    assert len(fake.recently_played_args) >= 2
    assert {row["track_id"] for row in db.fetchall("SELECT track_id FROM tracks")} == {"t1", "t2"}
    db.close()


def test_sync_recent_records_failure(tmp_path) -> None:
    cfg = make_config(tmp_path)
    db = DB(cfg.db.path)
    db.migrate()

    fake = FakeSpotify(raise_on_call=True)
    with pytest.raises(RuntimeError):
        sync_recent(cfg, db, fake)

    row = db.fetchone("SELECT status, error FROM sync_runs ORDER BY id DESC LIMIT 1")
    assert row is not None
    assert row["status"] == "fail"
    assert "boom" in row["error"]
    db.close()


def test_sync_frequent_uses_full_history(tmp_path) -> None:
    cfg = make_config_with_freq(tmp_path)
    db = DB(cfg.db.path)
    db.migrate()

    queries.upsert_tracks(
        db,
        [
            ("t1", "spotify:track:1", "Name1", "Artist", "Album", 123, 0),
            ("t2", "spotify:track:2", "Name2", "Artist", "Album2", 123, 0),
        ],
    )
    queries.insert_plays(
        db,
        [
            (1, "t1", "spotify:track:1", None, None, "history_import"),
            (2, "t1", "spotify:track:1", None, None, "history_import"),
            (3, "t1", "spotify:track:1", None, None, "history_import"),
        ],
    )

    payload = {
        "items": [
            _play_item("2024-01-01T00:00:00Z", "t2", "spotify:track:2"),
        ]
    }
    fake = FakeSpotify(payload)
    result = sync_recent(cfg, db, fake)
    assert result.frequent_added == 0
    fake.add_calls.clear()

    sync_all_tracks(cfg, db, fake)
    assert any(call["playlist_id"] == "freq123" and call["items"] == ["spotify:track:1"] for call in fake.add_calls)
    db.close()


def test_liked_adds_are_batched(tmp_path) -> None:
    cfg = make_config(tmp_path)
    db = DB(cfg.db.path)
    db.migrate()

    base = datetime(2024, 1, 1, tzinfo=timezone.utc)
    items = []
    for i in range(205):
        played_at = (base + timedelta(minutes=i)).isoformat()
        items.append(_play_item(played_at, f"track-{i}", f"spotify:track:{i}"))

    fake = FakeSpotify({"items": items})
    sync_recent(cfg, db, fake)

    assert len(fake.saved_calls) >= 3
    assert max(len(call) for call in fake.saved_calls) <= 50
    assert fake.add_calls == []
    db.close()


# --- Edge case tests ---


def test_sync_recent_empty_api_response(tmp_path) -> None:
    """Sync with empty API response should complete without error."""
    cfg = make_config(tmp_path)
    db = DB(cfg.db.path)
    db.migrate()

    fake = FakeSpotify({"items": []})
    result = sync_recent(cfg, db, fake)
    assert result.plays_fetched == 0
    assert result.liked_added == 0
    assert fake.saved_calls == []
    assert fake.add_calls == []
    db.close()


def test_sync_recent_none_api_response(tmp_path) -> None:
    """Sync where API returns None should handle gracefully."""
    cfg = make_config(tmp_path)
    db = DB(cfg.db.path)
    db.migrate()

    fake = FakeSpotify({})  # empty dict, no "items" key
    result = sync_recent(cfg, db, fake)
    assert result.plays_fetched == 0
    db.close()


def test_sync_recent_null_fields_in_track(tmp_path) -> None:
    """Tracks with null/missing fields should be skipped gracefully."""
    cfg = make_config(tmp_path)
    db = DB(cfg.db.path)
    db.migrate()

    payload = {
        "items": [
            # Valid track
            _play_item("2024-01-01T00:00:00Z", "t1", "spotify:track:1"),
            # Track with missing id
            {
                "played_at": "2024-01-01T00:01:00Z",
                "track": {"id": None, "uri": "spotify:track:2", "name": "NoId"},
                "context": {},
            },
            # Track with missing uri
            {
                "played_at": "2024-01-01T00:02:00Z",
                "track": {"id": "t3", "uri": None, "name": "NoUri"},
                "context": {},
            },
            # Item with no track at all
            {
                "played_at": "2024-01-01T00:03:00Z",
                "track": None,
                "context": {},
            },
            # Item with no played_at
            {
                "played_at": None,
                "track": {"id": "t5", "uri": "spotify:track:5", "name": "NoTime"},
                "context": {},
            },
        ]
    }
    fake = FakeSpotify(payload)
    result = sync_recent(cfg, db, fake)
    # Only the first valid item should be persisted
    assert result.plays_fetched == 1
    tracks = db.fetchall("SELECT track_id FROM tracks")
    assert {r["track_id"] for r in tracks} == {"t1"}
    db.close()
