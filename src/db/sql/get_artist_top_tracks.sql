SELECT
  p.track_id AS track_id,
  t.track_uri AS track_uri,
  COUNT(*) AS play_count,
  MAX(p.played_at_ms) AS last_play_ms
FROM plays p
JOIN tracks t ON p.track_id = t.track_id
WHERE lower(COALESCE(t.artists, '')) LIKE ?
GROUP BY p.track_id, t.track_uri
ORDER BY play_count DESC, last_play_ms DESC
LIMIT ?;
