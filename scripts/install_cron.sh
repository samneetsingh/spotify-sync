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

FLOCK_BIN="$(command -v flock || true)"
LOGGER_BIN="$(command -v logger || true)"

# Ensure logs directory exists
mkdir -p "${PROJECT_DIR}/data/logs"
chmod 700 "${PROJECT_DIR}/data" "${PROJECT_DIR}/data/logs" 2>/dev/null || true

LOCK_CMD=""
if [[ -n "${FLOCK_BIN}" ]]; then
  LOCK_CMD="${FLOCK_BIN} -n /tmp/spotify-automation.lock "
else
  echo "WARN: flock not found; cron job will run without a lock."
fi

LOG_PIPE=""
if [[ -n "${LOGGER_BIN}" ]]; then
  LOG_PIPE="| ${LOGGER_BIN} -t spotify-automation"
else
  LOG_PIPE=">> \"${PROJECT_DIR}/data/logs/cron.log\""
fi

SYNC_LINE="*/10 * * * * cd \"${PROJECT_DIR}\" && ${LOCK_CMD}${POETRY_BIN} run spotify sync 2>&1 ${LOG_PIPE}"
ARTIST_LINE="0 3 * * * cd \"${PROJECT_DIR}\" && ${LOCK_CMD}${POETRY_BIN} run spotify artist-playlists 2>&1 ${LOG_PIPE}"

# Install cron jobs (idempotent)
(
  crontab -l 2>/dev/null | grep -v "spotify sync" | grep -v "spotify artist-playlists" || true
  echo "${SYNC_LINE}"
  echo "${ARTIST_LINE}"
) | crontab -

echo "Installed cron jobs:"
echo "${SYNC_LINE}"
echo "${ARTIST_LINE}"
