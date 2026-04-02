"""Batch enrichment of artist metadata from Spotify API."""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass

from src.db import queries
from src.db.connection import DB
from src.db.queries import ArtistRow, TrackArtistRow
from src.ingestion.spotify_client import SpotifyClient
from src.utils.batching import chunk_list

log = logging.getLogger("enrich")

ARTISTS_BATCH_SIZE = 50


@dataclass(frozen=True)
class EnrichResult:
    artists_added: int


def _fetch_and_store_artists(
    sp: SpotifyClient, db: DB, artist_ids: list[str], batch_size: int = ARTISTS_BATCH_SIZE,
) -> int:
    """Fetch artist metadata from Spotify API and store it. Returns count stored."""
    total = 0
    for batch in chunk_list(artist_ids, batch_size):
        resp = sp.artists(list(batch))
        artists_data = resp.get("artists") or []
        rows = []
        for artist in artists_data:
            if artist is None:
                continue
            aid = artist.get("id")
            name = artist.get("name")
            if not aid or not name:
                continue
            genres = artist.get("genres") or []
            followers_obj = artist.get("followers") or {}
            rows.append(ArtistRow(
                artist_id=aid,
                name=name,
                genres=json.dumps(genres) if genres else None,
                popularity=artist.get("popularity"),
                followers=followers_obj.get("total"),
            ))
        if rows:
            queries.upsert_artists(db, rows)
            total += len(rows)
        log.info("Artists batch: requested=%s received=%s", len(batch), len(rows))
    return total


def enrich_artists(sp: SpotifyClient, db: DB, batch_size: int = ARTISTS_BATCH_SIZE) -> int:
    """Fetch metadata for all artists in track_artists that aren't in the artists table yet."""
    artist_ids = queries.get_unenriched_artist_ids(db)
    if not artist_ids:
        log.info("All artists already have metadata.")
        return 0
    log.info("Enriching metadata for %s artists.", len(artist_ids))
    total = _fetch_and_store_artists(sp, db, artist_ids, batch_size)
    log.info("Artist enrichment complete: %s artists enriched.", total)
    return total


def enrich_artists_for_ids(sp: SpotifyClient, db: DB, artist_ids: list[str]) -> int:
    """Fetch metadata for specific artist IDs, skipping already-enriched ones."""
    if not artist_ids:
        return 0
    placeholders = ",".join(["?"] * len(artist_ids))
    rows = db.fetchall(
        f"SELECT artist_id FROM artists WHERE artist_id IN ({placeholders})",
        tuple(artist_ids),
    )
    already = {str(r["artist_id"]) for r in rows}
    missing = [aid for aid in artist_ids if aid not in already]
    if not missing:
        return 0

    log.info("Enriching metadata for %s new artists.", len(missing))
    return _fetch_and_store_artists(sp, db, missing)


TRACKS_BATCH_SIZE = 50


def backfill_track_artists(sp: SpotifyClient, db: DB, batch_size: int = TRACKS_BATCH_SIZE) -> int:
    """
    Populate track_artists for all tracks in the DB that don't have entries yet.
    Fetches track details from Spotify to get artist IDs.
    """
    rows = db.fetchall(
        """SELECT t.track_id FROM tracks t
           LEFT JOIN track_artists ta ON t.track_id = ta.track_id
           WHERE ta.track_id IS NULL""",
    )
    track_ids = [str(r["track_id"]) for r in rows]
    if not track_ids:
        log.info("All tracks already have track_artists entries.")
        return 0

    log.info("Backfilling track_artists for %s tracks.", len(track_ids))
    total = 0

    for batch in chunk_list(track_ids, batch_size):
        resp = sp.tracks(list(batch))
        tracks_data = resp.get("tracks") or []
        ta_rows = []
        for track in tracks_data:
            if track is None:
                continue
            tid = track.get("id")
            if not tid:
                continue
            artists = track.get("artists") or []
            for i, artist in enumerate(artists):
                aid = artist.get("id")
                aname = artist.get("name")
                if aid and aname:
                    ta_rows.append(TrackArtistRow(
                        track_id=tid,
                        artist_id=aid,
                        artist_name=aname,
                        position=i,
                    ))
        if ta_rows:
            queries.upsert_track_artists(db, ta_rows)
            total += len(ta_rows)
        log.info("Track artists batch: requested=%s mappings=%s", len(batch), len(ta_rows))

    log.info("Track artists backfill complete: %s mappings added.", total)
    return total


def enrich_all(sp: SpotifyClient, db: DB) -> EnrichResult:
    """Run all enrichment steps: backfill track_artists, then enrich artist metadata."""
    backfill_track_artists(sp, db)
    ar = enrich_artists(sp, db)
    return EnrichResult(artists_added=ar)
