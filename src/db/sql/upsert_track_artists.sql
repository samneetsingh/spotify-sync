INSERT INTO track_artists(track_id, artist_id, artist_name, position)
VALUES(?, ?, ?, ?)
ON CONFLICT(track_id, artist_id) DO UPDATE SET
  artist_name=excluded.artist_name,
  position=excluded.position;
