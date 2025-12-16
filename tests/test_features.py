from __future__ import annotations

from datetime import datetime, timezone

from src.config import AppConfig, DbConfig, SpotifyConfig
from src.db.connection import DB
from src.db import queries
from src.features.artist_playlists import build_artist_playlist
from src.features.yearly_playlists import build_yearly_playlist


class FakeSpotify:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    def playlist_add_items(self, playlist_id: str, items: list[str]) -> dict:
        self.calls.append({"playlist_id": playlist_id, "items": list(items)})
        return {}


def _cfg(tmp_path) -> AppConfig:
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


def _seed(db: DB) -> None:
    db.migrate()
    queries.upsert_tracks(
        db,
        [
            ("t1", "spotify:track:1", "Song1", "Artist A", "Album", 1000, 0),
            ("t2", "spotify:track:2", "Song2", "Artist B", "Album", 1000, 0),
        ],
    )
    base_ms = int(datetime(2023, 1, 1, tzinfo=timezone.utc).timestamp() * 1000)
    queries.insert_plays(
        db,
        [
            (base_ms, "t1", "spotify:track:1", None, None, "recently_played"),
            (base_ms + 1000, "t1", "spotify:track:1", None, None, "recently_played"),
            (base_ms + 2_000_000, "t2", "spotify:track:2", None, None, "recently_played"),
        ],
    )


def test_build_artist_playlist(tmp_path) -> None:
    cfg = _cfg(tmp_path)
    db = DB(cfg.db.path)
    _seed(db)
    fake = FakeSpotify()

    result = build_artist_playlist(
        cfg,
        db,
        fake,
        artist_name="artist a",
        playlist_id="plist-artist-a",
        top_n=10,
    )

    assert result.tracks_added == 1
    assert fake.calls and fake.calls[0]["playlist_id"] == "plist-artist-a"
    assert fake.calls[0]["items"] == ["spotify:track:1"]
    db.close()


def test_build_yearly_playlist(tmp_path) -> None:
    cfg = _cfg(tmp_path)
    db = DB(cfg.db.path)
    _seed(db)
    fake = FakeSpotify()

    result = build_yearly_playlist(
        cfg,
        db,
        fake,
        year=2023,
        playlist_id="plist-2023",
        top_n=10,
    )

    assert result.tracks_considered == 2
    assert result.tracks_added == 2
    assert len(fake.calls) == 1
    assert set(fake.calls[0]["items"]) == {"spotify:track:1", "spotify:track:2"}
    db.close()
