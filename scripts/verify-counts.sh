#!/bin/bash
# Compare per-table row counts between a SQLite file and a remote D1 database
# (rollback check: after loading a `wrangler d1 export` into a fresh SQLite file).
# Usage: ./scripts/verify-counts.sh <sqlite.db> <d1-database-name>   (from the repo root)
# Uses $WRANGLER_CONFIG, else wrangler.generated.toml when present. Exits non-zero if any table differs.

set -euo pipefail

SQLITE="${1:?Usage: $0 <sqlite.db> <d1-database-name>}"
D1="${2:?Usage: $0 <sqlite.db> <d1-database-name>}"
CONFIG="${WRANGLER_CONFIG:-wrangler.generated.toml}"
CONFIG_ARGS=()
[ -f "$CONFIG" ] && CONFIG_ARGS=(-c "$CONFIG")
TABLES="tracks plays artists track_artists playlists playlist_tracks playlist_removals playlist_exclusions sync_runs state"

# One row of scalar subqueries: D1 caps the number of terms in a compound (UNION ALL) SELECT.
QUERY="SELECT $(for T in $TABLES; do printf "(SELECT COUNT(*) FROM %s) AS %s, " "$T" "$T"; done | sed 's/, $//')"

D1_COUNTS=$(npx wrangler d1 execute "$D1" --remote --json --command "$QUERY" ${CONFIG_ARGS[@]+"${CONFIG_ARGS[@]}"} 2>/dev/null \
  | node -e 'const r = JSON.parse(require("fs").readFileSync(0, "utf8"))[0].results[0]; for (const [k, v] of Object.entries(r)) console.log(k, v)')

FAIL=0
printf "%-20s %10s %10s\n" table sqlite d1
for T in $TABLES; do
  S=$(sqlite3 "$SQLITE" "SELECT COUNT(*) FROM $T")
  D=$(echo "$D1_COUNTS" | awk -v t="$T" '$1==t {print $2}')
  MARK=""; [ "$S" = "$D" ] || { MARK="  MISMATCH"; FAIL=1; }
  printf "%-20s %10s %10s%s\n" "$T" "$S" "$D" "$MARK"
done
exit $FAIL
