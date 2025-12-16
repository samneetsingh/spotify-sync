from __future__ import annotations

import sys
from pathlib import Path

from spotipy.oauth2 import SpotifyOAuth

from src.config import ConfigError, load_config


def main() -> int:
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


if __name__ == "__main__":
    raise SystemExit(main())
