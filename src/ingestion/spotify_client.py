from __future__ import annotations

from pathlib import Path
from typing import Protocol

from spotipy import Spotify
from spotipy.oauth2 import SpotifyOAuth

from src.config import SpotifyConfig


class SpotifyClient(Protocol):
    def current_user_recently_played(self, *, limit: int, after: int) -> dict: ...

    def playlist_add_items(self, playlist_id: str, items: list[str]) -> dict: ...

    def current_user_saved_tracks_add(self, tracks: list[str]) -> dict: ...

    def playlist(self, playlist_id: str, fields: str | None = None) -> dict: ...

    def playlist_items(
        self,
        playlist_id: str,
        limit: int = ...,
        offset: int = ...,
        fields: str | None = ...,
    ) -> dict: ...


def get_spotify(cfg: SpotifyConfig) -> SpotifyClient:
    """
    Build a Spotipy client using OAuth + on-disk token cache.
    """
    cache_path = str(Path(cfg.cache_path).expanduser())
    Path(cache_path).parent.mkdir(parents=True, exist_ok=True)
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
