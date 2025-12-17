from __future__ import annotations

import os
import ipaddress
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlparse

from dotenv import load_dotenv
from pathlib import Path

# Load only the repo-local .env to avoid accidentally picking up
# env files from unrelated working directories.
_ROOT_DIR = Path(__file__).resolve().parent.parent
load_dotenv(_ROOT_DIR / ".env")


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
    like_batch_size: int
    cache_path: str


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


def _required_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise ConfigError(f"Missing required env var: {name}")
    return value


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
        scope=os.getenv(
            "SPOTIFY_SCOPE",
            "user-read-recently-played playlist-modify-private user-library-modify user-library-read",
        ),
        all_playlist_id=_required_env("SPOTIFY_ALL_PLAYLIST_ID"),
        frequent_playlist_id=os.getenv("SPOTIFY_FREQUENT_PLAYLIST_ID"),
        frequent_min_plays=_positive_int("FREQUENT_MIN_PLAYS", _int_env("FREQUENT_MIN_PLAYS", 2)),
        like_batch_size=_positive_int("LIKE_BATCH_SIZE", _int_env("LIKE_BATCH_SIZE", 50)),
        cache_path=os.getenv("SPOTIFY_TOKEN_CACHE_PATH", "data/.spotify_token_cache.json"),
    )


def load_config(*, require_spotify: bool = True) -> AppConfig:
    """
    Load configuration from environment. If require_spotify is False, Spotify
    values may be missing (used by migrate).
    """
    db_cfg = DbConfig(path=os.getenv("DB_PATH", "data/spotify.db"))
    spotify_cfg: Optional[SpotifyConfig]
    try:
        spotify_cfg = _load_spotify_config()
    except ConfigError:
        if require_spotify:
            raise
        spotify_cfg = None

    return AppConfig(
        db=db_cfg,
        spotify=spotify_cfg,
        log_level=os.getenv("LOG_LEVEL", "INFO"),
        bootstrap_hours=_positive_int("BOOTSTRAP_HOURS", _int_env("BOOTSTRAP_HOURS", 24)),
        recently_played_limit=min(
            50,
            _positive_int("RECENTLY_PLAYED_LIMIT", _int_env("RECENTLY_PLAYED_LIMIT", 50)),
        ),
        add_batch_size=_positive_int("PLAYLIST_ADD_BATCH_SIZE", _int_env("PLAYLIST_ADD_BATCH_SIZE", 100)),
        like_batch_size=_positive_int("LIKE_BATCH_SIZE", _int_env("LIKE_BATCH_SIZE", 50)),
        log_file=os.getenv("LOG_FILE", "data/logs/spotify.log"),
        log_retention_days=_positive_int("LOG_RETENTION_DAYS", _int_env("LOG_RETENTION_DAYS", 7)),
    )
