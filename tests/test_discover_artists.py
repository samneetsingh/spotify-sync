"""Tests for the discover_artists SQL query with configurable thresholds.

These tests validate the boundary conditions of the artist discovery
logic, which uses the HAVING clause:

    songs_over_threshold > ? OR total_streams > ? OR (song_count > ? AND total_streams > ?)

"""
from __future__ import annotations

from datetime import datetime, timezone

from conftest import make_config

from src.config import ArtistDiscoveryConfig
from src.db.connection import DB
from src.db import queries


def _seed_artist(db: DB, artist: str, tracks: list[tuple[str, str, int]]) -> None:
    """Seed tracks and plays for an artist.

    tracks: list of (track_id, track_name, play_count)
    """
    base_ms = int(datetime(2023, 1, 1, tzinfo=timezone.utc).timestamp() * 1000)
    offset = 0
    for track_id, track_name, play_count in tracks:
        queries.upsert_tracks(
            db,
            [(track_id, f"spotify:track:{track_id}", track_name, artist, "Album", 1000, 0)],
        )
        plays = []
        for i in range(play_count):
            plays.append((base_ms + offset, track_id, f"spotify:track:{track_id}", None, None, "test"))
            offset += 1
        queries.insert_plays(db, plays)


def test_discover_songs_over_threshold_boundary(tmp_path) -> None:
    """Test the 'songs_over_threshold > N' condition at boundary.

    With default thresholds: plays_per_song_threshold=20, songs_over_threshold=15.
    An artist needs >15 songs with >20 plays each.
    """
    cfg = make_config(tmp_path)
    db = DB(cfg.db.path)
    db.migrate()

    # Artist with exactly 15 songs over 20 plays — should NOT qualify (need >15)
    tracks_15 = [(f"t{i}", f"Song{i}", 21) for i in range(15)]
    _seed_artist(db, "Boundary Artist", tracks_15)

    discovery = ArtistDiscoveryConfig(
        plays_per_song_threshold=20,
        songs_over_threshold=15,
        total_streams_threshold=999999,  # disable other conditions
        alt_song_count=999999,
        alt_streams_threshold=999999,
    )
    artists = queries.discover_artists(db, discovery)
    artist_names = {a["artist"] for a in artists}
    assert "Boundary Artist" not in artist_names

    # Add one more song to push to 16 — should now qualify
    _seed_artist(db, "Boundary Artist", [("t_extra", "Extra Song", 21)])

    artists = queries.discover_artists(db, discovery)
    artist_names = {a["artist"] for a in artists}
    assert "Boundary Artist" in artist_names
    db.close()


def test_discover_total_streams_threshold_boundary(tmp_path) -> None:
    """Test the 'total_streams > N' condition at boundary.

    With threshold=1500: exactly 1500 should NOT qualify, 1501 should.
    """
    cfg = make_config(tmp_path)
    db = DB(cfg.db.path)
    db.migrate()

    # 1 song with 1500 plays = 1500 total streams — NOT qualifying (need >1500)
    _seed_artist(db, "Stream Artist", [("s1", "BigHit", 1500)])

    discovery = ArtistDiscoveryConfig(
        plays_per_song_threshold=999999,
        songs_over_threshold=999999,
        total_streams_threshold=1500,
        alt_song_count=999999,
        alt_streams_threshold=999999,
    )
    artists = queries.discover_artists(db, discovery)
    assert "Stream Artist" not in {a["artist"] for a in artists}

    # Add 1 more play to push to 1501
    base_ms = int(datetime(2023, 6, 1, tzinfo=timezone.utc).timestamp() * 1000)
    queries.insert_plays(db, [(base_ms, "s1", "spotify:track:s1", None, None, "test")])

    artists = queries.discover_artists(db, discovery)
    assert "Stream Artist" in {a["artist"] for a in artists}
    db.close()


def test_discover_alt_condition_boundary(tmp_path) -> None:
    """Test the alternative condition: song_count > N AND total_streams > M.

    Default: song_count > 60 AND total_streams > 500.
    """
    cfg = make_config(tmp_path)
    db = DB(cfg.db.path)
    db.migrate()

    # 60 songs with 9 plays each = 540 total streams
    # song_count=60 is NOT > 60, so should NOT qualify
    tracks_60 = [(f"a{i}", f"AltSong{i}", 9) for i in range(60)]
    _seed_artist(db, "Alt Artist", tracks_60)

    discovery = ArtistDiscoveryConfig(
        plays_per_song_threshold=999999,
        songs_over_threshold=999999,
        total_streams_threshold=999999,
        alt_song_count=60,
        alt_streams_threshold=500,
    )
    artists = queries.discover_artists(db, discovery)
    assert "Alt Artist" not in {a["artist"] for a in artists}

    # Add 1 more song to push to 61 songs (549 total streams, > 500)
    _seed_artist(db, "Alt Artist", [("a_extra", "AltExtra", 9)])

    artists = queries.discover_artists(db, discovery)
    assert "Alt Artist" in {a["artist"] for a in artists}
    db.close()


def test_discover_custom_thresholds(tmp_path) -> None:
    """Custom (lower) thresholds should discover artists that default thresholds wouldn't."""
    cfg = make_config(tmp_path)
    db = DB(cfg.db.path)
    db.migrate()

    # Small artist: 3 songs with 5 plays each = 15 total streams
    _seed_artist(db, "Small Artist", [
        ("sm1", "Small1", 5),
        ("sm2", "Small2", 5),
        ("sm3", "Small3", 5),
    ])

    # Default thresholds: should NOT qualify
    default_discovery = ArtistDiscoveryConfig()
    artists = queries.discover_artists(db, default_discovery)
    assert "Small Artist" not in {a["artist"] for a in artists}

    # Lowered thresholds: should qualify via total_streams > 10
    custom_discovery = ArtistDiscoveryConfig(
        plays_per_song_threshold=999999,
        songs_over_threshold=999999,
        total_streams_threshold=10,
        alt_song_count=999999,
        alt_streams_threshold=999999,
    )
    artists = queries.discover_artists(db, custom_discovery)
    assert "Small Artist" in {a["artist"] for a in artists}
    db.close()


def test_discover_multi_artist_splitting(tmp_path) -> None:
    """Tracks with multiple artists (comma-separated) should credit each artist."""
    cfg = make_config(tmp_path)
    db = DB(cfg.db.path)
    db.migrate()

    # Single track attributed to "A, B" with 2000 plays
    _seed_artist(db, "A, B", [("collab1", "Collab Hit", 2000)])

    discovery = ArtistDiscoveryConfig(
        plays_per_song_threshold=999999,
        songs_over_threshold=999999,
        total_streams_threshold=1500,
        alt_song_count=999999,
        alt_streams_threshold=999999,
    )
    artists = queries.discover_artists(db, discovery)
    artist_names = {a["artist"] for a in artists}
    # Both A and B should be discovered individually via the recursive CTE split
    assert "A" in artist_names
    assert "B" in artist_names
    db.close()


def test_discover_returns_correct_fields(tmp_path) -> None:
    """Verify the result dict contains the expected fields."""
    cfg = make_config(tmp_path)
    db = DB(cfg.db.path)
    db.migrate()

    _seed_artist(db, "Field Artist", [("f1", "Song1", 2000)])

    discovery = ArtistDiscoveryConfig(total_streams_threshold=100)
    artists = queries.discover_artists(db, discovery)

    found = [a for a in artists if a["artist"] == "Field Artist"]
    assert len(found) == 1
    result = found[0]
    assert "artist" in result
    assert "song_count" in result
    assert "total_streams" in result
    assert "songs_over_threshold" in result
    assert result["song_count"] == 1
    assert result["total_streams"] == 2000
    db.close()
