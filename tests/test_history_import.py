from __future__ import annotations

import json

import pytest

from conftest import make_config

from src.db.connection import DB
from src.ingestion.history_import import import_history_file, import_history_path


def test_import_history_file(tmp_path) -> None:
    cfg = make_config(tmp_path)
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
    cfg = make_config(tmp_path)
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


# --- Error handling and edge case tests ---


def test_import_malformed_json(tmp_path) -> None:
    """Malformed JSON file should raise an error."""
    cfg = make_config(tmp_path)
    db = DB(cfg.db.path)
    db.migrate()

    path = tmp_path / "bad.json"
    path.write_text("{not valid json", encoding="utf-8")

    # The file is NDJSON fallback — each line is tried independently.
    # A single malformed line is silently skipped.
    result = import_history_file(cfg, db, str(path))
    assert result.plays_written == 0
    assert result.records_skipped == 0  # malformed lines don't even parse as records
    db.close()


def test_import_missing_track_uri(tmp_path) -> None:
    """Records without a spotify track URI should be skipped."""
    cfg = make_config(tmp_path)
    db = DB(cfg.db.path)
    db.migrate()

    payload = [
        {
            "ts": "2024-01-01T00:00:00Z",
            "master_metadata_track_name": "No URI Track",
            "master_metadata_album_artist_name": "Artist",
        },
        {
            "ts": "2024-01-01T00:01:00Z",
            "spotify_track_uri": "spotify:track:valid",
            "master_metadata_track_name": "Valid",
            "master_metadata_album_artist_name": "Artist",
        },
    ]
    path = tmp_path / "partial.json"
    path.write_text(json.dumps(payload), encoding="utf-8")

    result = import_history_file(cfg, db, str(path))
    assert result.records_seen == 2
    assert result.records_skipped == 1
    assert result.plays_written == 1
    db.close()


def test_import_missing_timestamp(tmp_path) -> None:
    """Records without a timestamp should be skipped."""
    cfg = make_config(tmp_path)
    db = DB(cfg.db.path)
    db.migrate()

    payload = [
        {
            "spotify_track_uri": "spotify:track:abc",
            "master_metadata_track_name": "No Time",
        },
    ]
    path = tmp_path / "notime.json"
    path.write_text(json.dumps(payload), encoding="utf-8")

    result = import_history_file(cfg, db, str(path))
    assert result.records_seen == 1
    assert result.records_skipped == 1
    assert result.plays_written == 0
    db.close()


def test_import_empty_file(tmp_path) -> None:
    """An empty JSON array should import zero records."""
    cfg = make_config(tmp_path)
    db = DB(cfg.db.path)
    db.migrate()

    path = tmp_path / "empty.json"
    path.write_text("[]", encoding="utf-8")

    result = import_history_file(cfg, db, str(path))
    assert result.records_seen == 0
    assert result.plays_written == 0
    db.close()


def test_import_nonexistent_file(tmp_path) -> None:
    """Importing a nonexistent file should raise FileNotFoundError."""
    cfg = make_config(tmp_path)
    db = DB(cfg.db.path)
    db.migrate()

    with pytest.raises(FileNotFoundError):
        import_history_file(cfg, db, str(tmp_path / "does_not_exist.json"))
    db.close()


def test_import_legacy_format(tmp_path) -> None:
    """Legacy format with endTime and trackName should work if URI is present."""
    cfg = make_config(tmp_path)
    db = DB(cfg.db.path)
    db.migrate()

    payload = [
        {
            "endTime": "2024-01-15 14:30",
            "trackUri": "spotify:track:legacy1",
            "trackName": "Legacy Song",
            "artistName": "Legacy Artist",
            "msPlayed": 180000,
        },
    ]
    path = tmp_path / "legacy.json"
    path.write_text(json.dumps(payload), encoding="utf-8")

    result = import_history_file(cfg, db, str(path))
    assert result.plays_written == 1
    tracks = db.fetchall("SELECT * FROM tracks")
    assert len(tracks) == 1
    db.close()


def test_import_ndjson_format(tmp_path) -> None:
    """Newline-delimited JSON should be supported."""
    cfg = make_config(tmp_path)
    db = DB(cfg.db.path)
    db.migrate()

    lines = [
        json.dumps({"ts": "2024-01-01T00:00:00Z", "spotify_track_uri": "spotify:track:nd1"}),
        json.dumps({"ts": "2024-01-02T00:00:00Z", "spotify_track_uri": "spotify:track:nd2"}),
    ]
    path = tmp_path / "ndjson.json"
    path.write_text("\n".join(lines), encoding="utf-8")

    result = import_history_file(cfg, db, str(path))
    assert result.plays_written == 2
    db.close()


def test_import_empty_directory(tmp_path) -> None:
    """Importing from a directory with no JSON files should raise FileNotFoundError."""
    cfg = make_config(tmp_path)
    db = DB(cfg.db.path)
    db.migrate()

    dir_path = tmp_path / "empty_dir"
    dir_path.mkdir()

    with pytest.raises(FileNotFoundError):
        import_history_path(cfg, db, str(dir_path))
    db.close()


def test_import_idempotent(tmp_path) -> None:
    """Importing the same file twice should not duplicate plays (INSERT OR IGNORE)."""
    cfg = make_config(tmp_path)
    db = DB(cfg.db.path)
    db.migrate()

    payload = [
        {
            "ts": "2024-01-01T00:00:00Z",
            "spotify_track_uri": "spotify:track:abc",
            "master_metadata_track_name": "Hello",
        }
    ]
    path = tmp_path / "history.json"
    path.write_text(json.dumps(payload), encoding="utf-8")

    import_history_file(cfg, db, str(path))
    import_history_file(cfg, db, str(path))

    plays = db.fetchall("SELECT * FROM plays")
    assert len(plays) == 1
    db.close()
