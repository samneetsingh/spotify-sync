UPDATE sync_runs
SET finished_at=datetime('now'),
    cursor_out_ms=?,
    plays_fetched=?,
    tracks_added=?,
    status=?,
    error=?
WHERE id=?;
