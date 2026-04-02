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

: "${DB_SSH_HOST:?Missing DB_SSH_HOST in .env}"
: "${DB_SSH_USER:?Missing DB_SSH_USER in .env}"
: "${DB_SSH_KEY_PATH:?Missing DB_SSH_KEY_PATH in .env}"
: "${DB_REMOTE_PATH:?Missing DB_REMOTE_PATH in .env}"

SSH_KEY_PATH="${DB_SSH_KEY_PATH/#\~/$HOME}"
SSH_OPTS=(-i "$SSH_KEY_PATH" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)
SSH_TARGET="${DB_SSH_USER}@${DB_SSH_HOST}"

# Derive remote project dir from DB path
REMOTE_PROJECT_DIR="$(dirname "$(dirname "$DB_REMOTE_PATH")")"

echo "==> Deploying to ${SSH_TARGET}:${REMOTE_PROJECT_DIR}"

echo "==> Pulling latest code on remote..."
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" \
  "cd ${REMOTE_PROJECT_DIR} && git pull origin main"

echo "==> Rebuilding and restarting Docker container..."
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" \
  "cd ${REMOTE_PROJECT_DIR} && docker compose up -d --build"

echo "==> Running migration..."
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" \
  "cd ${REMOTE_PROJECT_DIR} && docker compose exec spotify-sync spotify migrate"

echo "==> Deploy complete."
