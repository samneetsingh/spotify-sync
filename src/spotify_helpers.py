"""Shared helpers for Spotify playlist and track operations."""
from __future__ import annotations

from typing import TYPE_CHECKING, Iterable

from src.utils.batching import chunk_list

if TYPE_CHECKING:
    from src.ingestion.spotify_client import SpotifyClient

LIKED_CACHE_ID = "__liked__"


def add_tracks_to_playlist(
    sp: SpotifyClient, playlist_id: str, track_uris: Iterable[str], batch_size: int,
) -> int:
    """Add tracks to a Spotify playlist in batches, returning the count added."""
    added = 0
    for batch in chunk_list(track_uris, batch_size):
        if not batch:
            continue
        sp.playlist_add_items(playlist_id, list(batch))
        added += len(batch)
    return added


def add_tracks_to_liked(
    sp: SpotifyClient, track_ids: Iterable[str], batch_size: int,
) -> int:
    """Add tracks to the user's Liked Songs in batches, returning the count added."""
    added = 0
    for batch in chunk_list(track_ids, batch_size):
        if not batch:
            continue
        sp.current_user_saved_tracks_add(list(batch))
        added += len(batch)
    return added


def extract_track_metadata(track: dict) -> tuple[str | None, int | None]:
    """
    Extract artist names and explicit flag from a Spotify track object.
    Returns (artist_names, explicit_int).
    """
    artists = track.get("artists") or []
    artist_names = ", ".join([a.get("name") for a in artists if a.get("name")]) or None
    explicit_flag = track.get("explicit")
    explicit_int = 1 if explicit_flag is True else 0 if explicit_flag is False else None
    return artist_names, explicit_int


def convert_explicit_flag(record: dict) -> int | None:
    """Convert an explicit flag from a history record (supports 'explicit' and 'is_explicit' keys)."""
    for key in ("explicit", "is_explicit"):
        if key in record:
            flag = record.get(key)
            return 1 if flag is True else 0 if flag is False else None
    return None
