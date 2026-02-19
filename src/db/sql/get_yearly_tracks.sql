SELECT
  p.track_id AS track_id,
  t.track_uri AS track_uri,
  COUNT(*) AS play_count,
  MAX(p.played_at_ms) AS last_play_ms
FROM plays p
JOIN tracks t ON p.track_id = t.track_id
WHERE p.played_at_ms >= ? AND p.played_at_ms < ?
GROUP BY p.track_id, t.track_uri
ORDER BY play_count DESC, last_play_ms DESC
LIMIT ?;
