#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Load .env
if [ -f ".env" ]; then
  set -a
  # shellcheck disable=SC1091
  source ".env"
  set +a
fi

# Required env vars
: "${DB_SSH_HOST:?Missing DB_SSH_HOST in .env}"
: "${DB_SSH_USER:?Missing DB_SSH_USER in .env}"
: "${DB_SSH_KEY_PATH:?Missing DB_SSH_KEY_PATH in .env}"
: "${DB_REMOTE_PATH:?Missing DB_REMOTE_PATH in .env}"
: "${DB_LOCAL_PATH:?Missing DB_LOCAL_PATH in .env}"

SSH_KEY_PATH="${DB_SSH_KEY_PATH/#\~/$HOME}"
SSH_OPTS=(-i "$SSH_KEY_PATH" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)
SSH_TARGET="${DB_SSH_USER}@${DB_SSH_HOST}"

# DB_REMOTE_PATH may contain ~ which should NOT be expanded locally.
# For ssh commands: pass it unquoted so the remote shell expands ~
# For scp: replace ~ with the literal string so scp resolves it on the remote
# scp treats ~ correctly in the remote path portion (user@host:~/path)
REMOTE_DB="$DB_REMOTE_PATH"
REMOTE_PROJECT_DIR="$(dirname "$(dirname "$REMOTE_DB")")"

timestamp() { date +%Y%m%d_%H%M%S; }

confirm() {
  local msg="$1"
  if [[ "${FORCE:-}" == "1" ]]; then return 0; fi
  printf "%s [y/N] " "$msg"
  read -r answer
  [[ "$answer" =~ ^[Yy]$ ]]
}

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS] <pull|push>

Sync the SQLite database between local and remote server.

Commands:
  pull    Download remote DB to local (overwrites local)
  push    Upload local DB to remote (overwrites remote)

Options:
  -y, --yes    Skip confirmation prompt

Environment (from .env):
  DB_SSH_HOST=$DB_SSH_HOST
  DB_SSH_USER=$DB_SSH_USER
  DB_REMOTE_PATH=$DB_REMOTE_PATH
  DB_LOCAL_PATH=$DB_LOCAL_PATH
EOF
  exit 1
}

do_pull() {
  echo "==> Pulling remote DB to local"
  echo "    Remote: ${SSH_TARGET}:${DB_REMOTE_PATH}"
  echo "    Local:  ${DB_LOCAL_PATH}"

  if ! confirm "This will overwrite your local database. Continue?"; then
    echo "Aborted."
    exit 0
  fi

  # Back up local DB if it exists
  if [ -f "$DB_LOCAL_PATH" ]; then
    local backup="${DB_LOCAL_PATH}.bak.$(timestamp)"
    cp "$DB_LOCAL_PATH" "$backup"
    echo "    Local backup: $backup"
  fi

  # Stop the Docker container to ensure no writes during copy
  echo "==> Stopping remote Docker container..."
  ssh "${SSH_OPTS[@]}" "$SSH_TARGET" \
    "cd ${REMOTE_PROJECT_DIR} && docker compose stop spotify-sync" || true

  # Download the DB and WAL file (if present)
  echo "==> Downloading..."
  mkdir -p "$(dirname "$DB_LOCAL_PATH")"
  scp "${SSH_OPTS[@]}" "${SSH_TARGET}:${REMOTE_DB}" "$DB_LOCAL_PATH"
  scp "${SSH_OPTS[@]}" "${SSH_TARGET}:${REMOTE_DB}-wal" "${DB_LOCAL_PATH}-wal" 2>/dev/null || true
  # SHM is transient and doesn't need to be copied
  rm -f "${DB_LOCAL_PATH}-shm"

  # Restart the container
  echo "==> Restarting remote Docker container..."
  ssh "${SSH_OPTS[@]}" "$SSH_TARGET" \
    "cd ${REMOTE_PROJECT_DIR} && docker compose start spotify-sync"

  echo "==> Pull complete."
}

do_push() {
  echo "==> Pushing local DB to remote"
  echo "    Local:  ${DB_LOCAL_PATH}"
  echo "    Remote: ${SSH_TARGET}:${DB_REMOTE_PATH}"

  if [ ! -f "$DB_LOCAL_PATH" ]; then
    echo "Error: local DB not found at ${DB_LOCAL_PATH}"
    exit 1
  fi

  if ! confirm "This will overwrite the REMOTE database. Continue?"; then
    echo "Aborted."
    exit 0
  fi

  # Stop the Docker container to ensure no writes during copy
  echo "==> Stopping remote Docker container..."
  ssh "${SSH_OPTS[@]}" "$SSH_TARGET" \
    "cd ${REMOTE_PROJECT_DIR} && docker compose stop spotify-sync" || true

  # Back up remote DB
  echo "==> Backing up remote DB..."
  ssh "${SSH_OPTS[@]}" "$SSH_TARGET" \
    "cp ${REMOTE_DB} ${REMOTE_DB}.bak.$(timestamp) 2>/dev/null || true"

  # Upload local DB (and WAL if present)
  echo "==> Uploading..."
  scp "${SSH_OPTS[@]}" "$DB_LOCAL_PATH" "${SSH_TARGET}:${REMOTE_DB}"
  if [ -f "${DB_LOCAL_PATH}-wal" ]; then
    scp "${SSH_OPTS[@]}" "${DB_LOCAL_PATH}-wal" "${SSH_TARGET}:${REMOTE_DB}-wal"
  else
    ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "rm -f ${REMOTE_DB}-wal"
  fi
  # Remove stale SHM on remote
  ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "rm -f ${REMOTE_DB}-shm"

  # Restart the container
  echo "==> Restarting remote Docker container..."
  ssh "${SSH_OPTS[@]}" "$SSH_TARGET" \
    "cd ${REMOTE_PROJECT_DIR} && docker compose start spotify-sync"

  echo "==> Push complete."
}

# Parse args
FORCE=0
CMD=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -y|--yes) FORCE=1; shift ;;
    pull|push) CMD="$1"; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown argument: $1"; usage ;;
  esac
done

if [[ -z "$CMD" ]]; then
  usage
fi

case "$CMD" in
  pull) do_pull ;;
  push) do_push ;;
esac
