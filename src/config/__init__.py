from __future__ import annotations

import os
import ipaddress
from dataclasses import dataclass, field
from typing import Any, Optional
from urllib.parse import urlparse

from pathlib import Path

import yaml

_CONFIG_DIR = Path(__file__).resolve().parent
_ROOT_DIR = _CONFIG_DIR.parent.parent
_dotenv_loaded = False
_yaml_cache: dict[str, Any] | None = None


class ConfigError(RuntimeError):
    """Raised when required configuration is missing."""


@dataclass(frozen=True)
class DbConfig:
    path: str


@dataclass(frozen=True)
class SpotifyConfig:
    client_id: str
    client_secret: str
    redirect_uri: str
    scope: str
    all_playlist_id: str
    frequent_playlist_id: Optional[str]
    frequent_min_plays: int
    hindi_favorites_playlist_id: Optional[str]
    hindi_favorites_min_plays: int
    like_batch_size: int
    cache_path: str


@dataclass(frozen=True)
class ArtistDiscoveryConfig:
    """Thresholds for the discover_artists SQL query and artist playlist building."""

    plays_per_song_threshold: int = 20
    songs_over_threshold: int = 15
    total_streams_threshold: int = 1500
    alt_song_count: int = 60
    alt_streams_threshold: int = 500
    min_plays_per_track: int = 30
    max_tracks_per_playlist: int = 50
    min_tracks_per_playlist: int = 10


@dataclass(frozen=True)
class AppConfig:
    db: DbConfig
    spotify: Optional[SpotifyConfig]
    log_level: str = "INFO"
    bootstrap_hours: int = 24
    recently_played_limit: int = 50
    add_batch_size: int = 100
    like_batch_size: int = 50
    log_file: str = "data/logs/spotify.log"
    log_retention_days: int = 7
    artist_discovery: ArtistDiscoveryConfig = field(default_factory=ArtistDiscoveryConfig)
    yearly_max_tracks: int = 100
    cache_refresh_hours: int = 24


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _load_yaml() -> dict[str, Any]:
    """Load config.yaml from the config package directory. Returns {} if missing."""
    global _yaml_cache  # noqa: PLW0603
    if _yaml_cache is not None:
        return _yaml_cache
    yaml_path = _CONFIG_DIR / "config.yaml"
    if yaml_path.is_file():
        with open(yaml_path) as f:
            _yaml_cache = yaml.safe_load(f) or {}
    else:
        _yaml_cache = {}
    return _yaml_cache


def _yaml_get(section: str, key: str) -> Any:
    """Retrieve a nested value from the YAML config, or None if absent."""
    data = _load_yaml()
    sec = data.get(section)
    if isinstance(sec, dict):
        return sec.get(key)
    return None


def _required_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise ConfigError(f"Missing required env var: {name}")
    return value


def _resolve_str(env_name: str, yaml_section: str, yaml_key: str, default: str) -> str:
    """Env var > YAML > hardcoded default."""
    env_val = os.getenv(env_name)
    if env_val is not None:
        return env_val
    yaml_val = _yaml_get(yaml_section, yaml_key)
    if yaml_val is not None:
        return str(yaml_val)
    return default


def _resolve_int(env_name: str, yaml_section: str, yaml_key: str, default: int) -> int:
    """Env var > YAML > hardcoded default (with int parsing/validation)."""
    raw = os.getenv(env_name)
    if raw is not None:
        try:
            return int(raw)
        except ValueError as exc:  # noqa: TRY003
            raise ConfigError(f"{env_name} must be an integer") from exc
    yaml_val = _yaml_get(yaml_section, yaml_key)
    if yaml_val is not None:
        try:
            return int(yaml_val)
        except (ValueError, TypeError) as exc:
            raise ConfigError(f"{yaml_section}.{yaml_key} in config.yaml must be an integer") from exc
    return default


def _int_env(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError as exc:  # noqa: TRY003
        raise ConfigError(f"{name} must be an integer") from exc


def _positive_int(name: str, value: int, *, minimum: int = 1) -> int:
    if value < minimum:
        raise ConfigError(f"{name} must be >= {minimum}")
    return value


# ---------------------------------------------------------------------------
# Config builders
# ---------------------------------------------------------------------------

def _load_spotify_config() -> SpotifyConfig:
    redirect_uri = _required_env("SPOTIFY_REDIRECT_URI")
    parsed = urlparse(redirect_uri)
    if parsed.scheme not in ("http", "https"):
        raise ConfigError("SPOTIFY_REDIRECT_URI must use http or https")

    if parsed.scheme == "http":
        host = parsed.hostname or ""
        try:
            ip = ipaddress.ip_address(host)
            if not ip.is_loopback:
                raise ConfigError(
                    "SPOTIFY_REDIRECT_URI must be HTTPS unless using an explicit loopback IP (e.g. http://127.0.0.1:PORT or http://[::1]:PORT). 'localhost' is not allowed."
                )
        except ValueError as exc:
            raise ConfigError(
                "SPOTIFY_REDIRECT_URI must be HTTPS unless using an explicit loopback IP (e.g. http://127.0.0.1:PORT or http://[::1]:PORT). 'localhost' is not allowed."
            ) from exc

    return SpotifyConfig(
        client_id=_required_env("SPOTIFY_CLIENT_ID"),
        client_secret=_required_env("SPOTIFY_CLIENT_SECRET"),
        redirect_uri=redirect_uri,
        scope=_resolve_str(
            "SPOTIFY_SCOPE", "spotify", "scope",
            "user-read-recently-played playlist-modify-private user-library-modify user-library-read",
        ),
        all_playlist_id=_required_env("SPOTIFY_ALL_PLAYLIST_ID"),
        frequent_playlist_id=os.getenv("SPOTIFY_FREQUENT_PLAYLIST_ID"),
        hindi_favorites_playlist_id=os.getenv("SPOTIFY_HINDI_FAVORITES_PLAYLIST_ID"),
        hindi_favorites_min_plays=_positive_int(
            "HINDI_FAVORITES_MIN_PLAYS",
            _resolve_int("HINDI_FAVORITES_MIN_PLAYS", "spotify", "hindi_favorites_min_plays", 5),
        ),
        frequent_min_plays=_positive_int(
            "FREQUENT_MIN_PLAYS",
            _resolve_int("FREQUENT_MIN_PLAYS", "spotify", "frequent_min_plays", 2),
        ),
        like_batch_size=_positive_int(
            "LIKE_BATCH_SIZE",
            _resolve_int("LIKE_BATCH_SIZE", "spotify", "like_batch_size", 50),
        ),
        cache_path=_resolve_str(
            "SPOTIFY_TOKEN_CACHE_PATH", "spotify", "cache_path",
            "data/.spotify_token_cache.json",
        ),
    )


def load_config(*, require_spotify: bool = True) -> AppConfig:
    """
    Load configuration from config.yaml, overridden by environment variables.
    Secrets (client_id, client_secret, redirect_uri, playlist IDs) are
    env-var-only. If require_spotify is False, Spotify values may be missing
    (used by migrate).
    """
    global _dotenv_loaded  # noqa: PLW0603
    if not _dotenv_loaded:
        from dotenv import load_dotenv
        load_dotenv(_ROOT_DIR / ".env")
        _dotenv_loaded = True

    db_cfg = DbConfig(
        path=_resolve_str("DB_PATH", "db", "path", "data/spotify.db"),
    )

    spotify_cfg: Optional[SpotifyConfig]
    try:
        spotify_cfg = _load_spotify_config()
    except ConfigError:
        if require_spotify:
            raise
        spotify_cfg = None

    artist_discovery = ArtistDiscoveryConfig(
        plays_per_song_threshold=_positive_int(
            "ARTIST_PLAYS_PER_SONG_THRESHOLD",
            _resolve_int("ARTIST_PLAYS_PER_SONG_THRESHOLD", "artist_discovery", "plays_per_song_threshold", 20),
        ),
        songs_over_threshold=_positive_int(
            "ARTIST_SONGS_OVER_THRESHOLD",
            _resolve_int("ARTIST_SONGS_OVER_THRESHOLD", "artist_discovery", "songs_over_threshold", 15),
        ),
        total_streams_threshold=_positive_int(
            "ARTIST_TOTAL_STREAMS_THRESHOLD",
            _resolve_int("ARTIST_TOTAL_STREAMS_THRESHOLD", "artist_discovery", "total_streams_threshold", 1500),
        ),
        alt_song_count=_positive_int(
            "ARTIST_ALT_SONG_COUNT",
            _resolve_int("ARTIST_ALT_SONG_COUNT", "artist_discovery", "alt_song_count", 60),
        ),
        alt_streams_threshold=_positive_int(
            "ARTIST_ALT_STREAMS_THRESHOLD",
            _resolve_int("ARTIST_ALT_STREAMS_THRESHOLD", "artist_discovery", "alt_streams_threshold", 500),
        ),
        min_plays_per_track=_positive_int(
            "ARTIST_MIN_PLAYS_PER_TRACK",
            _resolve_int("ARTIST_MIN_PLAYS_PER_TRACK", "artist_discovery", "min_plays_per_track", 30),
        ),
        max_tracks_per_playlist=_positive_int(
            "ARTIST_MAX_TRACKS_PER_PLAYLIST",
            _resolve_int("ARTIST_MAX_TRACKS_PER_PLAYLIST", "artist_discovery", "max_tracks_per_playlist", 50),
        ),
        min_tracks_per_playlist=_positive_int(
            "ARTIST_MIN_TRACKS_PER_PLAYLIST",
            _resolve_int("ARTIST_MIN_TRACKS_PER_PLAYLIST", "artist_discovery", "min_tracks_per_playlist", 10),
        ),
    )

    return AppConfig(
        db=db_cfg,
        spotify=spotify_cfg,
        log_level=_resolve_str("LOG_LEVEL", "logging", "level", "INFO"),
        bootstrap_hours=_positive_int(
            "BOOTSTRAP_HOURS",
            _resolve_int("BOOTSTRAP_HOURS", "general", "bootstrap_hours", 24),
        ),
        recently_played_limit=min(
            50,
            _positive_int(
                "RECENTLY_PLAYED_LIMIT",
                _resolve_int("RECENTLY_PLAYED_LIMIT", "general", "recently_played_limit", 50),
            ),
        ),
        add_batch_size=_positive_int(
            "PLAYLIST_ADD_BATCH_SIZE",
            _resolve_int("PLAYLIST_ADD_BATCH_SIZE", "general", "add_batch_size", 100),
        ),
        like_batch_size=_positive_int(
            "LIKE_BATCH_SIZE",
            _resolve_int("LIKE_BATCH_SIZE", "general", "like_batch_size", 50),
        ),
        log_file=_resolve_str("LOG_FILE", "logging", "file", "data/logs/spotify.log"),
        log_retention_days=_positive_int(
            "LOG_RETENTION_DAYS",
            _resolve_int("LOG_RETENTION_DAYS", "logging", "retention_days", 7),
        ),
        artist_discovery=artist_discovery,
        yearly_max_tracks=_positive_int(
            "YEARLY_MAX_TRACKS",
            _resolve_int("YEARLY_MAX_TRACKS", "yearly", "max_tracks", 100),
        ),
        cache_refresh_hours=_positive_int(
            "CACHE_REFRESH_HOURS",
            _resolve_int("CACHE_REFRESH_HOURS", "general", "cache_refresh_hours", 24),
        ),
    )
