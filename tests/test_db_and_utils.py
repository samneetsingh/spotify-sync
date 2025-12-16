from __future__ import annotations

from datetime import datetime, timezone

import pytest

from src.db.connection import DB
from src.db import state
from src.utils.batching import chunk_list
from src.utils.time import iso8601_to_ms, now_ms


def test_migrate_creates_tables(tmp_path) -> None:
    db = DB(str(tmp_path / "db.sqlite"))
    db.migrate()
    tables = {
        row["name"]
        for row in db.fetchall(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )
    }
    expected = {
        "state",
        "tracks",
        "plays",
        "playlist_tracks",
        "sync_runs",
        "schema_migrations",
    }
    assert expected.issubset(tables)
    db.close()


def test_state_cursor_load_and_save(tmp_path) -> None:
    db = DB(str(tmp_path / "db.sqlite"))
    db.migrate()

    cursor = state.load_cursor_ms(db, "playlist123", bootstrap_hours=1)
    current = now_ms()
    assert current - 3_700_000 <= cursor <= current

    state.save_cursor_ms(db, "playlist123", 42)
    assert state.load_cursor_ms(db, "playlist123", bootstrap_hours=1) == 42
    db.close()


def test_iso8601_to_ms_z_and_offset() -> None:
    expected = int(datetime(2024, 1, 1, tzinfo=timezone.utc).timestamp() * 1000)
    assert iso8601_to_ms("2024-01-01T00:00:00Z") == expected
    assert iso8601_to_ms("2024-01-01T01:00:00+01:00") == expected


def test_chunk_list() -> None:
    chunks = list(chunk_list([1, 2, 3, 4, 5], 2))
    assert chunks == [[1, 2], [3, 4], [5]]

    with pytest.raises(ValueError):
        list(chunk_list([1, 2], 0))
