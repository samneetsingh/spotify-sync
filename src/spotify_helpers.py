"""Shared helpers for Spotify playlist and track operations."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Iterable

from src.utils.batching import chunk_list

if TYPE_CHECKING:
    from src.ingestion.spotify_client import SpotifyClient

LIKED_CACHE_ID = "__liked__"


@dataclass(frozen=True)
class ArtistInfo:
    artist_id: str
    name: str


@dataclass(frozen=True)
class TrackMetadata:
    artist_names: str | None
    explicit_int: int | None
    popularity: int | None = None
    release_date: str | None = None
    isrc: str | None = None
    artist_infos: list[ArtistInfo] = field(default_factory=list)


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


def extract_track_metadata(track: dict) -> TrackMetadata:
    """
    Extract metadata from a Spotify track object.
    Returns a TrackMetadata with artist names, explicit flag, popularity,
    release date, ISRC, and per-artist id/name pairs.
    """
    artists = track.get("artists") or []
    artist_names = ", ".join([a.get("name") for a in artists if a.get("name")]) or None
    explicit_flag = track.get("explicit")
    explicit_int = 1 if explicit_flag is True else 0 if explicit_flag is False else None

    # Popularity (directly on the track object)
    popularity = track.get("popularity")

    # Release date (on the album object)
    album = track.get("album") or {}
    release_date = album.get("release_date")

    # ISRC (in external_ids)
    external_ids = track.get("external_ids") or {}
    isrc = external_ids.get("isrc")

    # Per-artist structured info (id + name)
    artist_infos = []
    for a in artists:
        aid = a.get("id")
        aname = a.get("name")
        if aid and aname:
            artist_infos.append(ArtistInfo(artist_id=aid, name=aname))

    return TrackMetadata(
        artist_names=artist_names,
        explicit_int=explicit_int,
        popularity=popularity,
        release_date=release_date,
        isrc=isrc,
        artist_infos=artist_infos,
    )


def convert_explicit_flag(record: dict) -> int | None:
    """Convert an explicit flag from a history record (supports 'explicit' and 'is_explicit' keys)."""
    for key in ("explicit", "is_explicit"):
        if key in record:
            flag = record.get(key)
            return 1 if flag is True else 0 if flag is False else None
    return None
