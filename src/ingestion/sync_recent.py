from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Iterable, List, Tuple

from spotipy.exceptions import SpotifyException

from src.config import AppConfig
from src.db.connection import DB
from src.db import queries, state
from src.ingestion.spotify_client import SpotifyClient
from src.utils.batching import chunk_list
from src.utils.time import iso8601_to_ms, now_ms

log = logging.getLogger("sync_recent")

LIKED_CACHE_ID = "__liked__"
_CACHE_REFRESH_HOURS = 24


@dataclass(frozen=True)
class SyncResult:
    plays_fetched: int
    playlist_added: int
    liked_added: int
    frequent_added: int
    cursor_in_ms: int
    cursor_out_ms: int | None


def _parse_recently_played(resp: dict) -> Tuple[List[tuple], List[tuple], int]:
    """
    Parse Spotify recently_played response into rows for DB insertion.
    Returns (plays_rows, tracks_rows, newest_played_at_ms).
    """
    items = resp.get("items") or []
    plays: List[tuple] = []
    tracks: List[tuple] = []
    seen_track_ids: set[str] = set()
    newest_ms = 0

    for item in items:
        played_at = item.get("played_at")
        track = item.get("track") or {}
        track_id = track.get("id")
        track_uri = track.get("uri")
        if not played_at or not track_id or not track_uri:
            continue

        played_at_ms = iso8601_to_ms(played_at)
        newest_ms = max(newest_ms, played_at_ms)
        context = item.get("context") or {}
        plays.append(
            (
                played_at_ms,
                track_id,
                track_uri,
                context.get("type"),
                context.get("uri"),
                "recently_played",
            )
        )

        if track_id in seen_track_ids:
            continue
        seen_track_ids.add(track_id)

        album = track.get("album") or {}
        artists = track.get("artists") or []
        artist_names = ", ".join([a.get("name") for a in artists if a.get("name")]) or None
        explicit_flag = track.get("explicit")
        explicit_int = 1 if explicit_flag is True else 0 if explicit_flag is False else None

        tracks.append(
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

    return plays, tracks, newest_ms


def _add_to_playlist(sp: SpotifyClient, playlist_id: str, track_uris: list[str], batch_size: int) -> int:
    added = 0
    for batch in chunk_list(track_uris, batch_size):
        if not batch:
            continue
        sp.playlist_add_items(playlist_id, batch)
        added += len(batch)
    return added


def _add_to_liked(sp: SpotifyClient, track_ids: list[str], batch_size: int) -> int:
    added = 0
    for batch in chunk_list(track_ids, batch_size):
        if not batch:
            continue
        sp.current_user_saved_tracks_add(batch)
        added += len(batch)
    return added


def _maybe_refresh_playlist_cache(cfg: AppConfig, db: DB, sp: SpotifyClient, playlist_id: str, *, max_age_hours: int) -> None:
    key = f"playlist_cache_refreshed_ms:{playlist_id}"
    last = state.get_state(db, key)
    now = now_ms()
    if last is not None:
        try:
            if now - int(last) < max_age_hours * 60 * 60 * 1000:
                return
        except ValueError:
            pass
    # Lazy import to avoid cycle
    from src.ingestion.backfill_playlist import backfill_playlist_cache

    backfill_playlist_cache(cfg, db, sp, playlist_id=playlist_id)
    state.set_state(db, key, str(now))


def sync_recent(cfg: AppConfig, db: DB, sp: SpotifyClient) -> SyncResult:
    """
    Pull recent plays, persist to DB, and backfill the all-playlist.
    """
    if cfg.spotify is None:
        raise RuntimeError("Spotify credentials not configured; set SPOTIFY_* env vars.")
    if cfg.add_batch_size <= 0:
        raise ValueError("add_batch_size must be positive")

    playlist_id = cfg.spotify.all_playlist_id
    cursor_in = state.load_cursor_ms(db, playlist_id, cfg.bootstrap_hours)
    run_id = queries.create_sync_run(db, cursor_in)

    plays_fetched = 0
    playlist_added = 0
    liked_added = 0
    frequent_added = 0
    cursor_out: int | None = None
    tracks_added_total = 0

    try:
        _maybe_refresh_playlist_cache(cfg, db, sp, playlist_id, max_age_hours=_CACHE_REFRESH_HOURS)
        if cfg.spotify.frequent_playlist_id:
            _maybe_refresh_playlist_cache(
                cfg,
                db,
                sp,
                cfg.spotify.frequent_playlist_id,
                max_age_hours=_CACHE_REFRESH_HOURS,
            )

        # Fetch pages until we exhaust results to avoid dropping plays when > limit
        combined_plays: List[tuple] = []
        combined_tracks: dict[str, tuple] = {}
        cursor_marker = cursor_in
        newest_ms = 0
        while True:
            resp = sp.current_user_recently_played(
                limit=cfg.recently_played_limit,
                after=cursor_marker,
            ) or {}
            plays_rows, track_rows, batch_newest = _parse_recently_played(resp)
            if not plays_rows:
                break
            combined_plays.extend(plays_rows)
            for row in track_rows:
                combined_tracks[row[0]] = row  # keyed by track_id
            newest_ms = max(newest_ms, batch_newest)
            if len(resp.get("items") or []) < cfg.recently_played_limit:
                break
            if batch_newest <= cursor_marker:
                # Defensive: avoid infinite loop if API repeats the last item
                break
            cursor_marker = batch_newest

        plays_rows = combined_plays
        track_rows = list(combined_tracks.values())
        plays_fetched = len(plays_rows)

        queries.upsert_tracks(db, track_rows)
        queries.insert_plays(db, plays_rows)

        # Liked songs (primary target)
        liked_known = queries.get_known_playlist_track_ids(db, LIKED_CACHE_ID)
        liked_missing = [(tid, uri) for (tid, uri, *_rest) in track_rows if tid not in liked_known]
        if liked_missing:
            liked_added = _add_to_liked(sp, [tid for (tid, _uri) in liked_missing], cfg.like_batch_size)
            queries.mark_tracks_in_playlist(db, LIKED_CACHE_ID, liked_missing)
            tracks_added_total += liked_added

        # Frequent playlist (optional)
        if cfg.spotify.frequent_playlist_id:
            frequent_added = _sync_frequent_playlist(
                cfg,
                db,
                sp,
                cfg.spotify.frequent_playlist_id,
                use_full_history=False,
                recent_track_ids=[tid for (tid, _uri, *_rest) in track_rows],
            )
            tracks_added_total += frequent_added

        # Legacy all-playlist cache (keep as a mirror for dedupe; optional use)
        known_ids = queries.get_known_playlist_track_ids(db, playlist_id)
        to_add = [(tid, uri) for (tid, uri, *_rest) in track_rows if tid not in known_ids]
        to_add_uris = [uri for (_tid, uri) in to_add]

        if to_add_uris:
            capacity = _remaining_capacity(sp, playlist_id)
            if capacity is not None and capacity <= 0:
                log.warning("All-playlist at capacity; skipping additions.")
            else:
                if capacity is not None and len(to_add_uris) > capacity:
                    log.warning("All-playlist near capacity; truncating to %s items", capacity)
                    to_add = to_add[:capacity]
                    to_add_uris = to_add_uris[:capacity]
                try:
                    playlist_added = _add_to_playlist(sp, playlist_id, to_add_uris, cfg.add_batch_size)
                except SpotifyException as exc:
                    if exc.http_status == 400 and "Playlist size limit" in exc.msg:
                        log.error("All-playlist size limit reached; skipping additions.")
                        playlist_added = 0
                    else:
                        raise
                if playlist_added:
                    queries.mark_tracks_in_playlist(db, playlist_id, to_add)
                tracks_added_total += playlist_added

        if newest_ms > 0:
            cursor_out = newest_ms + 1
            state.save_cursor_ms(db, playlist_id, cursor_out)

        queries.finish_sync_run(
            db,
            run_id,
            cursor_out_ms=cursor_out,
            plays_fetched=plays_fetched,
            tracks_added=tracks_added_total,
            status="success",
        )
        log.info(
            "sync_recent success | plays=%s liked_added=%s playlist_added=%s frequent_added=%s cursor_in=%s cursor_out=%s",
            plays_fetched,
            liked_added,
            playlist_added,
            frequent_added,
            cursor_in,
            cursor_out,
        )
        return SyncResult(
            plays_fetched=plays_fetched,
            playlist_added=playlist_added,
            liked_added=liked_added,
            frequent_added=frequent_added,
            cursor_in_ms=cursor_in,
            cursor_out_ms=cursor_out,
        )
    except Exception as exc:  # noqa: BLE001
        queries.finish_sync_run(
            db,
            run_id,
            cursor_out_ms=cursor_out,
            plays_fetched=plays_fetched,
            tracks_added=tracks_added_total,
            status="fail",
            error=str(exc),
        )
        log.exception("sync_recent failed")
        raise


def _sync_frequent_playlist(
    cfg: AppConfig,
    db: DB,
    sp: SpotifyClient,
    playlist_id: str,
    *,
    use_full_history: bool,
    recent_track_ids: List[str] | None = None,
) -> int:
    """
    Add tracks with total plays >= threshold to the frequent playlist.
    If use_full_history is False, only considers the provided recent_track_ids.
    """
    min_plays = max(cfg.spotify.frequent_min_plays, 1)
    if use_full_history:
        rows = db.fetchall(
            """
            SELECT p.track_id, t.track_uri, COUNT(*) AS play_count, MAX(p.played_at_ms) AS last_play
            FROM plays p
            JOIN tracks t ON p.track_id = t.track_id
            GROUP BY p.track_id, t.track_uri
            HAVING play_count >= ?
            ORDER BY play_count DESC, last_play DESC
            """,
            (min_plays,),
        )
    else:
        if not recent_track_ids:
            return 0
        placeholders = ",".join(["?"] * len(recent_track_ids))
        rows = db.fetchall(
            f"""
            SELECT p.track_id, t.track_uri, COUNT(*) AS play_count, MAX(p.played_at_ms) AS last_play
            FROM plays p
            JOIN tracks t ON p.track_id = t.track_id
            WHERE p.track_id IN ({placeholders})
            GROUP BY p.track_id, t.track_uri
            HAVING play_count >= ?
            ORDER BY play_count DESC, last_play DESC
            """,
            (*recent_track_ids, min_plays),
        )
    if not rows:
        log.info(
            "Frequent playlist: no candidates (min_plays=%s, full_history=%s, recent_ids=%s)",
            min_plays,
            use_full_history,
            len(recent_track_ids) if recent_track_ids else 0,
        )
        return 0

    known = queries.get_known_playlist_track_ids(db, playlist_id)
    candidates = [(str(r["track_id"]), str(r["track_uri"])) for r in rows if str(r["track_id"]) not in known]
    if not candidates:
        log.info(
            "Frequent playlist: all candidates already present (rows=%s, known=%s)",
            len(rows),
            len(known),
        )
        return 0

    capacity = _remaining_capacity(sp, playlist_id)
    if capacity is not None and capacity <= 0:
        log.warning("Frequent playlist at capacity; skipping additions.")
        return 0
    if capacity is not None and len(candidates) > capacity:
        candidates = candidates[:capacity]
        log.warning("Frequent playlist near capacity; truncating to %s items", capacity)

    added = _add_to_playlist(sp, playlist_id, [uri for (_tid, uri) in candidates], cfg.add_batch_size)
    if added:
        queries.mark_tracks_in_playlist(db, playlist_id, candidates)
    return added


def sync_all_tracks(cfg: AppConfig, db: DB, sp: SpotifyClient) -> int:
    """
    Add any tracks in the DB that are not yet in the playlist cache/Spotify playlist.
    Useful after a history import to seed the All playlist.
    """
    if cfg.spotify is None:
        raise RuntimeError("Spotify credentials not configured; set SPOTIFY_* env vars.")
    rows = db.fetchall("SELECT track_id, track_uri FROM tracks")
    all_tracks = [(str(r["track_id"]), str(r["track_uri"])) for r in rows]
    log.info("sync_all_tracks: total_tracks=%s", len(all_tracks))

    # Liked songs
    liked_known = queries.get_known_playlist_track_ids(db, LIKED_CACHE_ID)
    liked_missing = [(tid, uri) for (tid, uri) in all_tracks if tid not in liked_known]
    log.info("sync_all_tracks: liked_missing=%s liked_known=%s", len(liked_missing), len(liked_known))
    liked_added = 0
    if liked_missing:
        liked_added = _add_to_liked(sp, [tid for (tid, _uri) in liked_missing], cfg.like_batch_size)
        if liked_added:
            queries.mark_tracks_in_playlist(db, LIKED_CACHE_ID, liked_missing)

    # All playlist cache (legacy mirror) with capacity guard
    playlist_id = cfg.spotify.all_playlist_id
    playlist_added = 0
    capacity = _remaining_capacity(sp, playlist_id)
    if capacity is None or capacity > 0:
        known_ids = queries.get_known_playlist_track_ids(db, playlist_id)
        missing_playlist = [(tid, uri) for (tid, uri) in all_tracks if tid not in known_ids]
        log.info(
            "sync_all_tracks: playlist_missing=%s playlist_known=%s capacity=%s",
            len(missing_playlist),
            len(known_ids),
            capacity,
        )
        if capacity is not None and len(missing_playlist) > capacity:
            missing_playlist = missing_playlist[:capacity]
            log.warning("sync_all_tracks: playlist near capacity; truncating to first %s items", capacity)
        if missing_playlist:
            try:
                playlist_added = _add_to_playlist(
                    sp,
                    playlist_id,
                    [uri for (_tid, uri) in missing_playlist],
                    cfg.add_batch_size,
                )
            except SpotifyException as exc:
                if exc.http_status == 400 and "Playlist size limit" in exc.msg:
                    log.error("sync_all_tracks: playlist size limit reached before adding; consider clearing items")
                    playlist_added = 0
                else:
                    raise
            if playlist_added:
                queries.mark_tracks_in_playlist(db, playlist_id, missing_playlist)

    # Frequent playlist (optional)
    frequent_added = 0
    if cfg.spotify.frequent_playlist_id:
        frequent_added = _sync_frequent_playlist(
            cfg,
            db,
            sp,
            cfg.spotify.frequent_playlist_id,
            use_full_history=True,
        )
    else:
        log.info("sync_all_tracks: no frequent playlist configured")

    log.info(
        "sync_all_tracks summary | liked_added=%s playlist_added=%s frequent_added=%s",
        liked_added,
        playlist_added,
        frequent_added,
    )
    return liked_added + playlist_added + frequent_added


def _remaining_capacity(sp: SpotifyClient, playlist_id: str) -> int | None:
    """
    Return remaining slots before hitting Spotify's 10k playlist item limit.
    Returns None if the total cannot be determined.
    """
    try:
        resp = sp.playlist(playlist_id, fields="tracks.total")
        total = resp.get("tracks", {}).get("total")
        if total is None:
            return None
        max_items = 10_000
        return max(max_items - int(total), 0)
    except Exception:  # noqa: BLE001
        return None
