INSERT INTO artists(artist_id, name, genres, popularity, followers, updated_at)
VALUES(?, ?, ?, ?, ?, datetime('now'))
ON CONFLICT(artist_id) DO UPDATE SET
  name=excluded.name,
  genres=COALESCE(excluded.genres, artists.genres),
  popularity=COALESCE(excluded.popularity, artists.popularity),
  followers=COALESCE(excluded.followers, artists.followers),
  updated_at=datetime('now');
