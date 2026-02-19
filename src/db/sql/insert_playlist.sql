INSERT INTO playlists(playlist_id, name, artist_name, playlist_type)
VALUES(?, ?, ?, ?)
ON CONFLICT(playlist_id) DO UPDATE SET
  name=excluded.name,
  artist_name=excluded.artist_name;
