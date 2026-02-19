#!/bin/sh
set -e

# Export env vars so cron jobs inherit them
env | grep -E '^(SPOTIFY_|DB_|LOG_|FREQUENT_|BOOTSTRAP_|RECENTLY_|PLAYLIST_|LIKE_|ARTIST_|YEARLY_|CACHE_)' > /etc/environment 2>/dev/null || true

# Ensure data directories exist
mkdir -p /data/logs

# Run migrations on startup
spotify migrate

# Execute CMD (default: crond -f)
exec "$@"
