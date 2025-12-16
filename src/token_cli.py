from __future__ import annotations

import argparse
import sys
from pathlib import Path

from spotipy.oauth2 import SpotifyOAuth

from src.config import ConfigError, load_config


def _get_cache_path() -> Path:
    cfg = load_config(require_spotify=True)
    if cfg.spotify is None:
        raise ConfigError("Spotify configuration missing; set SPOTIFY_* env vars.")
    return Path(cfg.spotify.cache_path).expanduser()


def _fetch_token() -> int:
    try:
        cfg = load_config(require_spotify=True)
    except ConfigError as exc:
        print(f"Config error: {exc}", file=sys.stderr)
        return 1

    if cfg.spotify is None:
        print("Spotify configuration missing; set SPOTIFY_* env vars.", file=sys.stderr)
        return 1

    cache_path = Path(cfg.spotify.cache_path).expanduser()
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    print("Starting Spotify OAuth. You may be prompted to open a browser.")
    print(f"Token cache file: {cache_path}")
    auth_manager = SpotifyOAuth(
        client_id=cfg.spotify.client_id,
        client_secret=cfg.spotify.client_secret,
        redirect_uri=cfg.spotify.redirect_uri,
        scope=cfg.spotify.scope,
        cache_path=str(cache_path),
        open_browser=True,
        show_dialog=True,
    )
    try:
        token_info = auth_manager.get_access_token(as_dict=True, check_cache=True)
    except Exception as exc:  # noqa: BLE001
        print(f"OAuth failed: {exc}", file=sys.stderr)
        return 1

    if token_info:
        print("OAuth complete. Token cached.")
        return 0

    print("Failed to obtain token.", file=sys.stderr)
    return 1


def _clear_token() -> int:
    try:
        cache_path = _get_cache_path()
    except ConfigError as exc:
        print(f"Config error: {exc}", file=sys.stderr)
        return 1

    if cache_path.exists():
        cache_path.unlink()
        print(f"Deleted token cache at {cache_path}")
    else:
        print(f"No token cache found at {cache_path}")
    return 0


def _info() -> int:
    try:
        cache_path = _get_cache_path()
    except ConfigError as exc:
        print(f"Config error: {exc}", file=sys.stderr)
        return 1

    exists = cache_path.exists()
    print(f"Cache path: {cache_path}")
    print(f"Exists: {exists}")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(prog="token")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("fetch", help="Run OAuth flow and cache token")
    sub.add_parser("clear", help="Delete cached token")
    sub.add_parser("info", help="Show cache path and status")
    args = parser.parse_args()

    if args.cmd == "fetch":
        raise SystemExit(_fetch_token())
    if args.cmd == "clear":
        raise SystemExit(_clear_token())
    if args.cmd == "info":
        raise SystemExit(_info())


if __name__ == "__main__":
    main()
