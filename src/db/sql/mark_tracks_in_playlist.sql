INSERT INTO playlist_tracks(playlist_id, track_id, track_uri, first_added_at, last_seen_at)
VALUES(?, ?, ?, datetime('now'), datetime('now'))
ON CONFLICT(playlist_id, track_id) DO UPDATE SET
  track_uri=excluded.track_uri,
  last_seen_at=datetime('now');
