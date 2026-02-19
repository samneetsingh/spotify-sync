SELECT
  p.track_id,
  t.track_uri,
  COUNT(*) AS play_count,
  MAX(p.played_at_ms) AS last_play
FROM plays p
JOIN tracks t ON p.track_id = t.track_id
GROUP BY p.track_id, t.track_uri
HAVING play_count >= ?
ORDER BY play_count DESC, last_play DESC;
