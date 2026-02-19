from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import List

from src.config import AppConfig
from src.db import queries
from src.db.connection import DB
from src.ingestion.backfill_playlist import backfill_playlist_cache
from src.ingestion.spotify_client import SpotifyClient
from src.spotify_helpers import add_tracks_to_playlist


@dataclass(frozen=True)
class YearlyPlaylistResult:
    year: int
    playlist_id: str
    tracks_added: int
    tracks_considered: int


def build_yearly_playlist(
    cfg: AppConfig,
    db: DB,
    spotify: SpotifyClient,
    *,
    year: int,
    playlist_id: str,
    top_n: int | None = None,
) -> YearlyPlaylistResult:
    """
    Build a year-in-review playlist using plays in the DB for the given year.
    Orders by play count, then most recent play to break ties.
    """
    if cfg.spotify is None:
        raise RuntimeError("Spotify credentials not configured.")
    if cfg.add_batch_size <= 0:
        raise ValueError("add_batch_size must be positive")

    resolved_top_n = top_n if top_n is not None else cfg.yearly_max_tracks

    backfill_playlist_cache(cfg, db, spotify, playlist_id=playlist_id)

    start = int(datetime(year, 1, 1, tzinfo=timezone.utc).timestamp() * 1000)
    end = int(datetime(year + 1, 1, 1, tzinfo=timezone.utc).timestamp() * 1000)

    rows = queries.get_yearly_tracks(db, start, end, resolved_top_n)

    known = queries.get_known_playlist_track_ids(db, playlist_id)
    to_add: List[tuple[str, str]] = [
        (str(r["track_id"]), str(r["track_uri"])) for r in rows if str(r["track_id"]) not in known
    ]

    tracks_added = add_tracks_to_playlist(spotify, playlist_id, [uri for (_tid, uri) in to_add], cfg.add_batch_size)
    if to_add:
        queries.mark_tracks_in_playlist(db, playlist_id, to_add)

    return YearlyPlaylistResult(
        year=year,
        playlist_id=playlist_id,
        tracks_added=tracks_added,
        tracks_considered=len(rows),
    )
