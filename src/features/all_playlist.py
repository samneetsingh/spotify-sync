from __future__ import annotations

from src.config import AppConfig
from src.db.connection import DB
from src.ingestion.spotify_client import SpotifyClient, get_spotify
from src.ingestion.sync_recent import SyncResult, sync_recent


def run_all_playlist(cfg: AppConfig, db: DB, spotify: SpotifyClient | None = None) -> SyncResult:
    """
    Thin wrapper to run the ingestion sync and return a summary.
    """
    if cfg.spotify is None:
        raise RuntimeError("Spotify credentials not configured")
    sp = spotify or get_spotify(cfg.spotify)
    return sync_recent(cfg, db, sp)
