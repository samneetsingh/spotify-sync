#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Load .env (simple)
if [ -f ".env" ]; then
  export $(grep -v '^#' .env | xargs) || true
fi

python3 -m src.main sync