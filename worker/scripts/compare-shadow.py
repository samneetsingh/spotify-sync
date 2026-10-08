"""Phase 6 gate check: compare the shadow Worker (staging D1) with the Python server.

Usage (from worker/, after pulling a fresh server DB at the end of the shadow run):
    python3 -I scripts/compare-shadow.py <server.sqlite> <shadow-start-utc, e.g. 2026-10-09T00:00:00Z> [d1-name]

Checks PLAN.md Phase 6 gate items:
  1. Worker fired every 10 min (gaps in staging sync_runs; daily job runs in worker_actions/logs)
  2. plays in the window match (both read the same recently-played feed)
  3. playlist_tracks deltas per playlist match
  4. Worker would-do writes match what Python actually added
  5. no failed Worker syncs
"""
from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone

SERVER, START = sys.argv[1], sys.argv[2]
D1 = sys.argv[3] if len(sys.argv) > 3 else "spotify-automation-staging"
start_dt = datetime.fromisoformat(START.replace("Z", "+00:00")).astimezone(timezone.utc)
START_MS = int(start_dt.timestamp() * 1000)
START_SQL = start_dt.strftime("%Y-%m-%d %H:%M:%S")
LIKED = "__liked__"

srv = sqlite3.connect(f"file:{SERVER}?mode=ro", uri=True)
failures: list[str] = []


def d1(sql: str) -> list[dict]:
    out = subprocess.run(["npx", "wrangler", "d1", "execute", D1, "--remote", "--json", "--command", sql],
                         capture_output=True, text=True, check=True).stdout
    data = json.loads(out)
    if isinstance(data, dict):
        raise SystemExit(f"D1 error: {out[:500]}")
    return data[0]["results"]


def srv_rows(sql: str, *params) -> list[tuple]:
    return srv.execute(sql, params).fetchall()


def report(name: str, ok: bool, detail: str) -> None:
    print(f"[{'PASS' if ok else 'FAIL'}] {name}: {detail}")
    if not ok:
        failures.append(name)


# 1. Cron coverage: consecutive Worker sync starts should be ~10 min apart.
runs = d1(f"SELECT started_at, status, error FROM sync_runs WHERE started_at >= '{START_SQL}' ORDER BY id")
times = [datetime.fromisoformat(r["started_at"]) for r in runs]
gaps = [(a, b) for a, b in zip(times, times[1:]) if (b - a).total_seconds() > 15 * 60]
hours = (times[-1] - times[0]).total_seconds() / 3600 if len(times) > 1 else 0
report("sync fired every cycle", bool(runs) and not gaps,
       f"{len(runs)} runs over {hours:.1f} h (expected ~{int(hours * 6) + 1}); gaps > 15 min: {[(str(a), str(b)) for a, b in gaps[:5]]}")
daily = d1(f"SELECT job, COUNT(*) AS n, MIN(created_at) AS first, MAX(created_at) AS last FROM worker_actions WHERE created_at >= '{START_SQL}' GROUP BY job")
print(f"       worker_actions by job: {daily} (daily jobs only appear when they would write; check Workers Logs for their run lines)")

# 5. Failed syncs.
fails = [r for r in runs if r["status"] != "success"]
report("no failed Worker syncs", not fails, f"{len(fails)} failed: {[r['error'][:120] for r in fails[:5]]}")

# 2. Plays in the window. Ignore the last 20 min, which one side may not have fetched yet.
end_ms = min(int(d1("SELECT MAX(played_at_ms) AS m FROM plays")[0]["m"] or 0),
             int(srv_rows("SELECT MAX(played_at_ms) FROM plays")[0][0] or 0)) - 20 * 60 * 1000
w_plays = {(r["played_at_ms"], r["track_id"]) for r in d1(f"SELECT played_at_ms, track_id FROM plays WHERE played_at_ms >= {START_MS} AND played_at_ms <= {end_ms}")}
s_plays = set(srv_rows("SELECT played_at_ms, track_id FROM plays WHERE played_at_ms >= ? AND played_at_ms <= ?", START_MS, end_ms))
report("plays match", w_plays == s_plays,
       f"worker={len(w_plays)} server={len(s_plays)} only_worker={len(w_plays - s_plays)} only_server={len(s_plays - w_plays)}")

# 3. playlist_tracks rows first added during the window, per playlist. Shadow-created
#    artist playlists have placeholder ids; map them to the server's id by artist name.
srv_artist_ids = {a: p for p, a in srv_rows("SELECT playlist_id, artist_name FROM playlists WHERE playlist_type='artist'")}
placeholder = {r["playlist_id"]: srv_artist_ids.get(r["artist_name"], r["playlist_id"])
               for r in d1("SELECT playlist_id, artist_name FROM playlists WHERE playlist_id LIKE 'would-create:%'")}
w_new = {(placeholder.get(r["playlist_id"], r["playlist_id"]), r["track_id"])
         for r in d1(f"SELECT playlist_id, track_id FROM playlist_tracks WHERE first_added_at >= '{START_SQL}'")}
s_new = set(srv_rows("SELECT playlist_id, track_id FROM playlist_tracks WHERE first_added_at >= ?", START_SQL))
for pid in sorted({p for p, _ in w_new | s_new}):
    w = {t for p, t in w_new if p == pid}
    s = {t for p, t in s_new if p == pid}
    report(f"playlist_tracks delta {pid}", w == s, f"worker={len(w)} server={len(s)} only_worker={sorted(w - s)[:5]} only_server={sorted(s - w)[:5]}")

# 4. Would-do writes vs what Python added (Liked Songs by track id, playlists by uri).
acts = d1(f"SELECT action, target, items FROM worker_actions WHERE executed = 0 AND created_at >= '{START_SQL}'")
would_liked = {i for a in acts if a["action"] == "addToLikedSongs" for i in json.loads(a["items"])}
srv_liked = {t for (t,) in srv_rows("SELECT track_id FROM playlist_tracks WHERE playlist_id = ? AND first_added_at >= ?", LIKED, START_SQL)}
report("would-do Liked Songs adds = Python's", would_liked == srv_liked,
       f"worker={len(would_liked)} server={len(srv_liked)} only_worker={sorted(would_liked - srv_liked)[:5]} only_server={sorted(srv_liked - would_liked)[:5]}")
srv_added_uris: dict[str, set[str]] = {}
for p, u in srv_rows("SELECT playlist_id, track_uri FROM playlist_tracks WHERE playlist_id != ? AND first_added_at >= ?", LIKED, START_SQL):
    srv_added_uris.setdefault(p, set()).add(u)
would_by_pl: dict[str, set[str]] = {}
for a in acts:
    if a["action"] == "addToPlaylist":
        would_by_pl.setdefault(placeholder.get(a["target"], a["target"]), set()).update(json.loads(a["items"]))
for pid in sorted(would_by_pl):
    w, s = would_by_pl[pid], srv_added_uris.get(pid, set())
    # Server deltas also include tracks found by cache refreshes; only Worker extras are suspicious.
    report(f"would-do adds {pid} were also added by Python", w <= s, f"worker={len(w)} only_worker={sorted(w - s)[:5]}")
creates = [a for a in acts if a["action"] in ("createPlaylist", "unfollowPlaylist")]
print(f"       would-do creates/unfollows: {[(a['action'], a['target'], a['items']) for a in creates]}")

# Cursor proximity.
w_cur = d1("SELECT value FROM state WHERE key LIKE 'cursor_after_ms:%'")
s_cur = srv_rows("SELECT value FROM state WHERE key LIKE 'cursor_after_ms:%'")
if w_cur and s_cur:
    diff_min = abs(int(w_cur[0]["value"]) - int(s_cur[0][0])) / 60000
    print(f"       cursor difference: {diff_min:.1f} min (expect within 1-2 sync cycles of listening)")

print(f"\n{'GATE PASSED' if not failures else 'GATE FAILED: ' + ', '.join(failures)}")
sys.exit(1 if failures else 0)
