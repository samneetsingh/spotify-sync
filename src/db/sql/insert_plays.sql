INSERT OR IGNORE INTO plays(
  played_at_ms, track_id, track_uri, context_type, context_uri, source
) VALUES (?, ?, ?, ?, ?, ?);
