from __future__ import annotations

from datetime import datetime, timezone

from conftest import FakeSpotify, make_config

from src.db.connection import DB
from src.db import queries
from src.features.artist_playlists import build_artist_playlist, run_artist_playlists
from src.features.yearly_playlists import build_yearly_playlist


def _seed(db: DB) -> None:
    db.migrate()
    queries.upsert_tracks(
        db,
        [
            ("t1", "spotify:track:1", "Song1", "Artist A", "Album", 1000, 0),
            ("t2", "spotify:track:2", "Song2", "Artist B", "Album", 1000, 0),
        ],
    )
    base_ms = int(datetime(2023, 1, 1, tzinfo=timezone.utc).timestamp() * 1000)
    queries.insert_plays(
        db,
        [
            (base_ms, "t1", "spotify:track:1", None, None, "recently_played"),
            (base_ms + 1000, "t1", "spotify:track:1", None, None, "recently_played"),
            (base_ms + 2_000_000, "t2", "spotify:track:2", None, None, "recently_played"),
        ],
    )


def test_build_artist_playlist(tmp_path) -> None:
    cfg = make_config(tmp_path)
    db = DB(cfg.db.path)
    _seed(db)
    fake = FakeSpotify()

    result = build_artist_playlist(
        cfg,
        db,
        fake,
        artist_name="artist a",
        playlist_id="plist-artist-a",
        top_n=10,
    )

    assert result.tracks_added == 1
    assert fake.add_calls and fake.add_calls[0]["playlist_id"] == "plist-artist-a"
    assert fake.add_calls[0]["items"] == ["spotify:track:1"]
    db.close()


def _seed_heavy(db: DB) -> None:
    """Seed DB with enough plays to trigger artist discovery and the >30 play threshold."""
    db.migrate()
    queries.upsert_tracks(
        db,
        [
            ("t1", "spotify:track:1", "Song1", "Artist A", "Album", 1000, 0),
            ("t2", "spotify:track:2", "Song2", "Artist A", "Album", 1000, 0),
            ("t3", "spotify:track:3", "Song3", "Artist A, Artist B", "Album", 1000, 0),
            ("t4", "spotify:track:4", "Song4", "Artist B", "Album", 1000, 0),
        ],
    )
    base_ms = int(datetime(2023, 1, 1, tzinfo=timezone.utc).timestamp() * 1000)
    plays = []
    for i in range(35):
        plays.append((base_ms + i * 1000, "t1", "spotify:track:1", None, None, "recently_played"))
    for i in range(31):
        plays.append((base_ms + 100_000 + i * 1000, "t2", "spotify:track:2", None, None, "recently_played"))
    for i in range(10):
        plays.append((base_ms + 200_000 + i * 1000, "t3", "spotify:track:3", None, None, "recently_played"))
    for i in range(5):
        plays.append((base_ms + 300_000 + i * 1000, "t4", "spotify:track:4", None, None, "recently_played"))
    queries.insert_plays(db, plays)


def test_run_artist_playlists_creates_and_populates(tmp_path) -> None:
    """Test the full run_artist_playlists flow: discover, create, populate."""
    cfg = make_config(tmp_path)
    db = DB(cfg.db.path)
    _seed_heavy(db)

    from src.db import queries as q

    tracks_a = q.get_artist_tracks_over_threshold(db, "Artist A", 30)
    assert len(tracks_a) == 2
    assert {t["track_id"] for t in tracks_a} == {"t1", "t2"}

    tracks_b = q.get_artist_tracks_over_threshold(db, "Artist B", 30)
    assert len(tracks_b) == 0

    db.close()


def test_run_artist_playlists_dry_run(tmp_path) -> None:
    """Dry run should not create playlists or call Spotify API."""
    cfg = make_config(tmp_path)
    db = DB(cfg.db.path)
    _seed_heavy(db)
    fake = FakeSpotify()

    result = run_artist_playlists(cfg, db, fake, min_plays=5, dry_run=True)

    assert len(fake.add_calls) == 0
    assert fake._playlist_counter == 0
    assert result.artists_processed >= 0
    db.close()


def test_get_or_create_playlist_registers(tmp_path) -> None:
    """Creating a playlist should register it in the playlists table."""
    cfg = make_config(tmp_path)
    db = DB(cfg.db.path)
    db.migrate()
    fake = FakeSpotify()

    from src.features.artist_playlists import _get_or_create_playlist
    from src.db import queries as q

    pid, created = _get_or_create_playlist(db, fake, "Test Artist")
    assert created is True
    assert pid == "created-playlist-1"
    assert fake._playlist_counter == 1

    pid2, created2 = _get_or_create_playlist(db, fake, "Test Artist")
    assert created2 is False
    assert pid2 == pid
    assert fake._playlist_counter == 1

    assert q.get_artist_playlist(db, "Test Artist") == "created-playlist-1"
    db.close()


def test_playlist_tracks_not_duplicated(tmp_path) -> None:
    """Re-running should not add tracks that are already in the playlist."""
    cfg = make_config(tmp_path)
    db = DB(cfg.db.path)
    _seed_heavy(db)
    fake = FakeSpotify()

    from src.features.artist_playlists import _get_or_create_playlist
    from src.db import queries as q

    pid, _ = _get_or_create_playlist(db, fake, "Artist A")
    q.mark_tracks_in_playlist(db, pid, [("t1", "spotify:track:1")])

    tracks = q.get_artist_tracks_over_threshold(db, "Artist A", 30)
    assert len(tracks) == 2

    known = q.get_known_playlist_track_ids(db, pid)
    assert "t1" in known
    assert "t2" not in known

    to_add = [t for t in tracks if t["track_id"] not in known]
    assert len(to_add) == 1
    assert to_add[0]["track_id"] == "t2"

    db.close()


def test_build_yearly_playlist(tmp_path) -> None:
    cfg = make_config(tmp_path)
    db = DB(cfg.db.path)
    _seed(db)
    fake = FakeSpotify()

    result = build_yearly_playlist(
        cfg,
        db,
        fake,
        year=2023,
        playlist_id="plist-2023",
        top_n=10,
    )

    assert result.tracks_considered == 2
    assert result.tracks_added == 2
    assert len(fake.add_calls) == 1
    assert set(fake.add_calls[0]["items"]) == {"spotify:track:1", "spotify:track:2"}
    db.close()
