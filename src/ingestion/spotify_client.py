from __future__ import annotations

import logging
from pathlib import Path
from typing import Protocol

from spotipy import Spotify
from spotipy.oauth2 import SpotifyOAuth

from src.config import SpotifyConfig

log = logging.getLogger(__name__)


class SpotifyClient(Protocol):
    def current_user_recently_played(self, *, limit: int, after: int) -> dict: ...

    def playlist_add_items(self, playlist_id: str, items: list[str]) -> dict: ...

    def current_user_saved_tracks_add(self, tracks: list[str]) -> dict: ...

    def current_user_saved_tracks(self, *, limit: int = ..., offset: int = ...) -> dict: ...

    def playlist(self, playlist_id: str, fields: str | None = None) -> dict: ...

    def playlist_items(
        self,
        playlist_id: str,
        limit: int = ...,
        offset: int = ...,
        fields: str | None = ...,
    ) -> dict: ...

    def me(self) -> dict: ...

    def user_playlist_create(
        self,
        user: str,
        name: str,
        public: bool = ...,
        description: str = ...,
    ) -> dict: ...

    def playlist_change_details(
        self,
        playlist_id: str,
        name: str | None = ...,
        description: str | None = ...,
    ) -> dict: ...

    def current_user_unfollow_playlist(self, playlist_id: str) -> dict: ...


def get_spotify(cfg: SpotifyConfig) -> SpotifyClient:
    """
    Build a Spotipy client using OAuth + on-disk token cache.
    """
    cache_path = str(Path(cfg.cache_path).expanduser())
    cache_file = Path(cache_path)
    cache_dir = cache_file.parent
    cache_dir.mkdir(parents=True, exist_ok=True)
    try:
        cache_dir.chmod(0o700)
        if not cache_file.exists():
            cache_file.touch(mode=0o600, exist_ok=True)
        cache_file.chmod(0o600)
    except OSError:
        log.debug("Could not set permissions on token cache %s", cache_path)
    auth_manager = SpotifyOAuth(
        client_id=cfg.client_id,
        client_secret=cfg.client_secret,
        redirect_uri=cfg.redirect_uri,
        scope=cfg.scope,
        cache_path=cache_path,
        open_browser=True,
        show_dialog=True,
    )
    return Spotify(auth_manager=auth_manager, requests_timeout=20)
