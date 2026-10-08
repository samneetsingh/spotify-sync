"""Generate parity fixtures from the real Python implementation.

For each family (sync, artist), writes test/parity/<family>-scenarios.json (inputs)
and <family>-golden.json (what the Python job did: Spotify calls + resulting rows).
The *-parity.test.ts files replay the same scenarios through the Worker.

Run from the repo root:  poetry run python worker/test/parity/generate_golden.py
"""
from __future__ import annotations

import json
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[2]))

from spotipy.exceptions import SpotifyException  # noqa: E402

from src.config import AppConfig, ArtistDiscoveryConfig, DbConfig, SpotifyConfig  # noqa: E402
from src.db.connection import DB  # noqa: E402
from src.features.artist_playlists import run_artist_playlists  # noqa: E402
from src.features.hindi_favorites import build_hindi_favorites  # noqa: E402
from src.ingestion.sync_recent import sync_all_tracks, sync_recent  # noqa: E402

ALL = "all1"
FREQ = "freq1"

# Shared by both harnesses. Timestamps and Python/TS-specific columns are excluded.
DUMP_QUERIES = {
    "tracks": "SELECT track_id, track_uri, name, artists, album, duration_ms, explicit, popularity, release_date, isrc FROM tracks ORDER BY track_id",
    "plays": "SELECT played_at_ms, track_id, track_uri, context_type, context_uri, source FROM plays ORDER BY played_at_ms, track_id",
    "track_artists": "SELECT track_id, artist_id, artist_name, position FROM track_artists ORDER BY track_id, artist_id",
    "artists": "SELECT artist_id, name, genres, popularity, followers FROM artists ORDER BY artist_id",
    "playlist_tracks": "SELECT playlist_id, track_id, track_uri FROM playlist_tracks ORDER BY playlist_id, track_id",
    "state": "SELECT key, CASE WHEN key LIKE 'playlist_cache_refreshed_ms:%' THEN 'set' ELSE value END AS value FROM state WHERE key != 'spotify_refresh_token' ORDER BY key",
    "sync_runs": "SELECT cursor_in_ms, cursor_out_ms, plays_fetched, tracks_added, status, error IS NOT NULL AS has_error FROM sync_runs ORDER BY id",
    "playlists": "SELECT playlist_id, name, artist_name, playlist_type FROM playlists ORDER BY playlist_id",
    "playlist_removals": "SELECT playlist_id, track_id, track_uri FROM playlist_removals ORDER BY playlist_id, track_id",
    "playlist_exclusions": "SELECT artist_name, playlist_id FROM playlist_exclusions ORDER BY artist_name",
}

ARTIST_DISCOVERY_DEFAULTS = {"plays_per_song_threshold": 20, "songs_over_threshold": 15, "total_streams_threshold": 1500, "alt_song_count": 60, "alt_streams_threshold": 500, "min_plays_per_track": 30, "max_tracks_per_playlist": 50, "min_tracks_per_playlist": 10}
FRESH_CACHE = {f"playlist_cache_refreshed_ms:{FREQ}": 3_600_000}  # refreshed 1h ago
CURSOR = {f"cursor_after_ms:{ALL}": "1000"}


def scenario(name, *, job="sync", config=None, seed=None, spotify=None, runs=1):
    return {
        "name": name,
        "job": job,
        "runs": runs,
        "config": {"all_playlist_id": ALL, "frequent_playlist_id": FREQ, "frequent_min_plays": 2, "recently_played_limit": 50, "artist_discovery": ARTIST_DISCOVERY_DEFAULTS, "hindi_favorites_playlist_id": None, "hindi_favorites_min_plays": 5, **(config or {})},
        "seed": {"tracks": [], "plays": [], "playlist_tracks": [], "artists": [], "track_artists": [], "playlists": [], "playlist_removals": [], "playlist_exclusions": [], "state": dict(CURSOR), "state_age_ms": dict(FRESH_CACHE), **(seed or {})},
        "spotify": {"tracks": {}, "recently_played": {"default": []}, "playlist_items": {}, "playlist_total": {}, "artists": {}, "recently_played_error": False, "missing_playlists": [], **(spotify or {})},
    }


ARTISTS = {
    "a1": {"name": "Artist One", "genres": ["bollywood", "filmi"], "popularity": 60, "followers": 1000},
    "a2": {"name": "Tyler, the Creator", "genres": [], "popularity": 10, "followers": 5},
    "a4": {"name": "Música", "genres": ["música mexicana", "j-pop 🎵"], "popularity": 30, "followers": 42},
}
TRACKS = {
    "t1": {"name": "Song One", "artists": [["a1", "Artist One"]], "album": "Alb", "release_date": "2020-01-01", "explicit": True, "popularity": 50, "isrc": "US1", "duration_ms": 1000},
    "t2": {"name": "Song Two", "artists": [["a1", "Artist One"], ["a2", "Tyler, the Creator"]], "album": "Alb2", "release_date": "2021", "explicit": False, "popularity": 0, "isrc": None, "duration_ms": 2000},
    "t3": {"name": "Song Three", "artists": [["a3", "Known Artist"]], "album": None, "explicit": None},
    "t4": {"name": "Canción", "artists": [["a4", "Música"], ["a5", "Missing From API"]], "album": "Álbum"},
}


def iso(minute: int) -> str:
    return f"2024-01-01T00:{minute:02d}:00Z"


SYNC_SCENARIOS = [
    scenario(
        "basic",
        runs=2,
        seed={"tracks": [["t1", "Old Name", "Artist One"]], "plays": [[1, "t1"]], "artists": [["a3", "Known Artist", '["pop"]']]},
        spotify={
            "tracks": TRACKS,
            "artists": ARTISTS,
            "recently_played": {"default": [[iso(10), "t2", "playlist", "spotify:playlist:ctx"], [iso(5), "t1", "album", "spotify:album:x"], [iso(3), "t3"], [iso(1), "t2"], [iso(0), "t4"]]},
            "playlist_total": {FREQ: 50},
        },
    ),
    scenario(
        "already_cached",
        seed={"tracks": [["t1", "Song One", "Artist One"]], "plays": [[1, "t1"]], "playlist_tracks": [["__liked__", "t1"], [FREQ, "t1"]], "artists": [["a1", "Artist One", None]]},
        spotify={"tracks": TRACKS, "recently_played": {"default": [[iso(5), "t1"]]}},
    ),
    scenario(
        "paginate",
        config={"recently_played_limit": 1},
        seed={"state": {f"cursor_after_ms:{ALL}": "0"}},
        spotify={"recently_played": {"by_after": {"0": [[iso(0), "p1"]], "1704067200000": [[iso(5), "p2"]]}}},
    ),
    scenario(
        "liked_batches",
        config={"frequent_playlist_id": None},
        seed={"state": dict(CURSOR), "state_age_ms": {}},
        spotify={"recently_played": {"default": [[f"2024-01-01T{i // 60:02d}:{i % 60:02d}:00Z", f"b{i:03d}"] for i in range(120)]}},
    ),
    scenario(
        "invalid_items",
        spotify={"recently_played": {"default": [
            [iso(0), "v1"],
            {"played_at": iso(1), "track": {"id": None, "uri": "spotify:track:x", "name": "NoId"}, "context": {}},
            {"played_at": iso(2), "track": {"id": "v3", "uri": None, "name": "NoUri"}, "context": {}},
            {"played_at": iso(3), "track": None, "context": {}},
            {"played_at": None, "track": {"id": "v5", "uri": "spotify:track:v5"}, "context": {}},
        ]}},
    ),
    scenario("empty_items", spotify={"recently_played": {"default": []}}),
    scenario("no_items_key", spotify={"recently_played": {"default": {}}}),
    scenario(
        "capacity_truncate",
        seed={"tracks": [["c1", "C1", "A"], ["c2", "C2", "A"], ["c3", "C3", "A"]], "plays": [[1, "c1"], [2, "c1"], [3, "c2"], [4, "c2"], [5, "c3"]]},
        spotify={"recently_played": {"default": [[iso(0), "c1"], [iso(1), "c2"], [iso(2), "c3"]]}, "playlist_total": {FREQ: 9999}},
    ),
    scenario(
        "capacity_full",
        seed={"tracks": [["c1", "C1", "A"]], "plays": [[1, "c1"]]},
        spotify={"recently_played": {"default": [[iso(0), "c1"]]}, "playlist_total": {FREQ: 10000}},
    ),
    scenario(
        "cache_refresh",
        seed={"state_age_ms": {}, "tracks": [["r1", "R1", "A"]], "plays": [[1, "r1"]]},
        spotify={
            "tracks": TRACKS,
            "artists": ARTISTS,
            "playlist_items": {FREQ: ["r1", "t1"] + [f"f{i:03d}" for i in range(230)] + ["t1"]},
            "recently_played": {"default": [[iso(0), "r1"], [iso(1), "t2"], [iso(2), "t2"]]},
            "playlist_total": {FREQ: 233},
        },
    ),
    scenario(
        "cache_stale",
        seed={"state_age_ms": {f"playlist_cache_refreshed_ms:{FREQ}": 25 * 3_600_000}},
        spotify={"playlist_items": {FREQ: ["s1"]}, "recently_played": {"default": [[iso(0), "s2"]]}},
    ),
    scenario("failure", spotify={"recently_played_error": True}),
    scenario(
        "min_plays_5",
        config={"frequent_min_plays": 5},
        seed={"tracks": [["m1", "M1", "A"], ["m2", "M2", "A"]], "plays": [[i, "m1"] for i in range(1, 5)] + [[i, "m2"] for i in range(10, 13)]},
        spotify={"recently_played": {"default": [[iso(0), "m1"], [iso(1), "m2"]]}},
    ),
    scenario(
        "sync_full",
        job="sync_full",
        seed={
            "tracks": [["u5", "U5", "A"], ["u1", "U1", "A"], ["u2", "U2", "A"], ["u3", "U3", "A"], ["u4", "U4", "A"]],
            "plays": [[i, "u1"] for i in range(1, 6)] + [[10, "u2"], [11, "u2"], [12, "u3"], [20, "u4"], [21, "u4"], [22, "u4"]],
            "playlist_tracks": [["__liked__", "u1"], [FREQ, "u2"]],
        },
        spotify={"playlist_total": {FREQ: 10}},
    ),
    scenario(
        "sync_full_no_frequent",
        job="sync_full",
        config={"frequent_playlist_id": None},
        seed={"tracks": [["u1", "U1", "A"], ["u2", "U2", "A"]], "playlist_tracks": [["__liked__", "u2"]]},
    ),
    scenario("sync_full_nothing_missing", job="sync_full", seed={"tracks": [["u1", "U1", "A"]], "playlist_tracks": [["__liked__", "u1"]]}),
]

# --- artist playlists ---------------------------------------------------------
# Small thresholds: an artist qualifies with >= 2 songs of >= 2 plays; a track
# qualifies for its playlist with >= 3 plays; playlists need >= 3 tracks.
SMALL_DISCOVERY = {"plays_per_song_threshold": 1, "songs_over_threshold": 1, "total_streams_threshold": 100000, "alt_song_count": 1000, "alt_streams_threshold": 100000, "min_plays_per_track": 2, "max_tracks_per_playlist": 50, "min_tracks_per_playlist": 3}


class ArtistSeed:
    """Builds seed rows; every play gets a unique timestamp so orderings never tie."""

    def __init__(self) -> None:
        self.seed = {"tracks": [], "plays": [], "track_artists": [], "playlists": [], "playlist_tracks": [], "playlist_removals": [], "playlist_exclusions": []}
        self.ms = 1000

    def artist(self, name: str, aid: str, tracks: list[tuple[str, int]]) -> "ArtistSeed":
        for tid, plays in tracks:
            self.seed["tracks"].append([tid, f"{name} {tid}", name])
            self.seed["track_artists"].append([tid, aid, name, 0])
            for _ in range(plays):
                self.ms += 1
                self.seed["plays"].append([self.ms, tid])
        return self

    def playlist(self, pid: str, artist: str, members: list[str]) -> "ArtistSeed":
        self.seed["playlists"].append([pid, artist, artist])
        self.seed["playlist_tracks"].extend([pid, t] for t in members)
        return self

    def credit(self, tid: str, aid: str, name: str, position: int) -> "ArtistSeed":
        self.seed["track_artists"].append([tid, aid, name, position])
        return self

    def genres(self, aid: str, name: str, genres: str | None) -> "ArtistSeed":
        self.seed.setdefault("artists", []).append([aid, name, genres])
        return self

    def track(self, tid: str) -> "ArtistSeed":
        self.seed["tracks"].append([tid, f"Other {tid}", "Someone Else"])
        return self


def artist_scenario(name, seed: ArtistSeed, spotify=None, discovery=None):
    return scenario(name, job="artist_playlists", config={"artist_discovery": {**SMALL_DISCOVERY, **(discovery or {})}}, seed=seed.seed, spotify=spotify)


ARTIST_SCENARIOS = [
    artist_scenario("create_new", ArtistSeed().artist("Alpha Band", "al", [("a1", 5), ("a2", 4), ("a3", 3), ("a4", 1)])),
    artist_scenario(
        "reconcile_existing",
        ArtistSeed().artist("Beta Band", "be", [("b1", 6), ("b2", 5), ("bx", 4), ("b3", 3)]).track("bm").playlist("pl_beta", "Beta Band", ["b1", "b2", "bx"]),
        spotify={"playlist_items": {"pl_beta": ["b1", "b2", "bm"]}},
    ),
    artist_scenario(
        "manual_add_unknown_track",
        ArtistSeed().artist("Beta Band", "be", [("b1", 6), ("b2", 5), ("b3", 3)]).playlist("pl_beta", "Beta Band", ["b1", "b2", "b3"]),
        spotify={"playlist_items": {"pl_beta": ["b1", "b2", "b3", "never_played"]}},
    ),
    artist_scenario(
        "deleted_by_user",
        ArtistSeed().artist("Gamma Band", "ga", [("g1", 5), ("g2", 4), ("g3", 3)]).playlist("pl_gamma", "Gamma Band", ["g1"]),
        spotify={"missing_playlists": ["pl_gamma"]},
    ),
    artist_scenario(
        "excluded_artist",
        (lambda s: (s.seed["playlist_exclusions"].append(["Delta Band", "pl_old"]), s)[1])(ArtistSeed().artist("Delta Band", "de", [("d1", 5), ("d2", 4), ("d3", 3)])),
    ),
    artist_scenario("below_min_tracks", ArtistSeed().artist("Epsilon Band", "ep", [("e1", 5), ("e2", 4), ("e3", 2)])),
    artist_scenario(
        "prune_small",
        ArtistSeed().artist("Eta Band", "et", [("h1", 5), ("h2", 4), ("h3", 3)]).track("z1").playlist("pl_eta", "Eta Band", ["h1", "h2", "h3"]).playlist("pl_zeta", "Zeta Band", ["z1"]),
        spotify={"playlist_items": {"pl_eta": ["h1", "h2", "h3"]}},
    ),
    artist_scenario("multi_batch_add", ArtistSeed().artist("Theta Band", "th", [(f"t{i:03d}", 3) for i in range(150)] + [("t_hot", 9)])),
    artist_scenario(
        "mixed_run",
        ArtistSeed()
        .artist("Alpha Band", "al", [("a1", 9), ("a2", 8), ("a3", 7)])
        .artist("Beta Band", "be", [("b1", 6), ("b2", 6), ("b3", 5), ("b4", 4)])
        .artist("Gamma Band", "ga", [("g1", 4), ("g2", 3), ("g3", 3)])
        .track("z1")
        .playlist("pl_beta", "Beta Band", ["b1"])
        .playlist("pl_gamma", "Gamma Band", ["g1", "g2"])
        .playlist("pl_zeta", "Zeta Band", ["z1"]),
        spotify={"playlist_items": {"pl_beta": ["b1", "b2"]}, "missing_playlists": ["pl_gamma"]},
    ),
    artist_scenario(
        "nothing_to_do",
        ArtistSeed().artist("Iota Band", "io", [("i1", 5), ("i2", 4), ("i3", 3)]).playlist("pl_iota", "Iota Band", ["i1", "i2", "i3"]),
        spotify={"playlist_items": {"pl_iota": ["i1", "i2", "i3"]}},
    ),
]

# --- hindi favorites ------------------------------------------------------------
HINDI = "hindi1"


def hindi_scenario(name, seed: ArtistSeed, spotify=None):
    return scenario(name, job="hindi_favorites", config={"hindi_favorites_playlist_id": HINDI, "hindi_favorites_min_plays": 5}, seed=seed.seed, spotify=spotify)


def hindi_base() -> ArtistSeed:
    return (ArtistSeed()
            .genres("bol", "Bolly Singer", '["bollywood", "filmi"]').genres("pop", "Pop Star", '["pop"]')
            .genres("hin", "Hindi Singer", '["hindi"]').genres("des", "Desi Rapper", '["desi hip hop"]'))


HINDI_SCENARIOS = [
    hindi_scenario(
        "basic",
        hindi_base()
        .artist("Bolly Singer", "bol", [("h1", 7), ("h4", 4), ("h6", 5)])
        .artist("Pop Star", "pop", [("h2", 6), ("h3", 9)]).credit("h2", "hin", "Hindi Singer", 1)
        .artist("Desi Rapper", "des", [("h5", 8)]),
        spotify={"playlist_items": {HINDI: ["h6"]}},
    ),
    hindi_scenario(
        "nothing_new",
        hindi_base().artist("Bolly Singer", "bol", [("h1", 7), ("h6", 5)]),
        spotify={"playlist_items": {HINDI: ["h1", "h6"]}},
    ),
    hindi_scenario(
        "unknown_and_null_genres",
        hindi_base().genres("nul", "No Genres", None).artist("No Genres", "nul", [("n1", 9)]).artist("Unenriched", "unk", [("u1", 9)]),
    ),
    hindi_scenario(
        "double_count_quirk",
        hindi_base().artist("Bolly Singer", "bol", [("q1", 3)]).credit("q1", "hin", "Hindi Singer", 1),
    ),
    hindi_scenario(
        "backfill_unknown_track",
        hindi_base().artist("Bolly Singer", "bol", [("h1", 7)]),
        spotify={"tracks": TRACKS, "playlist_items": {HINDI: ["x_new", "t1"]}},
    ),
    hindi_scenario("batches", hindi_base().artist("Bolly Singer", "bol", [(f"k{i:03d}", 5 + i) for i in range(105)])),
]


def track_obj(spotify: dict, track_id: str) -> dict:
    spec = spotify["tracks"].get(track_id)
    if spec is None:
        return {"id": track_id, "uri": f"spotify:track:{track_id}", "name": f"Track {track_id}", "artists": [], "album": {"name": "Album"}, "duration_ms": 1000, "explicit": False}
    return {
        "id": track_id,
        "uri": f"spotify:track:{track_id}",
        "name": spec.get("name"),
        "artists": [{"id": a[0], "name": a[1]} for a in spec.get("artists", [])],
        "album": {"name": spec.get("album"), "release_date": spec.get("release_date")},
        "duration_ms": spec.get("duration_ms"),
        "explicit": spec.get("explicit"),
        "popularity": spec.get("popularity"),
        "external_ids": {"isrc": spec.get("isrc")},
    }


def recent_response(spotify: dict, entries) -> dict:
    if isinstance(entries, dict):
        return entries
    items = []
    for e in entries:
        if isinstance(e, dict):
            items.append(e)
        else:
            items.append({"played_at": e[0], "track": track_obj(spotify, e[1]), "context": {"type": e[2] if len(e) > 2 else None, "uri": e[3] if len(e) > 3 else None}})
    return {"items": items}


class RecordingSpotify:
    def __init__(self, spotify: dict) -> None:
        self.s = spotify
        self.calls: list[dict] = []

    def current_user_recently_played(self, *, limit: int, after: int) -> dict:
        self.calls.append({"op": "recently_played", "limit": limit, "after": after})
        if self.s["recently_played_error"]:
            raise RuntimeError("boom")
        rp = self.s["recently_played"]
        if "by_after" in rp:
            return recent_response(self.s, rp["by_after"].get(str(after), []))
        return recent_response(self.s, rp["default"])

    def playlist(self, playlist_id: str, fields: str | None = None) -> dict:
        self.calls.append({"op": "playlist_total", "playlist_id": playlist_id})
        return {"tracks": {"total": self.s["playlist_total"].get(playlist_id, 0)}}

    def playlist_items(self, playlist_id: str, limit: int = 100, offset: int = 0, fields: str | None = None) -> dict:
        self.calls.append({"op": "playlist_items", "playlist_id": playlist_id, "limit": limit, "offset": offset})
        if playlist_id in self.s["missing_playlists"]:
            raise SpotifyException(404, -1, "Not found")
        ids = self.s["playlist_items"].get(playlist_id, [])
        page = ids[offset:offset + limit]
        return {"items": [{"track": track_obj(self.s, t)} for t in page], "next": "more" if offset + limit < len(ids) else None}

    def artists(self, artists: list[str]) -> dict:
        self.calls.append({"op": "artists", "ids": sorted(artists)})
        out = []
        for aid in artists:
            spec = self.s["artists"].get(aid)
            out.append(None if spec is None else {"id": aid, "name": spec["name"], "genres": spec["genres"], "popularity": spec["popularity"], "followers": {"total": spec["followers"]}})
        return {"artists": out}

    def current_user_saved_tracks_add(self, tracks: list[str]) -> dict:
        self.calls.append({"op": "liked_add", "ids": list(tracks)})
        return {}

    def playlist_add_items(self, playlist_id: str, items: list[str]) -> dict:
        self.calls.append({"op": "playlist_add", "playlist_id": playlist_id, "uris": list(items)})
        return {}

    def me(self) -> dict:
        return {"id": "testuser"}  # Worker uses POST /me/playlists instead; not recorded

    def user_playlist_create(self, user: str, name: str, public: bool = False, description: str = "") -> dict:
        self.calls.append({"op": "create_playlist", "name": name, "public": public, "description": description})
        self.created = getattr(self, "created", 0) + 1
        return {"id": f"created-{self.created}"}

    def current_user_unfollow_playlist(self, playlist_id: str) -> dict:
        self.calls.append({"op": "unfollow", "playlist_id": playlist_id})
        return {}


def build_config(db_path: str, c: dict) -> AppConfig:
    return AppConfig(
        db=DbConfig(path=db_path),
        spotify=SpotifyConfig(
            client_id="id", client_secret="secret", redirect_uri="https://example.com/callback", scope="",
            all_playlist_id=c["all_playlist_id"], frequent_playlist_id=c["frequent_playlist_id"],
            frequent_min_plays=c["frequent_min_plays"], hindi_favorites_playlist_id=c["hindi_favorites_playlist_id"], hindi_favorites_min_plays=c["hindi_favorites_min_plays"],
            like_batch_size=50, cache_path="unused",
        ),
        recently_played_limit=c["recently_played_limit"],
        like_batch_size=50,
        artist_discovery=ArtistDiscoveryConfig(**c["artist_discovery"]),
    )


def seed_db(db: DB, seed: dict) -> None:
    now = int(time.time() * 1000)
    db.executemany("INSERT INTO tracks(track_id, track_uri, name, artists, album, duration_ms, explicit) VALUES(?, 'spotify:track:' || ?, ?, ?, 'Album', 1000, 0)",
                   [(t[0], t[0], t[1], t[2]) for t in seed["tracks"]])
    db.executemany("INSERT INTO plays(played_at_ms, track_id, track_uri, source) VALUES(?, ?, 'spotify:track:' || ?, 'history_import')",
                   [(p[0], p[1], p[1]) for p in seed["plays"]])
    db.executemany("INSERT INTO playlist_tracks(playlist_id, track_id, track_uri) VALUES(?, ?, 'spotify:track:' || ?)",
                   [(p[0], p[1], p[1]) for p in seed["playlist_tracks"]])
    db.executemany("INSERT INTO artists(artist_id, name, genres) VALUES(?, ?, ?)", [tuple(a) for a in seed["artists"]])
    db.executemany("INSERT INTO track_artists(track_id, artist_id, artist_name, position) VALUES(?, ?, ?, ?)", [tuple(a) for a in seed["track_artists"]])
    db.executemany("INSERT INTO playlists(playlist_id, name, artist_name, playlist_type) VALUES(?, ?, ?, 'artist')", [tuple(p) for p in seed["playlists"]])
    db.executemany("INSERT INTO playlist_removals(playlist_id, track_id, track_uri) VALUES(?, ?, 'spotify:track:' || ?)", [(p[0], p[1], p[1]) for p in seed["playlist_removals"]])
    db.executemany("INSERT INTO playlist_exclusions(artist_name, playlist_id) VALUES(?, ?)", [tuple(p) for p in seed["playlist_exclusions"]])
    state = dict(seed["state"]) | {k: str(now - age) for k, age in seed["state_age_ms"].items()}
    db.executemany("INSERT INTO state(key, value) VALUES(?, ?)", list(state.items()))


def run(sc: dict) -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        cfg = build_config(str(Path(tmp) / "db.sqlite"), sc["config"])
        db = DB(cfg.db.path)
        db.migrate()
        seed_db(db, sc["seed"])
        sp = RecordingSpotify(sc["spotify"])
        results = []
        for _ in range(sc["runs"]):
            try:
                if sc["job"] == "hindi_favorites":
                    r = build_hindi_favorites(cfg, db, sp)
                    results.append({"tracks_added": r.tracks_added, "tracks_considered": r.tracks_considered})
                elif sc["job"] == "artist_playlists":
                    r = run_artist_playlists(cfg, db, sp)
                    results.append({"artists_processed": r.artists_processed, "playlists_created": r.playlists_created, "total_tracks_added": r.total_tracks_added, "pruned": len(r.pruned)})
                elif sc["job"] == "sync":
                    r = sync_recent(cfg, db, sp)
                    results.append({"plays_fetched": r.plays_fetched, "liked_added": r.liked_added, "frequent_added": r.frequent_added, "cursor_in_ms": r.cursor_in_ms, "cursor_out_ms": r.cursor_out_ms})
                else:
                    results.append({"total_added": sync_all_tracks(cfg, db, sp)})
            except Exception as exc:  # noqa: BLE001
                results.append({"error": True})
                print(f"  {sc['name']}: Python raised {type(exc).__name__}: {exc}")
        tables = {name: [dict(r) for r in db.fetchall(q)] for name, q in DUMP_QUERIES.items()}
        db.close()
        return {"results": results, "calls": sp.calls, "tables": tables}


def dumps(o, level: int = 0) -> str:
    """JSON with one line per row: containers holding only scalars are written compactly."""
    scalar = lambda v: not isinstance(v, (dict, list))
    if scalar(o) or (isinstance(o, dict) and all(map(scalar, o.values()))) or (isinstance(o, list) and all(map(scalar, o))):
        return json.dumps(o, ensure_ascii=False)
    pad, inner = " " * level, " " * (level + 1)
    if isinstance(o, dict):
        body = ",\n".join(f"{inner}{json.dumps(k)}: {dumps(v, level + 1)}" for k, v in o.items())
        return "{\n" + body + "\n" + pad + "}" if o else "{}"
    body = ",\n".join(inner + dumps(v, level + 1) for v in o)
    return "[\n" + body + "\n" + pad + "]" if o else "[]"


def main() -> None:
    for family, scenarios in (("sync", SYNC_SCENARIOS), ("artist", ARTIST_SCENARIOS), ("hindi", HINDI_SCENARIOS)):
        names = [s["name"] for s in scenarios]
        assert len(names) == len(set(names)), f"duplicate {family} scenario names"
        (HERE / f"{family}-scenarios.json").write_text(dumps({"dump_queries": DUMP_QUERIES, "scenarios": scenarios}) + "\n")
        golden = {s["name"]: run(s) for s in scenarios}
        (HERE / f"{family}-golden.json").write_text(dumps(golden) + "\n")
        print(f"{family}: wrote {len(scenarios)} scenarios")


if __name__ == "__main__":
    main()
