SELECT DISTINCT ta.artist_id
FROM track_artists ta
LEFT JOIN artists a ON ta.artist_id = a.artist_id
WHERE a.artist_id IS NULL;
