from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import List

from src.config import AppConfig
from src.db import queries
from src.db.connection import DB
from src.ingestion.spotify_client import SpotifyClient
from src.spotify_helpers import add_tracks_to_playlist

log = logging.getLogger("artist_playlists")


@dataclass(frozen=True)
class ArtistPlaylistResult:
    artist: str
    playlist_id: str
    created: bool
    tracks_added: int
    tracks_considered: int


@dataclass(frozen=True)
class PrunedPlaylist:
    artist: str | None
    playlist_id: str
    track_count: int


@dataclass(frozen=True)
class ArtistPlaylistsRunResult:
    artists_processed: int
    playlists_created: int
    total_tracks_added: int
    results: list[ArtistPlaylistResult] = field(default_factory=list)
    pruned: list[PrunedPlaylist] = field(default_factory=list)


def build_artist_playlist(
    cfg: AppConfig,
    db: DB,
    spotify: SpotifyClient,
    *,
    artist_name: str,
    playlist_id: str,
    top_n: int | None = None,
) -> ArtistPlaylistResult:
    """
    Build/refresh a single artist playlist by selecting the most played tracks
    for that artist from the local DB.

    Legacy interface: takes a pre-existing playlist_id.
    """
    if cfg.spotify is None:
        raise RuntimeError("Spotify credentials not configured.")
    if cfg.add_batch_size <= 0:
        raise ValueError("add_batch_size must be positive")

    resolved_top_n = top_n if top_n is not None else cfg.artist_discovery.max_tracks_per_playlist

    from src.ingestion.backfill_playlist import backfill_playlist_cache

    backfill_playlist_cache(cfg, db, spotify, playlist_id=playlist_id)

    rows = queries.get_artist_top_tracks(db, artist_name, resolved_top_n)

    known = queries.get_known_playlist_track_ids(db, playlist_id)
    to_add: List[tuple[str, str]] = [
        (str(r["track_id"]), str(r["track_uri"])) for r in rows if str(r["track_id"]) not in known
    ]

    tracks_added = add_tracks_to_playlist(spotify, playlist_id, [uri for (_tid, uri) in to_add], cfg.add_batch_size)
    if to_add:
        queries.mark_tracks_in_playlist(db, playlist_id, to_add)

    return ArtistPlaylistResult(
        artist=artist_name,
        playlist_id=playlist_id,
        created=False,
        tracks_added=tracks_added,
        tracks_considered=len(rows),
    )


def _get_or_create_playlist(
    db: DB,
    spotify: SpotifyClient,
    artist_name: str,
) -> tuple[str, bool]:
    """
    Look up an existing playlist for the artist in the local playlists table.
    If none exists, create one on Spotify and register it locally.
    Returns (playlist_id, was_created).
    """
    existing_id = queries.get_artist_playlist(db, artist_name)
    if existing_id:
        return existing_id, False

    user_info = spotify.me()
    user_id = user_info["id"]
    playlist_name = artist_name
    resp = spotify.user_playlist_create(
        user_id,
        playlist_name,
        public=False,
        description=f"Auto-generated playlist for {artist_name}",
    )
    playlist_id = resp["id"]
    queries.register_playlist(db, playlist_id, playlist_name, artist_name, "artist")
    log.info("Created playlist '%s' (%s) for artist '%s'", playlist_name, playlist_id, artist_name)
    return playlist_id, True


def _sync_playlist_state(
    db: DB,
    spotify: SpotifyClient,
    playlist_id: str,
) -> bool:
    """
    Reconcile local DB state with the actual Spotify playlist.

    - If the playlist no longer exists on Spotify (user deleted/unfollowed it),
      returns ``False`` so the caller can record the exclusion.
    - Tracks we previously added that the user removed on Spotify are recorded
      in ``playlist_removals`` and deleted from ``playlist_tracks``.
    - Tracks the user added manually on Spotify are inserted into
      ``playlist_tracks`` so the system won't duplicate them.

    Returns ``True`` if the playlist still exists, ``False`` if it was deleted.
    """
    from spotipy.exceptions import SpotifyException

    from src.ingestion.backfill_playlist import _fetch_playlist_items

    # Fetch the real Spotify state.
    spotify_ids: dict[str, str] = {}  # track_id -> track_uri
    try:
        for item in _fetch_playlist_items(spotify, playlist_id):
            track = item.get("track") or {}
            tid = track.get("id")
            turi = track.get("uri")
            if tid and turi:
                spotify_ids[tid] = turi
    except SpotifyException as exc:
        if exc.http_status in (404, 403):
            log.info(
                "Playlist %s no longer exists on Spotify (HTTP %d); "
                "marking artist as excluded",
                playlist_id, exc.http_status,
            )
            return False
        raise

    known = queries.get_known_playlist_track_ids(db, playlist_id)

    # Tracks the user removed from Spotify (were in our DB but no longer on Spotify).
    removed_ids = known - set(spotify_ids)
    if removed_ids:
        # Look up URIs from playlist_tracks so we can record them.
        uri_rows = db.fetchall(
            "SELECT track_id, track_uri FROM playlist_tracks WHERE playlist_id = ?",
            (playlist_id,),
        )
        uri_map = {str(r["track_id"]): str(r["track_uri"]) for r in uri_rows}
        removal_rows = [
            (tid, uri_map[tid]) for tid in removed_ids if tid in uri_map
        ]
        queries.record_playlist_removals(db, playlist_id, removal_rows)
        queries.remove_from_playlist_tracks(db, playlist_id, removed_ids)
        log.info(
            "Playlist %s: detected %d user removal(s)",
            playlist_id, len(removed_ids),
        )

    # Tracks the user added manually (on Spotify but not in our DB).
    added_ids = set(spotify_ids) - known
    if added_ids:
        manual_rows = [(tid, spotify_ids[tid]) for tid in added_ids]
        queries.mark_tracks_in_playlist(db, playlist_id, manual_rows)
        log.info(
            "Playlist %s: detected %d manual addition(s)",
            playlist_id, len(added_ids),
        )

    return True


def _prune_small_playlists(
    db: DB,
    spotify: SpotifyClient,
    min_tracks: int,
    *,
    dry_run: bool = False,
) -> list[PrunedPlaylist]:
    """
    Remove artist playlists that have fewer than *min_tracks* tracks.
    Unfollows the playlist on Spotify and deletes from the local DB.
    """
    all_playlists = queries.get_all_artist_playlists(db)
    pruned: list[PrunedPlaylist] = []

    for pl in all_playlists:
        if pl["track_count"] >= min_tracks:
            continue

        entry = PrunedPlaylist(
            artist=pl["artist_name"],
            playlist_id=pl["playlist_id"],
            track_count=pl["track_count"],
        )
        log.info(
            "Pruning playlist '%s' for artist '%s' (%d tracks < %d minimum)",
            pl["name"], pl["artist_name"], pl["track_count"], min_tracks,
        )

        if not dry_run:
            spotify.current_user_unfollow_playlist(pl["playlist_id"])
            queries.delete_playlist(db, pl["playlist_id"])

        pruned.append(entry)

    return pruned


def run_artist_playlists(
    cfg: AppConfig,
    db: DB,
    spotify: SpotifyClient,
    *,
    min_plays: int | None = None,
    dry_run: bool = False,
) -> ArtistPlaylistsRunResult:
    """
    Discover qualifying artists from the DB, create playlists as needed,
    and populate them with tracks that have more than `min_plays` plays.
    """
    if cfg.spotify is None:
        raise RuntimeError("Spotify credentials not configured.")

    min_plays = min_plays if min_plays is not None else cfg.artist_discovery.min_plays_per_track
    artists = queries.discover_artists(db, cfg.artist_discovery)
    excluded_artists = queries.get_excluded_artists(db)
    log.info("Discovered %d qualifying artists (%d excluded)", len(artists), len(excluded_artists))

    results: list[ArtistPlaylistResult] = []
    playlists_created = 0
    total_added = 0

    for artist_row in artists:
        artist_name = artist_row["artist"]
        if not artist_name:
            continue

        if artist_name in excluded_artists:
            log.debug("Skipping excluded artist '%s'", artist_name)
            continue

        tracks = queries.get_artist_tracks_over_threshold(db, artist_name, min_plays)

        # Skip artists that don't have enough qualifying tracks — avoids
        # creating a playlist only to prune it immediately.
        if len(tracks) < cfg.artist_discovery.min_tracks_per_playlist:
            log.debug(
                "Skipping artist '%s': %d qualifying tracks < %d minimum",
                artist_name, len(tracks), cfg.artist_discovery.min_tracks_per_playlist,
            )
            continue

        if dry_run:
            existing_id = queries.get_artist_playlist(db, artist_name)
            results.append(ArtistPlaylistResult(
                artist=artist_name,
                playlist_id=existing_id or "(would create)",
                created=existing_id is None,
                tracks_added=0,
                tracks_considered=len(tracks),
            ))
            continue

        playlist_id, created = _get_or_create_playlist(db, spotify, artist_name)
        if created:
            playlists_created += 1
        else:
            # Sync local DB against actual Spotify state so we respect
            # any manual additions or removals the user made.
            still_exists = _sync_playlist_state(db, spotify, playlist_id)
            if not still_exists:
                queries.exclude_artist(db, artist_name, playlist_id)
                queries.delete_playlist(db, playlist_id)
                excluded_artists.add(artist_name)
                log.info("Artist '%s': playlist deleted by user, excluding from future runs", artist_name)
                continue

        known = queries.get_known_playlist_track_ids(db, playlist_id)
        removed = queries.get_playlist_removal_ids(db, playlist_id)
        excluded = known | removed

        to_add: List[tuple[str, str]] = [
            (t["track_id"], t["track_uri"])
            for t in tracks
            if t["track_id"] not in excluded
        ]

        added = add_tracks_to_playlist(
            spotify,
            playlist_id,
            [uri for (_tid, uri) in to_add],
            cfg.add_batch_size,
        )
        if to_add:
            queries.mark_tracks_in_playlist(db, playlist_id, to_add)

        total_added += added
        log.info(
            "Artist '%s': playlist=%s created=%s considered=%d added=%d",
            artist_name, playlist_id, created, len(tracks), added,
        )
        results.append(ArtistPlaylistResult(
            artist=artist_name,
            playlist_id=playlist_id,
            created=created,
            tracks_added=added,
            tracks_considered=len(tracks),
        ))

    # Prune artist playlists that fell below the minimum track threshold.
    min_tracks = cfg.artist_discovery.min_tracks_per_playlist
    pruned = _prune_small_playlists(db, spotify, min_tracks, dry_run=dry_run)

    return ArtistPlaylistsRunResult(
        artists_processed=len(results),
        playlists_created=playlists_created,
        total_tracks_added=total_added,
        results=results,
        pruned=pruned,
    )
