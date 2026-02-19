# src/main.py
from __future__ import annotations

import argparse
import sys

from .config import ConfigError, load_config
from .db import DB
from .ingestion.spotify_client import get_spotify
from .ingestion.sync_recent import sync_recent
from .logging_setup import setup_logging


def main() -> None:
    parser = argparse.ArgumentParser(prog="spotify-automation")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("migrate", help="Create/upgrade the SQLite schema")
    sync_cmd = sub.add_parser("sync", help="Sync recent plays into SQLite + liked songs")
    sync_cmd.add_argument(
        "--full",
        action="store_true",
        help="Also add any tracks in DB not yet in liked songs (useful after history import)",
    )

    backfill = sub.add_parser("backfill-playlist-cache", help="Cache existing playlist tracks into DB")
    backfill.add_argument(
        "--playlist-id",
        help="Playlist ID to backfill (default: SPOTIFY_ALL_PLAYLIST_ID)",
    )

    artist_pl = sub.add_parser("artist-playlists", help="Auto-create and populate per-artist playlists")
    artist_pl.add_argument(
        "--min-plays",
        type=int,
        default=None,
        help="Only add tracks with more than this many plays (default: from ARTIST_MIN_PLAYS_PER_TRACK env var, or 30)",
    )
    artist_pl.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would happen without creating playlists or adding tracks",
    )

    importer = sub.add_parser("import-history", help="Import streaming history JSON")
    importer.add_argument("path", help="Path to a Spotify history JSON file")

    args = parser.parse_args()
    require_spotify = args.cmd not in ("migrate",)
    try:
        cfg = load_config(require_spotify=require_spotify)
    except ConfigError as exc:
        print(f"Config error: {exc}", file=sys.stderr)
        sys.exit(1)

    setup_logging(cfg.log_level, cfg.log_file, cfg.log_retention_days)

    with DB(cfg.db.path) as db:
        if args.cmd == "migrate":
            db.migrate()
            print(f"OK: migrated {cfg.db.path}")
        elif args.cmd == "sync":
            if cfg.spotify is None:
                print("Missing Spotify config; set SPOTIFY_* env vars.", file=sys.stderr)
                sys.exit(1)
            spotify = get_spotify(cfg.spotify)
            result = sync_recent(cfg, db, spotify)
            extra_added = 0
            if args.full:
                from .ingestion.sync_recent import sync_all_tracks

                extra_added = sync_all_tracks(cfg, db, spotify)
            print(
                f"Sync complete: plays={result.plays_fetched} "
                f"liked_added={result.liked_added} frequent_added={result.frequent_added} "
                f"cursor_in={result.cursor_in_ms} cursor_out={result.cursor_out_ms} "
                f"full_added={extra_added}"
            )
        elif args.cmd == "backfill-playlist-cache":
            if cfg.spotify is None:
                print("Missing Spotify config; set SPOTIFY_* env vars.", file=sys.stderr)
                sys.exit(1)
            spotify = get_spotify(cfg.spotify)
            from .ingestion.backfill_playlist import backfill_playlist_cache

            result = backfill_playlist_cache(cfg, db, spotify, playlist_id=args.playlist_id)
            print(
                f"Backfill complete: playlist={result.playlist_id} "
                f"tracks_seen={result.tracks_seen} tracks_written={result.tracks_written}"
            )
        elif args.cmd == "artist-playlists":
            if cfg.spotify is None:
                print("Missing Spotify config; set SPOTIFY_* env vars.", file=sys.stderr)
                sys.exit(1)
            spotify = get_spotify(cfg.spotify)
            from .features.artist_playlists import run_artist_playlists

            result = run_artist_playlists(
                cfg, db, spotify,
                min_plays=args.min_plays,
                dry_run=args.dry_run,
            )
            if args.dry_run:
                print("DRY RUN — no changes made:")
                for r in result.results:
                    need_create = "(new)" if r.created else "(exists)"
                    print(f"  {r.artist}: {need_create} {r.tracks_considered} tracks qualify")
                if result.pruned:
                    print(f"  Would prune {len(result.pruned)} playlist(s) below minimum track count:")
                    for p in result.pruned:
                        print(f"    {p.artist}: {p.track_count} tracks (playlist={p.playlist_id})")
            else:
                print(
                    f"Artist playlists: artists={result.artists_processed} "
                    f"created={result.playlists_created} "
                    f"tracks_added={result.total_tracks_added} "
                    f"pruned={len(result.pruned)}"
                )
                for r in result.results:
                    print(
                        f"  {r.artist}: playlist={r.playlist_id} "
                        f"created={r.created} added={r.tracks_added}/{r.tracks_considered}"
                    )
                for p in result.pruned:
                    print(f"  PRUNED {p.artist}: {p.track_count} tracks (playlist={p.playlist_id})")
        elif args.cmd == "import-history":
            from .ingestion.history_import import import_history_path

            result = import_history_path(cfg, db, args.path)
            print(
                f"History import complete: files={result.files_processed} records={result.records_seen} "
                f"plays_written={result.plays_written} tracks_written={result.tracks_written} "
                f"skipped={result.records_skipped}"
            )


if __name__ == "__main__":
    main()
