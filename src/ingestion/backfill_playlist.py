from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Iterable, List, Tuple

from src.config import AppConfig
from src.db import queries
from src.db.connection import DB
from src.ingestion.spotify_client import SpotifyClient
from src.utils.batching import chunk_list

log = logging.getLogger("backfill_playlist")


@dataclass(frozen=True)
class BackfillResult:
    playlist_id: str
    tracks_seen: int
    tracks_written: int


def _fetch_playlist_items(sp: SpotifyClient, playlist_id: str, limit: int = 100) -> Iterable[dict]:
    # Special case: __liked__ means use saved tracks API (max limit: 50)
    if playlist_id == "__liked__":
        offset = 0
        liked_limit = min(limit, 50)  # Spotify's saved tracks API has max limit of 50
        while True:
            resp = sp.current_user_saved_tracks(limit=liked_limit, offset=offset)
            items = resp.get("items") or []
            for item in items:
                yield item
            if not resp.get("next"):
                break
            offset += limit
    else:
        offset = 0
        while True:
            resp = sp.playlist_items(
                playlist_id,
                limit=limit,
                offset=offset,
                fields="items(track(id,uri,name,album(name),artists(name),duration_ms,explicit)),next",
            )
            items = resp.get("items") or []
            for item in items:
                yield item
            if not resp.get("next"):
                break
            offset += limit


def _add_to_playlist(sp: SpotifyClient, playlist_id: str, uris: Iterable[str], batch_size: int) -> None:
    for batch in chunk_list(uris, batch_size):
        if not batch:
            continue
        sp.playlist_add_items(playlist_id, list(batch))


def backfill_playlist_cache(cfg: AppConfig, db: DB, sp: SpotifyClient, playlist_id: str | None = None) -> BackfillResult:
    """
    Pull all tracks currently in the playlist and mirror them into playlist_tracks
    (and upsert into tracks). This does NOT modify the playlist; it only updates
    local cache to avoid duplicate adds during ingestion.
    """
    if cfg.spotify is None:
        raise RuntimeError("Spotify credentials not configured.")
    playlist_id = playlist_id or cfg.spotify.all_playlist_id

    track_rows: List[Tuple[str, str, str | None, str | None, str | None, int | None, int | None]] = []
    playlist_rows: List[Tuple[str, str]] = []
    seen_ids: set[str] = set()

    for item in _fetch_playlist_items(sp, playlist_id):
        track = item.get("track") or {}
        track_id = track.get("id")
        track_uri = track.get("uri")
        if not track_id or not track_uri:
            continue
        if track_id in seen_ids:
            continue
        seen_ids.add(track_id)

        album = track.get("album") or {}
        artists = track.get("artists") or []
        artist_names = ", ".join([a.get("name") for a in artists if a.get("name")]) or None
        explicit_flag = track.get("explicit")
        explicit_int = 1 if explicit_flag is True else 0 if explicit_flag is False else None

        track_rows.append(
            (
                track_id,
                track_uri,
                track.get("name"),
                artist_names,
                album.get("name"),
                track.get("duration_ms"),
                explicit_int,
            )
        )
        playlist_rows.append((track_id, track_uri))

    queries.upsert_tracks(db, track_rows)
    queries.mark_tracks_in_playlist(db, playlist_id, playlist_rows)

    log.info(
        "Backfilled playlist cache for %s | seen=%s written=%s",
        playlist_id,
        len(seen_ids),
        len(playlist_rows),
    )
    return BackfillResult(
        playlist_id=playlist_id,
        tracks_seen=len(seen_ids),
        tracks_written=len(playlist_rows),
    )
