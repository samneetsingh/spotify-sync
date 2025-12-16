INSERT INTO tracks(track_id, track_uri, name, artists, album, duration_ms, explicit)
VALUES(?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(track_id) DO UPDATE SET
  track_uri=excluded.track_uri,
  name=COALESCE(excluded.name, tracks.name),
  artists=COALESCE(excluded.artists, tracks.artists),
  album=COALESCE(excluded.album, tracks.album),
  duration_ms=COALESCE(excluded.duration_ms, tracks.duration_ms),
  explicit=COALESCE(excluded.explicit, tracks.explicit);
