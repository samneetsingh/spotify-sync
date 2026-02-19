from __future__ import annotations

import os
from unittest import mock

import pytest

import src.config as _config_mod
from src.config import (
    ArtistDiscoveryConfig,
    AppConfig,
    ConfigError,
    DbConfig,
    SpotifyConfig,
    _int_env,
    _positive_int,
    _required_env,
    _load_yaml,
    load_config,
)

_SPOTIFY_SECRETS = {
    "SPOTIFY_CLIENT_ID": "id",
    "SPOTIFY_CLIENT_SECRET": "secret",
    "SPOTIFY_REDIRECT_URI": "https://example.com/callback",
    "SPOTIFY_ALL_PLAYLIST_ID": "pl123",
}


# --- Helper function tests ---


def test_required_env_present() -> None:
    with mock.patch.dict(os.environ, {"TEST_VAR": "hello"}):
        assert _required_env("TEST_VAR") == "hello"


def test_required_env_missing() -> None:
    with mock.patch.dict(os.environ, {}, clear=True):
        with pytest.raises(ConfigError, match="Missing required env var"):
            _required_env("NONEXISTENT_VAR_12345")


def test_required_env_empty_string() -> None:
    with mock.patch.dict(os.environ, {"EMPTY_VAR": ""}):
        with pytest.raises(ConfigError, match="Missing required env var"):
            _required_env("EMPTY_VAR")


def test_int_env_valid() -> None:
    with mock.patch.dict(os.environ, {"INT_VAR": "42"}):
        assert _int_env("INT_VAR", 0) == 42


def test_int_env_missing_uses_default() -> None:
    with mock.patch.dict(os.environ, {}, clear=True):
        assert _int_env("MISSING_INT_VAR_12345", 99) == 99


def test_int_env_non_integer() -> None:
    with mock.patch.dict(os.environ, {"BAD_INT": "not_a_number"}):
        with pytest.raises(ConfigError, match="must be an integer"):
            _int_env("BAD_INT", 0)


def test_positive_int_valid() -> None:
    assert _positive_int("TEST", 5) == 5
    assert _positive_int("TEST", 1) == 1


def test_positive_int_below_minimum() -> None:
    with pytest.raises(ConfigError, match="must be >= 1"):
        _positive_int("TEST", 0)


def test_positive_int_custom_minimum() -> None:
    with pytest.raises(ConfigError, match="must be >= 10"):
        _positive_int("TEST", 5, minimum=10)


# --- ArtistDiscoveryConfig tests ---


def test_artist_discovery_defaults() -> None:
    dc = ArtistDiscoveryConfig()
    assert dc.plays_per_song_threshold == 20
    assert dc.songs_over_threshold == 15
    assert dc.total_streams_threshold == 1500
    assert dc.alt_song_count == 60
    assert dc.alt_streams_threshold == 500
    assert dc.min_plays_per_track == 30
    assert dc.max_tracks_per_playlist == 50


def test_artist_discovery_custom_values() -> None:
    dc = ArtistDiscoveryConfig(
        plays_per_song_threshold=10,
        songs_over_threshold=5,
        total_streams_threshold=500,
    )
    assert dc.plays_per_song_threshold == 10
    assert dc.songs_over_threshold == 5
    assert dc.total_streams_threshold == 500


# --- AppConfig defaults ---


def test_app_config_defaults() -> None:
    cfg = AppConfig(
        db=DbConfig(path="test.db"),
        spotify=None,
    )
    assert cfg.log_level == "INFO"
    assert cfg.bootstrap_hours == 24
    assert cfg.recently_played_limit == 50
    assert cfg.add_batch_size == 100
    assert cfg.like_batch_size == 50
    assert cfg.yearly_max_tracks == 100
    assert cfg.cache_refresh_hours == 24
    assert cfg.artist_discovery == ArtistDiscoveryConfig()


def test_app_config_is_frozen() -> None:
    cfg = AppConfig(db=DbConfig(path="test.db"), spotify=None)
    with pytest.raises(AttributeError):
        cfg.log_level = "DEBUG"


# --- Redirect URI validation ---


def test_redirect_uri_https_valid() -> None:
    """HTTPS redirect URIs should always be accepted."""
    env = {
        "SPOTIFY_CLIENT_ID": "id",
        "SPOTIFY_CLIENT_SECRET": "secret",
        "SPOTIFY_REDIRECT_URI": "https://example.com/callback",
        "SPOTIFY_ALL_PLAYLIST_ID": "pl123",
    }
    with mock.patch.dict(os.environ, env, clear=True):
        cfg = load_config()
        assert cfg.spotify is not None
        assert cfg.spotify.redirect_uri == "https://example.com/callback"


def test_redirect_uri_loopback_valid() -> None:
    """HTTP with loopback IP should be accepted."""
    env = {
        "SPOTIFY_CLIENT_ID": "id",
        "SPOTIFY_CLIENT_SECRET": "secret",
        "SPOTIFY_REDIRECT_URI": "http://127.0.0.1:8888/callback",
        "SPOTIFY_ALL_PLAYLIST_ID": "pl123",
    }
    with mock.patch.dict(os.environ, env, clear=True):
        cfg = load_config()
        assert cfg.spotify is not None


def test_redirect_uri_http_non_loopback_rejected() -> None:
    """HTTP with non-loopback IP should be rejected."""
    env = {
        "SPOTIFY_CLIENT_ID": "id",
        "SPOTIFY_CLIENT_SECRET": "secret",
        "SPOTIFY_REDIRECT_URI": "http://192.168.1.1:8888/callback",
        "SPOTIFY_ALL_PLAYLIST_ID": "pl123",
    }
    with mock.patch.dict(os.environ, env, clear=True):
        with pytest.raises(ConfigError, match="loopback"):
            load_config()


def test_redirect_uri_localhost_rejected() -> None:
    """HTTP with 'localhost' hostname should be rejected (only IPs allowed)."""
    env = {
        "SPOTIFY_CLIENT_ID": "id",
        "SPOTIFY_CLIENT_SECRET": "secret",
        "SPOTIFY_REDIRECT_URI": "http://localhost:8888/callback",
        "SPOTIFY_ALL_PLAYLIST_ID": "pl123",
    }
    with mock.patch.dict(os.environ, env, clear=True):
        with pytest.raises(ConfigError, match="loopback"):
            load_config()


def test_redirect_uri_ftp_rejected() -> None:
    """Non-http/https schemes should be rejected."""
    env = {
        "SPOTIFY_CLIENT_ID": "id",
        "SPOTIFY_CLIENT_SECRET": "secret",
        "SPOTIFY_REDIRECT_URI": "ftp://example.com/callback",
        "SPOTIFY_ALL_PLAYLIST_ID": "pl123",
    }
    with mock.patch.dict(os.environ, env, clear=True):
        with pytest.raises(ConfigError, match="http or https"):
            load_config()


# --- load_config with require_spotify=False ---


def test_load_config_without_spotify() -> None:
    """When require_spotify=False and Spotify vars missing, spotify should be None."""
    with mock.patch.dict(os.environ, {}, clear=True):
        cfg = load_config(require_spotify=False)
        assert cfg.spotify is None
        assert cfg.db.path == "data/spotify.db"


def test_load_config_missing_spotify_raises() -> None:
    """When require_spotify=True and vars missing, should raise ConfigError."""
    with mock.patch.dict(os.environ, {}, clear=True):
        with pytest.raises(ConfigError):
            load_config(require_spotify=True)


# --- Artist discovery env vars ---


def test_load_config_artist_discovery_from_env() -> None:
    """Artist discovery thresholds should be loaded from environment."""
    env = {
        **_SPOTIFY_SECRETS,
        "ARTIST_PLAYS_PER_SONG_THRESHOLD": "10",
        "ARTIST_SONGS_OVER_THRESHOLD": "5",
        "ARTIST_TOTAL_STREAMS_THRESHOLD": "800",
        "ARTIST_ALT_SONG_COUNT": "30",
        "ARTIST_ALT_STREAMS_THRESHOLD": "200",
        "ARTIST_MIN_PLAYS_PER_TRACK": "15",
        "ARTIST_MAX_TRACKS_PER_PLAYLIST": "25",
        "YEARLY_MAX_TRACKS": "50",
        "CACHE_REFRESH_HOURS": "12",
    }
    with mock.patch.dict(os.environ, env, clear=True):
        cfg = load_config()
        assert cfg.artist_discovery.plays_per_song_threshold == 10
        assert cfg.artist_discovery.songs_over_threshold == 5
        assert cfg.artist_discovery.total_streams_threshold == 800
        assert cfg.artist_discovery.alt_song_count == 30
        assert cfg.artist_discovery.alt_streams_threshold == 200
        assert cfg.artist_discovery.min_plays_per_track == 15
        assert cfg.artist_discovery.max_tracks_per_playlist == 25
        assert cfg.yearly_max_tracks == 50
        assert cfg.cache_refresh_hours == 12


# --- YAML config loading tests ---


def test_yaml_values_used_when_no_env_vars(tmp_path) -> None:
    """YAML values should be used when no env vars are set for non-secret fields."""
    yaml_data = {
        "db": {"path": "custom/db.sqlite"},
        "logging": {"level": "DEBUG", "file": "custom/app.log", "retention_days": 14},
        "general": {
            "bootstrap_hours": 48,
            "recently_played_limit": 25,
            "add_batch_size": 200,
            "like_batch_size": 75,
            "cache_refresh_hours": 6,
        },
        "artist_discovery": {"plays_per_song_threshold": 99, "max_tracks_per_playlist": 10},
        "yearly": {"max_tracks": 42},
    }
    with (
        mock.patch.dict(os.environ, _SPOTIFY_SECRETS, clear=True),
        mock.patch.object(_config_mod, "_load_yaml", return_value=yaml_data),
    ):
        cfg = load_config()
    assert cfg.db.path == "custom/db.sqlite"
    assert cfg.log_level == "DEBUG"
    assert cfg.log_file == "custom/app.log"
    assert cfg.log_retention_days == 14
    assert cfg.bootstrap_hours == 48
    assert cfg.recently_played_limit == 25
    assert cfg.add_batch_size == 200
    assert cfg.like_batch_size == 75
    assert cfg.cache_refresh_hours == 6
    assert cfg.artist_discovery.plays_per_song_threshold == 99
    assert cfg.artist_discovery.max_tracks_per_playlist == 10
    assert cfg.yearly_max_tracks == 42


def test_env_overrides_yaml() -> None:
    """Environment variables should take precedence over YAML values."""
    yaml_data = {
        "logging": {"level": "DEBUG"},
        "general": {"bootstrap_hours": 48},
        "artist_discovery": {"plays_per_song_threshold": 99},
    }
    env = {
        **_SPOTIFY_SECRETS,
        "LOG_LEVEL": "WARNING",
        "BOOTSTRAP_HOURS": "12",
        "ARTIST_PLAYS_PER_SONG_THRESHOLD": "5",
    }
    with (
        mock.patch.dict(os.environ, env, clear=True),
        mock.patch.object(_config_mod, "_load_yaml", return_value=yaml_data),
    ):
        cfg = load_config()
    assert cfg.log_level == "WARNING"
    assert cfg.bootstrap_hours == 12
    assert cfg.artist_discovery.plays_per_song_threshold == 5


def test_missing_yaml_falls_back_to_defaults() -> None:
    """When config.yaml is missing, hardcoded defaults should be used."""
    with (
        mock.patch.dict(os.environ, _SPOTIFY_SECRETS, clear=True),
        mock.patch.object(_config_mod, "_load_yaml", return_value={}),
    ):
        cfg = load_config()
    assert cfg.db.path == "data/spotify.db"
    assert cfg.log_level == "INFO"
    assert cfg.bootstrap_hours == 24
    assert cfg.artist_discovery.plays_per_song_threshold == 20
    assert cfg.yearly_max_tracks == 100


def test_yaml_spotify_non_secret_fields() -> None:
    """YAML should provide spotify non-secret values (scope, cache_path, etc.)."""
    yaml_data = {
        "spotify": {
            "scope": "user-read-recently-played",
            "cache_path": "custom/.cache.json",
            "frequent_min_plays": 10,
            "like_batch_size": 25,
        },
    }
    with (
        mock.patch.dict(os.environ, _SPOTIFY_SECRETS, clear=True),
        mock.patch.object(_config_mod, "_load_yaml", return_value=yaml_data),
    ):
        cfg = load_config()
    assert cfg.spotify.scope == "user-read-recently-played"
    assert cfg.spotify.cache_path == "custom/.cache.json"
    assert cfg.spotify.frequent_min_plays == 10
    assert cfg.spotify.like_batch_size == 25


def test_load_yaml_returns_empty_dict_for_missing_file(tmp_path) -> None:
    """_load_yaml should return {} when the yaml file doesn't exist."""
    _config_mod._yaml_cache = None
    with mock.patch.object(_config_mod, "_CONFIG_DIR", tmp_path):
        result = _load_yaml()
    assert result == {}
