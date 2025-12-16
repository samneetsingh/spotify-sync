# src/main.py
from __future__ import annotations

import argparse
import sys

from .config import ConfigError, load_config
from .db import DB
from .features.all_playlist import run_all_playlist
from .ingestion.spotify_client import get_spotify
from .ingestion.sync_recent import sync_recent
from .logging_setup import setup_logging


def main() -> None:
    parser = argparse.ArgumentParser(prog="spotify-automation")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("migrate", help="Create/upgrade the SQLite schema")
    sync_cmd = sub.add_parser("sync", help="Sync recent plays into SQLite + All playlist")
    sync_cmd.add_argument(
        "--full",
        action="store_true",
        help="Also add any tracks in DB not yet in the All playlist (useful after history import)",
    )

    feature = sub.add_parser("run-feature", help="Run a feature pipeline")
    feature.add_argument("name", choices=["all_playlist"], help="Feature name to run")

    backfill = sub.add_parser("backfill-playlist-cache", help="Cache existing playlist tracks into DB")
    backfill.add_argument(
        "--playlist-id",
        help="Playlist ID to backfill (default: SPOTIFY_ALL_PLAYLIST_ID)",
    )

    importer = sub.add_parser("import-history", help="Import streaming history JSON")
    importer.add_argument("path", help="Path to a Spotify history JSON file")

    args = parser.parse_args()
    require_spotify = args.cmd != "migrate"
    try:
        cfg = load_config(require_spotify=require_spotify)
    except ConfigError as exc:
        print(f"Config error: {exc}", file=sys.stderr)
        sys.exit(1)

    setup_logging(cfg.log_level, cfg.log_file, cfg.log_retention_days)

    db = DB(cfg.db.path)
    try:
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
                f"liked_added={result.liked_added} "
                f"playlist_added={result.playlist_added} frequent_added={result.frequent_added} "
                f"cursor_in={result.cursor_in_ms} cursor_out={result.cursor_out_ms} "
                f"full_added={extra_added}"
            )
        elif args.cmd == "run-feature":
            if args.name == "all_playlist":
                if cfg.spotify is None:
                    print("Missing Spotify config; set SPOTIFY_* env vars.", file=sys.stderr)
                    sys.exit(1)
                spotify = get_spotify(cfg.spotify)
                result = run_all_playlist(cfg, db, spotify)
                print(
                    f"Feature all_playlist: plays={result.plays_fetched} "
                    f"tracks_added={result.tracks_added}"
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
        elif args.cmd == "import-history":
            from .ingestion.history_import import import_history_path

            result = import_history_path(cfg, db, args.path)
            print(
                f"History import complete: files={result.files_processed} records={result.records_seen} "
                f"plays_written={result.plays_written} tracks_written={result.tracks_written} "
                f"skipped={result.records_skipped}"
            )
    finally:
        db.close()


if __name__ == "__main__":
    main()
