"""Seed the Spotify refresh token into a D1 database's state table without printing it.

Usage (from worker/): python3 -I scripts/seed-token.py <d1-database-name>
Reads ../data/.spotify_token_cache.json (written by `poetry run token fetch`).
"""
import json
import re
import subprocess
import sys

d1 = sys.argv[1]
token = json.load(open("../data/.spotify_token_cache.json"))["refresh_token"]
if not re.fullmatch(r"[A-Za-z0-9_\-]+", token):
    sys.exit("unexpected characters in refresh token; not seeding")
sql = (
    "INSERT INTO state(key, value, updated_at) VALUES('spotify_refresh_token', '%s', datetime('now')) "
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')" % token
)
r = subprocess.run(["npx", "wrangler", "d1", "execute", d1, "--remote", "--command", sql], capture_output=True, text=True)
ok = r.returncode == 0 and "ERROR" not in r.stdout + r.stderr
print(f"seed token into {d1}: {'ok' if ok else 'FAILED'}")
sys.exit(0 if ok else 1)
