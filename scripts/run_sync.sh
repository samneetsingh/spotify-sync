#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Lock file to prevent concurrent syncs
LOCKFILE="data/.sync.lock"
LOCKFD=200

# Create lock file directory if it doesn't exist
mkdir -p "$(dirname "$LOCKFILE")"

# Acquire exclusive lock or exit if already locked
exec 200>"$LOCKFILE"
if ! flock -n 200; then
  echo "Another sync is already running. Skipping this run."
  exit 0
fi

# Cleanup lock on exit
trap 'flock -u 200' EXIT

# Load .env safely (no eval of interpolations)
if [ -f ".env" ]; then
  set -a
  # shellcheck disable=SC1091
  source ".env"
  set +a
fi

if command -v poetry >/dev/null 2>&1; then
  exec poetry run spotify sync
fi

exec python3 -m src.main sync
