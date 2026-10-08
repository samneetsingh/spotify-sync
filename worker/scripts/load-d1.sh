#!/bin/bash
# Load a SQLite database into an EMPTY remote D1 database, then verify row counts.
# Usage: ./scripts/load-d1.sh <sqlite.db> <d1-database-name>
#
# Steps (PLAN.md 4.5): dump -> data-only INSERTs (unistr rewritten) -> schema ->
# per-table 50K-row chunks, parents first for FK order, each chunk imported atomically
# with up to 3 attempts -> verify-counts.sh. A failed chunk rolls back on its own, so
# re-running a failed chunk is safe; the script refuses to load into a non-empty D1.

set -euo pipefail

SQLITE="${1:?Usage: $0 <sqlite.db> <d1-database-name>}"
D1="${2:?Usage: $0 <sqlite.db> <d1-database-name>}"
cd "$(dirname "$0")/.."
WORK="data/load-$D1"
TABLES="state tracks artists track_artists plays playlists playlist_tracks playlist_removals playlist_exclusions sync_runs"

existing=$(npx wrangler d1 execute "$D1" --remote --json --command "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='tracks'" 2>/dev/null \
  | python3 -I -c "import sys,json; print(json.load(sys.stdin)[0]['results'][0]['n'])")
if [ "$existing" != "0" ]; then
  rows=$(npx wrangler d1 execute "$D1" --remote --json --command "SELECT COUNT(*) AS n FROM tracks" 2>/dev/null \
    | python3 -I -c "import sys,json; print(json.load(sys.stdin)[0]['results'][0]['n'])")
  if [ "$rows" != "0" ]; then
    echo "Refusing to load: $D1 already has $rows tracks. Use an empty database." >&2
    exit 1
  fi
fi

rm -rf "$WORK" && mkdir -p "$WORK/chunks"
echo "==> Dumping $SQLITE"
sqlite3 -readonly "$SQLITE" .dump > "$WORK/raw-dump.sql"
./scripts/prepare-d1-dump.sh "$WORK/raw-dump.sql" "$WORK/data.sql" > "$WORK/prepare.log"
sed -n 2,3p "$WORK/prepare.log"
npx tsx scripts/schema-sql.ts > "$WORK/schema.sql"

echo "==> Applying schema"
npx wrangler d1 execute "$D1" --remote --file="$WORK/schema.sql" --yes > "$WORK/schema.log" 2>&1 \
  || { cat "$WORK/schema.log"; exit 1; }

echo "==> Chunking"
i=0
for T in $TABLES; do
  grep "^INSERT INTO \"\?$T\"\? " "$WORK/data.sql" > "$WORK/chunks/tmp" || true
  if [ -s "$WORK/chunks/tmp" ]; then
    split -l 50000 "$WORK/chunks/tmp" "$WORK/chunks/$(printf %02d $i)_${T}_"
    i=$((i + 1))
  fi
done
rm -f "$WORK/chunks/tmp"
total=$(cat "$WORK"/chunks/* | wc -l | tr -d ' ')
expected=$(wc -l < "$WORK/data.sql" | tr -d ' ')
[ "$total" = "$expected" ] || { echo "Chunking lost rows: $total != $expected" >&2; exit 1; }

echo "==> Importing $(ls "$WORK/chunks" | wc -l | tr -d ' ') chunks"
for f in "$WORK"/chunks/*; do
  ok=0
  for attempt in 1 2 3; do
    if npx wrangler d1 execute "$D1" --remote --file="$f" --yes > "$WORK/last.log" 2>&1 && ! grep -q ERROR "$WORK/last.log"; then
      echo "  OK   $(basename "$f") (attempt $attempt)"
      ok=1
      break
    fi
    echo "  FAIL $(basename "$f") attempt $attempt: $(grep -m1 ERROR "$WORK/last.log" || tail -1 "$WORK/last.log")"
    sleep 5
  done
  [ $ok = 1 ] || { echo "Stopped at $f; earlier chunks are loaded. Fix, then re-run this chunk only." >&2; exit 1; }
done

echo "==> Verifying"
./scripts/verify-counts.sh "$SQLITE" "$D1"
