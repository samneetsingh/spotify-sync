from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, List

from src.config import AppConfig
from src.db import queries
from src.db.connection import DB
from src.ingestion.spotify_client import SpotifyClient
from src.utils.batching import chunk_list


@dataclass(frozen=True)
class ArtistPlaylistResult:
    artist: str
    playlist_id: str
    tracks_added: int
    tracks_considered: int


def build_artist_playlist(
    cfg: AppConfig,
    db: DB,
    spotify: SpotifyClient,
    *,
    artist_name: str,
    playlist_id: str,
    top_n: int = 50,
) -> ArtistPlaylistResult:
    """
    Build/refresh a single artist playlist by selecting the most played tracks
    for that artist from the local DB.

    The match is a case-insensitive substring against the stored artist names
    (comma-separated) on the track rows. This avoids re-querying Spotify history.
    """
    if cfg.spotify is None:
        raise RuntimeError("Spotify credentials not configured.")
    if cfg.add_batch_size <= 0:
        raise ValueError("add_batch_size must be positive")

    rows = db.fetchall(
        """
        SELECT
          p.track_id AS track_id,
          t.track_uri AS track_uri,
          COUNT(*) AS play_count,
          MAX(p.played_at_ms) AS last_play_ms
        FROM plays p
        JOIN tracks t ON p.track_id = t.track_id
        WHERE lower(COALESCE(t.artists, '')) LIKE ?
        GROUP BY p.track_id, t.track_uri
        ORDER BY play_count DESC, last_play_ms DESC
        LIMIT ?
        """,
        (f"%{artist_name.lower()}%", top_n),
    )

    known = queries.get_known_playlist_track_ids(db, playlist_id)
    to_add: List[tuple[str, str]] = [
        (str(r["track_id"]), str(r["track_uri"])) for r in rows if str(r["track_id"]) not in known
    ]

    tracks_added = _add_to_playlist(spotify, playlist_id, [uri for (_tid, uri) in to_add], cfg.add_batch_size)
    if to_add:
        queries.mark_tracks_in_playlist(db, playlist_id, to_add)

    return ArtistPlaylistResult(
        artist=artist_name,
        playlist_id=playlist_id,
        tracks_added=tracks_added,
        tracks_considered=len(rows),
    )


def _add_to_playlist(sp: SpotifyClient, playlist_id: str, track_uris: Iterable[str], batch_size: int) -> int:
    added = 0
    for batch in chunk_list(track_uris, batch_size):
        if not batch:
            continue
        sp.playlist_add_items(playlist_id, list(batch))
        added += len(batch)
    return added
