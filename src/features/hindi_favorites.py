from __future__ import annotations

from dataclasses import dataclass
from typing import List

from src.config import AppConfig
from src.db import queries
from src.db.connection import DB
from src.ingestion.backfill_playlist import backfill_playlist_cache
from src.ingestion.spotify_client import SpotifyClient
from src.spotify_helpers import add_tracks_to_playlist


@dataclass(frozen=True)
class HindiFavoritesResult:
    playlist_id: str
    tracks_added: int
    tracks_considered: int


def build_hindi_favorites(
    cfg: AppConfig,
    db: DB,
    spotify: SpotifyClient,
) -> HindiFavoritesResult:
    """
    Populate an existing playlist with the user's most-played Hindi/Desi songs.
    A track qualifies if any of its artists have genres matching
    bollywood, hindi, filmi, or desi, and it has enough plays.
    Safe to re-run — only adds tracks not already in the playlist.
    """
    if cfg.spotify is None:
        raise RuntimeError("Spotify credentials not configured.")
    if cfg.spotify.hindi_favorites_playlist_id is None:
        raise RuntimeError("SPOTIFY_HINDI_FAVORITES_PLAYLIST_ID not configured.")
    if cfg.add_batch_size <= 0:
        raise ValueError("add_batch_size must be positive")

    playlist_id = cfg.spotify.hindi_favorites_playlist_id
    min_plays = cfg.spotify.hindi_favorites_min_plays

    backfill_playlist_cache(cfg, db, spotify, playlist_id=playlist_id)

    rows = queries.get_hindi_favorites(db, min_plays)

    known = queries.get_known_playlist_track_ids(db, playlist_id)
    to_add: List[tuple[str, str]] = [
        (r.track_id, r.track_uri) for r in rows if r.track_id not in known
    ]

    tracks_added = add_tracks_to_playlist(spotify, playlist_id, [uri for (_tid, uri) in to_add], cfg.add_batch_size)
    if to_add:
        queries.mark_tracks_in_playlist(db, playlist_id, to_add)

    return HindiFavoritesResult(
        playlist_id=playlist_id,
        tracks_added=tracks_added,
        tracks_considered=len(rows),
    )
