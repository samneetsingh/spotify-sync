FROM python:3.12-alpine AS builder

RUN apk add --no-cache build-base libffi-dev
RUN pip install --no-cache-dir poetry==2.1.3 poetry-plugin-export

WORKDIR /app
COPY pyproject.toml poetry.lock ./

# Export deps to requirements.txt for a clean runtime image
RUN poetry export --without dev --format requirements.txt --output /tmp/requirements.txt

FROM python:3.12-alpine

RUN apk add --no-cache libffi

WORKDIR /app

# Install deps from requirements.txt (no Poetry needed at runtime)
COPY --from=builder /tmp/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && rm /tmp/requirements.txt

# Copy application code
COPY pyproject.toml README.md ./
COPY src/ src/

# Install the project itself (entry points)
RUN pip install --no-cache-dir .

# Cron schedule
COPY docker/crontab /etc/crontabs/root

# Data directory mount point
VOLUME /data

ENV DB_PATH=/data/spotify.db \
    LOG_FILE=/data/logs/spotify.log \
    SPOTIFY_TOKEN_CACHE_PATH=/data/.spotify_token_cache.json

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

HEALTHCHECK --interval=5m --timeout=10s --retries=2 \
    CMD python -c "import sqlite3, os, time; \
        db=sqlite3.connect(os.environ.get('DB_PATH','/data/spotify.db')); \
        r=db.execute('SELECT finished_at FROM sync_runs WHERE status=\"success\" ORDER BY id DESC LIMIT 1').fetchone(); \
        db.close(); \
        exit(0 if r else 1)"

ENTRYPOINT ["/entrypoint.sh"]
CMD ["crond", "-f", "-l", "2"]
