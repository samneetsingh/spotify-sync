SELECT playlist_id, name
FROM playlists
WHERE artist_name = ? AND playlist_type = 'artist';
