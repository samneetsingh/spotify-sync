from __future__ import annotations

import time
from datetime import datetime, timezone


def iso8601_to_ms(played_at: str) -> int:
    """
    Convert ISO-8601 string (with Z or offset) to epoch milliseconds.
    """
    normalized = played_at.replace("Z", "+00:00")
    dt = datetime.fromisoformat(normalized)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def now_ms() -> int:
    return int(time.time() * 1000)
