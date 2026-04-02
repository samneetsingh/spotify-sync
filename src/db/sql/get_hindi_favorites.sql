SELECT p.track_id,
       p.track_uri,
       COUNT(*) AS play_count
  FROM plays p
  JOIN track_artists ta ON ta.track_id = p.track_id
  JOIN artists a ON a.artist_id = ta.artist_id
 WHERE EXISTS (
         SELECT 1 FROM json_each(a.genres) je
          WHERE je.value IN ('bollywood', 'hindi', 'filmi', 'desi')
       )
 GROUP BY p.track_id, p.track_uri
HAVING COUNT(*) >= ?
 ORDER BY play_count DESC;
