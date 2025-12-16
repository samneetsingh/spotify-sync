from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from src.config import AppConfig, DbConfig, SpotifyConfig
from src.db.connection import DB
from src.db import queries
from src.ingestion.sync_recent import sync_recent, sync_all_tracks
from src.utils.time import iso8601_to_ms


class FakeSpotify:
    def __init__(self, payload: dict, *, playlist_total: int | None = None) -> None:
        self.payload = payload
        self.add_calls: list[dict] = []
        self.saved_calls: list[list[str]] = []
        self.recently_played_args: list[dict] = []
        self.playlist_total = playlist_total

    def current_user_recently_played(self, *, limit: int, after: int) -> dict:
        self.recently_played_args.append({"limit": limit, "after": after})
        return self.payload

    def playlist_add_items(self, playlist_id: str, items: list[str]) -> dict:
        self.add_calls.append({"playlist_id": playlist_id, "items": list(items)})
        return {}

    def current_user_saved_tracks_add(self, tracks: list[str]) -> dict:
        self.saved_calls.append(list(tracks))
        return {}

    def playlist(self, playlist_id: str, fields: str | None = None) -> dict:
        if self.playlist_total is None:
            return {"tracks": {"total": 0}}
        return {"tracks": {"total": self.playlist_total}}


def make_config(tmp_path) -> AppConfig:
    return AppConfig(
        db=DbConfig(path=str(tmp_path / "db.sqlite")),
        spotify=SpotifyConfig(
            client_id="id",
            client_secret="secret",
            redirect_uri="https://example.com/callback",
            scope="user-read-recently-played playlist-modify-private user-library-modify user-library-read",
            all_playlist_id="playlist123",
            frequent_playlist_id=None,
            frequent_min_plays=2,
            like_batch_size=50,
            cache_path=str(tmp_path / ".cache"),
        ),
        log_level="DEBUG",
        like_batch_size=50,
    )


def make_config_with_freq(tmp_path) -> AppConfig:
    cfg = make_config(tmp_path)
    return AppConfig(
        db=cfg.db,
        spotify=SpotifyConfig(
            client_id=cfg.spotify.client_id,
            client_secret=cfg.spotify.client_secret,
            redirect_uri=cfg.spotify.redirect_uri,
            scope=cfg.spotify.scope,
            all_playlist_id=cfg.spotify.all_playlist_id,
            frequent_playlist_id="freq123",
            frequent_min_plays=2,
            like_batch_size=cfg.spotify.like_batch_size,
            cache_path=cfg.spotify.cache_path,
        ),
        log_level=cfg.log_level,
        bootstrap_hours=cfg.bootstrap_hours,
        recently_played_limit=cfg.recently_played_limit,
        add_batch_size=cfg.add_batch_size,
        like_batch_size=cfg.like_batch_size,
    )


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
    assert len(fake.add_calls) == 1  # playlist mirror

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

    # Running again with same payload should be idempotent for plays + playlist updates
    sync_recent(cfg, db, fake)
    assert len(db.fetchall("SELECT played_at_ms FROM plays")) == 2
    assert len(fake.saved_calls) == 1
    assert len(fake.add_calls) == 1
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
    queries.mark_tracks_in_playlist(db, cfg.spotify.all_playlist_id, [("t1", "spotify:track:1")])

    fake = FakeSpotify({})
    added = sync_all_tracks(cfg, db, fake)
    # liked songs adds both; playlist adds t2
    assert added == 3
    assert fake.saved_calls and sorted(fake.saved_calls[0]) == ["t1", "t2"]
    assert fake.add_calls and fake.add_calls[0]["items"] == ["spotify:track:2"]


def test_sync_all_tracks_respects_capacity(tmp_path) -> None:
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
    # capacity zero
    fake = FakeSpotify({}, playlist_total=10_000)
    added = sync_all_tracks(cfg, db, fake)
    # liked still added, playlist blocked
    assert added == 2
    assert fake.add_calls == []
    assert fake.saved_calls and sorted(fake.saved_calls[0]) == ["t1", "t2"]


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
    queries.mark_tracks_in_playlist(
        db, cfg.spotify.all_playlist_id, [("track-1", "spotify:track:1")]
    )

    payload = {"items": [_play_item("2024-01-01T00:00:00Z", "track-1", "spotify:track:1")]}
    fake = FakeSpotify(payload)

    sync_recent(cfg, db, fake)
    # liked already cached; playlist mirror should still be blocked because also cached? not cached for playlist
    assert fake.saved_calls == []
    assert fake.add_calls == []
    db.close()


def test_sync_frequent_uses_full_history(tmp_path) -> None:
    cfg = make_config_with_freq(tmp_path)
    db = DB(cfg.db.path)
    db.migrate()

    # Track t1 played 3 times, not in recent payload; t2 appears in recent with 1 play
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
    # Frequent should NOT add t1 yet (current batch only)
    assert result.frequent_added == 0
    fake.add_calls.clear()

    # Full sync should add based on full history
    sync_all_tracks(cfg, db, fake)
    assert any(call["playlist_id"] == "freq123" and call["items"] == ["spotify:track:1"] for call in fake.add_calls)
    db.close()


def test_playlist_adds_are_batched(tmp_path) -> None:
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

    assert len(fake.saved_calls) >= 3  # liked songs batches of 50
    assert max(len(call) for call in fake.saved_calls) <= 50
    assert len(fake.add_calls) == 3
    assert max(len(call["items"]) for call in fake.add_calls) <= 100
    db.close()
