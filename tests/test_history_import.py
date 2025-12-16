from __future__ import annotations

import json

from src.config import AppConfig, DbConfig, SpotifyConfig
from src.db.connection import DB
from src.ingestion.history_import import import_history_file, import_history_path


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
        like_batch_size=50,
    )


def test_import_history_file(tmp_path) -> None:
    cfg = _cfg(tmp_path)
    db = DB(cfg.db.path)
    db.migrate()

    payload = [
        {
            "ts": "2024-01-01T00:00:00Z",
            "spotify_track_uri": "spotify:track:abc",
            "master_metadata_track_name": "Hello",
            "master_metadata_album_artist_name": "Artist",
            "master_metadata_album_album_name": "Album",
            "ms_played": 123_000,
        }
    ]
    path = tmp_path / "history.json"
    path.write_text(json.dumps(payload), encoding="utf-8")

    result = import_history_file(cfg, db, str(path))
    assert result.plays_written == 1
    assert result.tracks_written == 1
    plays = db.fetchall("SELECT * FROM plays")
    assert len(plays) == 1
    tracks = db.fetchall("SELECT * FROM tracks")
    assert len(tracks) == 1
    db.close()


def test_import_history_directory(tmp_path) -> None:
    cfg = _cfg(tmp_path)
    db = DB(cfg.db.path)
    db.migrate()

    payload1 = [
        {
            "ts": "2024-01-01T00:00:00Z",
            "spotify_track_uri": "spotify:track:abc",
            "master_metadata_track_name": "Hello",
            "master_metadata_album_artist_name": "Artist",
            "master_metadata_album_album_name": "Album",
            "ms_played": 123_000,
        }
    ]
    payload2 = [
        {
            "ts": "2024-02-01T00:00:00Z",
            "spotify_track_uri": "spotify:track:def",
            "master_metadata_track_name": "World",
            "master_metadata_album_artist_name": "Artist2",
            "master_metadata_album_album_name": "Album2",
            "ms_played": 120_000,
        }
    ]
    dir_path = tmp_path / "history_dir"
    dir_path.mkdir()
    (dir_path / "a.json").write_text(json.dumps(payload1), encoding="utf-8")
    (dir_path / "b.json").write_text(json.dumps(payload2), encoding="utf-8")

    result = import_history_path(cfg, db, str(dir_path))
    assert result.files_processed == 2
    assert result.plays_written == 2
    plays = db.fetchall("SELECT * FROM plays")
    assert len(plays) == 2
    db.close()
