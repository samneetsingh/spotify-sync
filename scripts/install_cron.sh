#!/usr/bin/env bash
set -euo pipefail

# Resolve this script's directory (even if symlinked)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Resolve poetry path
POETRY_BIN="$(command -v poetry)"

if [[ -z "${POETRY_BIN}" ]]; then
  echo "ERROR: poetry not found in PATH"
  exit 1
fi

# Ensure logs directory exists
mkdir -p "${PROJECT_DIR}/data/logs"

CRON_LINE="*/10 * * * * cd ${PROJECT_DIR} && /usr/bin/flock -n /tmp/spotify-automation.lock ${POETRY_BIN} run spotify sync >> data/logs/cron.log 2>&1"

# Install cron job (idempotent)
(
  crontab -l 2>/dev/null | grep -v "spotify sync" || true
  echo "${CRON_LINE}"
) | crontab -

echo "Installed cron job:"
echo "${CRON_LINE}"