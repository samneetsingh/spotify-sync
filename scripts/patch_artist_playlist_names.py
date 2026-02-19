"""One-off patch: rename artist playlists to remove the ' – Auto' suffix.

Reads every artist-type playlist from the local DB, strips the suffix from
the name on Spotify, and updates the local DB row to match.

Usage:
    python -m scripts.patch_artist_playlist_names          # live run
    python -m scripts.patch_artist_playlist_names --dry-run # preview only
"""
from __future__ import annotations

import argparse
import sys

from src.config import ConfigError, load_config
from src.db.connection import DB
from src.ingestion.spotify_client import get_spotify
from src.logging_setup import setup_logging

SUFFIXES_TO_STRIP = [" – Auto", " – auto", " - Auto", " - auto"]


def main() -> int:
    parser = argparse.ArgumentParser(description="Remove ' – Auto' suffix from artist playlist names")
    parser.add_argument("--dry-run", action="store_true", help="Preview changes without applying them")
    args = parser.parse_args()

    try:
        cfg = load_config(require_spotify=True)
    except ConfigError as exc:
        print(f"Config error: {exc}", file=sys.stderr)
        return 1

    if cfg.spotify is None:
        print("Spotify configuration missing; set SPOTIFY_* env vars.", file=sys.stderr)
        return 1

    setup_logging(cfg.log_level, cfg.log_file, cfg.log_retention_days)
    spotify = get_spotify(cfg.spotify)

    with DB(cfg.db.path) as db:
        rows = db.fetchall(
            "SELECT playlist_id, name, artist_name FROM playlists WHERE playlist_type = 'artist'",
        )

        renamed = 0
        for row in rows:
            old_name = row["name"]
            new_name = old_name
            for suffix in SUFFIXES_TO_STRIP:
                if new_name.endswith(suffix):
                    new_name = new_name[: -len(suffix)]
                    break

            if new_name == old_name:
                continue

            print(f"  {old_name!r}  ->  {new_name!r}  (playlist_id={row['playlist_id']})")

            if not args.dry_run:
                spotify.playlist_change_details(row["playlist_id"], name=new_name)
                db.execute(
                    "UPDATE playlists SET name = ? WHERE playlist_id = ?",
                    (new_name, row["playlist_id"]),
                )

            renamed += 1

    action = "would rename" if args.dry_run else "renamed"
    print(f"\nDone: {action} {renamed} of {len(rows)} artist playlists.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
