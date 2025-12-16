# src/db/state.py
from __future__ import annotations

import time
from .connection import DB


def get_state(db: DB, key: str) -> str | None:
    row = db.fetchone("SELECT value FROM state WHERE key = ?", (key,))
    return None if row is None else str(row["value"])


def set_state(db: DB, key: str, value: str) -> None:
    db.execute(
        """
        INSERT INTO state(key, value, updated_at)
        VALUES(?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET
          value=excluded.value,
          updated_at=datetime('now')
        """,
        (key, value),
    )


def cursor_key_for_playlist(playlist_id: str) -> str:
    return f"cursor_after_ms:{playlist_id}"


def load_cursor_ms(db: DB, playlist_id: str, bootstrap_hours: int = 24) -> int:
    key = cursor_key_for_playlist(playlist_id)
    v = get_state(db, key)
    if v is not None:
        return int(v)
    now_ms = int(time.time() * 1000)
    return now_ms - int(bootstrap_hours * 60 * 60 * 1000)


def save_cursor_ms(db: DB, playlist_id: str, after_ms: int) -> None:
    set_state(db, cursor_key_for_playlist(playlist_id), str(after_ms))