"""One-off patch: remove artist playlists with fewer than N tracks.

Scans all artist-type playlists in the local DB, checks track count, and
unfollows (removes) any that fall below the minimum from Spotify. Also
deletes them from the local DB so they won't be re-created.

Note: Spotify has no "delete playlist" API endpoint. For playlists you own,
unfollowing removes them from your library and makes them inaccessible.
This is the only removal mechanism the API provides.

Usage:
    python -m scripts.prune_small_artist_playlists              # live run (min 10)
    python -m scripts.prune_small_artist_playlists --min-tracks 15
    python -m scripts.prune_small_artist_playlists --dry-run    # preview only
"""
from __future__ import annotations

import argparse
import sys

from src.config import ConfigError, load_config
from src.db.connection import DB
from src.db.queries import delete_playlist, get_all_artist_playlists
from src.ingestion.spotify_client import get_spotify
from src.logging_setup import setup_logging


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Remove artist playlists with fewer than N tracks",
    )
    parser.add_argument(
        "--min-tracks",
        type=int,
        default=None,
        help="Minimum track count to keep a playlist (default: from config, usually 10)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview which playlists would be removed without making changes",
    )
    args = parser.parse_args()

    try:
        cfg = load_config(require_spotify=True)
    except ConfigError as exc:
        print(f"Config error: {exc}", file=sys.stderr)
        return 1

    if cfg.spotify is None:
        print("Spotify configuration missing; set SPOTIFY_* env vars.", file=sys.stderr)
        return 1

    min_tracks = args.min_tracks if args.min_tracks is not None else cfg.artist_discovery.min_tracks_per_playlist
    setup_logging(cfg.log_level, cfg.log_file, cfg.log_retention_days)
    spotify = get_spotify(cfg.spotify)

    with DB(cfg.db.path) as db:
        all_playlists = get_all_artist_playlists(db)
        to_prune = [pl for pl in all_playlists if pl["track_count"] < min_tracks]

        if not to_prune:
            print(f"No artist playlists with fewer than {min_tracks} tracks. Nothing to do.")
            return 0

        print(f"Found {len(to_prune)} artist playlist(s) with fewer than {min_tracks} tracks:\n")
        for pl in to_prune:
            status = "(would remove)" if args.dry_run else "(removing)"
            print(
                f"  {status} {pl['artist_name']}: "
                f"{pl['track_count']} tracks  "
                f"playlist_id={pl['playlist_id']}  "
                f"name={pl['name']!r}"
            )

            if not args.dry_run:
                spotify.current_user_unfollow_playlist(pl["playlist_id"])
                delete_playlist(db, pl["playlist_id"])

        action = "Would remove" if args.dry_run else "Removed"
        print(f"\n{action} {len(to_prune)} of {len(all_playlists)} artist playlists.")

        if args.dry_run:
            print("\nRe-run without --dry-run to apply changes.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
