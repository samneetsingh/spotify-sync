#!/bin/bash
# Extract data-only INSERT statements from a SQLite dump for D1 import.
# Usage: ./scripts/prepare-d1-dump.sh <input.sql> <output.sql>
#
# Rewrites unistr('...') literals (newer sqlite3 emits them; D1 rejects the function).
# Strips: PRAGMA, BEGIN/COMMIT, CREATE TABLE/INDEX, ANALYZE, DELETE,
#         sqlite_* tables, schema_migrations (D1 migration handles versioning)

set -euo pipefail

INPUT="${1:?Usage: $0 <input.sql> <output.sql>}"
OUTPUT="${2:?Usage: $0 <input.sql> <output.sql>}"

echo "Processing $INPUT → $OUTPUT"

grep '^INSERT INTO' "$INPUT" \
  | grep -v '^INSERT INTO schema_migrations ' \
  | grep -v '^INSERT INTO sqlite_sequence ' \
  | grep -v '^INSERT INTO sqlite_stat' \
  | python3 -I "$(dirname "$0")/decode-unistr.py" \
  > "$OUTPUT"

INPUT_LINES=$(wc -l < "$INPUT")
OUTPUT_LINES=$(wc -l < "$OUTPUT")
OUTPUT_SIZE=$(wc -c < "$OUTPUT" | tr -d ' ')

echo "Input:  $INPUT_LINES lines"
echo "Output: $OUTPUT_LINES INSERT statements ($OUTPUT_SIZE bytes)"
echo ""

# Row count verification helper
echo "-- Verify row counts after import with:"
for TABLE in tracks plays artists track_artists playlists playlist_tracks playlist_removals playlist_exclusions sync_runs state; do
  COUNT=$(grep -c "^INSERT INTO $TABLE " "$OUTPUT" 2>/dev/null || echo 0)
  echo "--   SELECT '$TABLE' AS tbl, COUNT(*) AS cnt FROM $TABLE;  -- expected: $COUNT"
done
