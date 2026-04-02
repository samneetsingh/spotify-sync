from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Iterable, List

from src.config import AppConfig
from src.db import queries
from src.db.connection import DB
from src.db.queries import PlaylistTrackRow, TrackArtistRow, TrackRow
from src.ingestion.spotify_client import SpotifyClient
from src.spotify_helpers import LIKED_CACHE_ID, extract_track_metadata

log = logging.getLogger("backfill_playlist")


@dataclass(frozen=True)
class BackfillResult:
    playlist_id: str
    tracks_seen: int
    tracks_written: int


def _fetch_playlist_items(sp: SpotifyClient, playlist_id: str, limit: int = 100) -> Iterable[dict]:
    # Special case: liked cache uses saved tracks API (max limit: 50)
    if playlist_id == LIKED_CACHE_ID:
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
                fields="items(track(id,uri,name,album(name,release_date),artists(id,name),duration_ms,explicit,popularity,external_ids)),next",
            )
            items = resp.get("items") or []
            for item in items:
                yield item
            if not resp.get("next"):
                break
            offset += limit


def backfill_playlist_cache(cfg: AppConfig, db: DB, sp: SpotifyClient, playlist_id: str | None = None) -> BackfillResult:
    """
    Pull all tracks currently in the playlist and mirror them into playlist_tracks
    (and upsert into tracks). This does NOT modify the playlist; it only updates
    local cache to avoid duplicate adds during ingestion.
    """
    if cfg.spotify is None:
        raise RuntimeError("Spotify credentials not configured.")
    playlist_id = playlist_id or cfg.spotify.all_playlist_id

    track_rows: List[TrackRow] = []
    playlist_rows: List[PlaylistTrackRow] = []
    track_artist_rows: List[TrackArtistRow] = []
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
        meta = extract_track_metadata(track)

        track_rows.append(TrackRow(
            track_id=track_id,
            track_uri=track_uri,
            name=track.get("name"),
            artists=meta.artist_names,
            album=album.get("name"),
            duration_ms=track.get("duration_ms"),
            explicit=meta.explicit_int,
            popularity=meta.popularity,
            release_date=meta.release_date,
            isrc=meta.isrc,
        ))
        playlist_rows.append(PlaylistTrackRow(track_id=track_id, track_uri=track_uri))

        for i, info in enumerate(meta.artist_infos):
            track_artist_rows.append(TrackArtistRow(
                track_id=track_id,
                artist_id=info.artist_id,
                artist_name=info.name,
                position=i,
            ))

    queries.upsert_tracks(db, track_rows)
    queries.mark_tracks_in_playlist(db, playlist_id, playlist_rows)
    queries.upsert_track_artists(db, track_artist_rows)

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
