# src/db/connection.py
from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Optional

from .schema import MIGRATIONS, SCHEMA_VERSION


class DB:
    def __init__(self, db_path: str) -> None:
        self.db_path = db_path
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(db_path)
        self.conn.row_factory = sqlite3.Row

    def close(self) -> None:
        self.conn.close()

    def execute(self, sql: str, params: tuple = ()) -> None:
        self.conn.execute(sql, params)
        self.conn.commit()

    def executescript(self, sql: str) -> None:
        self.conn.executescript(sql)
        self.conn.commit()

    def fetchone(self, sql: str, params: tuple = ()) -> Optional[sqlite3.Row]:
        cur = self.conn.execute(sql, params)
        return cur.fetchone()

    def fetchall(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        cur = self.conn.execute(sql, params)
        return cur.fetchall()

    def executemany(self, sql: str, rows: list[tuple]) -> None:
        self.conn.executemany(sql, rows)
        self.conn.commit()

    def migrate(self) -> None:
        # 0) bootstrap migration table first
        self.executescript(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
            version     INTEGER PRIMARY KEY,
            applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
            );
            """
        )

        # 1) apply migrations in order
        for version, sql in MIGRATIONS:
            row = self.fetchone(
                "SELECT 1 FROM schema_migrations WHERE version = ?",
                (version,),
            )
            if row is None:
                self.executescript(sql)
                self.execute(
                    "INSERT INTO schema_migrations(version) VALUES(?)",
                    (version,),
                )

        # sanity check
        if SCHEMA_VERSION != MIGRATIONS[-1][0]:
            raise RuntimeError("SCHEMA_VERSION does not match latest migration")