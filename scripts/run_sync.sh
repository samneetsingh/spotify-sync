#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

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
