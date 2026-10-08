#!/bin/bash
# Run one SQL file on SQLite and on remote D1, then diff the full result sets.
# Usage: ./scripts/compare-query.sh <sqlite.db> <d1-database-name> <query.sql> [param ...]
# Each ? in the query is replaced, in order, by the next param (literal SQL).
# Exits non-zero if the result sets differ.

set -euo pipefail

SQLITE="${1:?Usage: $0 <sqlite.db> <d1-db> <query.sql> [param ...]}"
D1="${2:?}"
QUERY_FILE="${3:?}"
shift 3

SQL=$(python3 -I - "$QUERY_FILE" "$@" <<'EOF'
import sys
sql, params = open(sys.argv[1]).read(), sys.argv[2:]
if sql.count("?") != len(params):
    sys.exit(f"{sys.argv[1]}: {sql.count('?')} placeholders, {len(params)} params")
for p in params:
    sql = sql.replace("?", p, 1)
print(" ".join(line.split("--")[0] for line in sql.splitlines()).strip().rstrip(";"))
EOF
)

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

sqlite3 -json "$SQLITE" "$SQL" > "$TMP/sqlite.json"
npx wrangler d1 execute "$D1" --remote --json --command "$SQL" 2>/dev/null > "$TMP/d1.json"

python3 -I - "$TMP/sqlite.json" "$TMP/d1.json" "$QUERY_FILE" <<'EOF'
import json, sys
raw = open(sys.argv[1]).read()
s = json.loads(raw) if raw.strip() else []  # sqlite3 -json prints nothing for zero rows
d1 = json.load(open(sys.argv[2]))
if isinstance(d1, dict):
    sys.exit(f"D1 error: {json.dumps(d1)[:500]}")
d = d1[0]["results"]
norm = lambda rows: sorted(json.dumps(r, sort_keys=True) for r in rows)
same_order = [json.dumps(r, sort_keys=True) for r in s] == [json.dumps(r, sort_keys=True) for r in d]
if norm(s) == norm(d):
    print(f"MATCH  {sys.argv[3]}: {len(s)} rows (order {'identical' if same_order else 'differs on ties'})")
else:
    only_s, only_d = set(norm(s)) - set(norm(d)), set(norm(d)) - set(norm(s))
    print(f"DIFF   {sys.argv[3]}: sqlite={len(s)} d1={len(d)} only_sqlite={len(only_s)} only_d1={len(only_d)}")
    for r in list(only_s)[:3]: print("  sqlite:", r)
    for r in list(only_d)[:3]: print("  d1:    ", r)
    sys.exit(1)
EOF
