from __future__ import annotations

from dataclasses import replace

import pytest

import src.config as _config_mod
from src.config import AppConfig, DbConfig, SpotifyConfig


@pytest.fixture(autouse=True)
def _reset_config_caches():
    """Reset YAML cache and skip dotenv loading so tests control their own env."""
    _config_mod._yaml_cache = None
    _config_mod._dotenv_loaded = True  # prevent load_dotenv from reading the real .env
    yield
    _config_mod._yaml_cache = None
    _config_mod._dotenv_loaded = True


class FakeSpotify:
    """Unified fake Spotify client for all tests."""

    def __init__(
        self,
        payload: dict | None = None,
        *,
        playlist_total: int | None = None,
        pages: dict[int, dict] | None = None,
        raise_on_call: bool = False,
        playlist_items_payload: dict | None = None,
        saved_tracks_payload: dict | None = None,
    ) -> None:
        self.payload = payload or {}
        self.pages = pages or {}
        self.add_calls: list[dict] = []
        self.saved_calls: list[list[str]] = []
        self.recently_played_args: list[dict] = []
        self.playlist_total = playlist_total
        self.raise_on_call = raise_on_call
        self.playlist_items_payload = playlist_items_payload or {"items": [], "next": None}
        self.saved_tracks_payload = saved_tracks_payload or {"items": [], "next": None}
        self._playlist_counter = 0

    def current_user_recently_played(self, *, limit: int, after: int) -> dict:
        if self.raise_on_call:
            raise RuntimeError("boom")
        self.recently_played_args.append({"limit": limit, "after": after})
        if self.pages:
            return self.pages.get(after, {})
        return self.payload

    def playlist_add_items(self, playlist_id: str, items: list[str]) -> dict:
        self.add_calls.append({"playlist_id": playlist_id, "items": list(items)})
        return {}

    def current_user_saved_tracks_add(self, tracks: list[str]) -> dict:
        self.saved_calls.append(list(tracks))
        return {}

    def current_user_saved_tracks(self, *, limit: int = 50, offset: int = 0) -> dict:
        return self.saved_tracks_payload

    def playlist(self, playlist_id: str, fields: str | None = None) -> dict:
        if self.playlist_total is None:
            return {"tracks": {"total": 0}}
        return {"tracks": {"total": self.playlist_total}}

    def playlist_items(
        self,
        playlist_id: str,
        limit: int = 100,
        offset: int = 0,
        fields: str | None = None,
    ) -> dict:
        return self.playlist_items_payload

    def me(self) -> dict:
        return {"id": "testuser"}

    def user_playlist_create(
        self,
        user: str,
        name: str,
        public: bool = False,
        description: str = "",
    ) -> dict:
        self._playlist_counter += 1
        return {"id": f"created-playlist-{self._playlist_counter}"}


def make_config(tmp_path, **overrides) -> AppConfig:
    """Create a standard AppConfig for testing."""
    defaults = dict(
        db=DbConfig(path=str(tmp_path / "db.sqlite")),
        spotify=SpotifyConfig(
            client_id="id",
            client_secret="secret",
            redirect_uri="https://example.com/callback",
            scope="user-read-recently-played playlist-modify-private user-library-modify user-library-read",
            all_playlist_id="playlist123",
            frequent_playlist_id=None,
            frequent_min_plays=2,
            like_batch_size=50,
            cache_path=str(tmp_path / ".cache"),
        ),
        log_level="DEBUG",
        like_batch_size=50,
    )
    defaults.update(overrides)
    return AppConfig(**defaults)


def make_config_with_freq(tmp_path, **overrides) -> AppConfig:
    """Create an AppConfig with a frequent playlist configured."""
    cfg = make_config(tmp_path)
    freq_spotify = replace(cfg.spotify, frequent_playlist_id="freq123")
    return replace(cfg, spotify=freq_spotify, **overrides)
