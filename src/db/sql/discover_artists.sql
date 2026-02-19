WITH
    songs AS (
        SELECT
            t.name AS songName,
            t.artists AS artists,
            COUNT(p.track_id) AS play_count
        FROM
            plays p
            JOIN tracks t ON p.track_id = t.track_id
        GROUP BY
            t.name,
            t.artists,
            p.track_id
    ),
    split(songName, play_count, artist, rest) AS (
        SELECT
            songName,
            play_count,
            CASE
                WHEN INSTR(artists, ', ') > 0 THEN SUBSTR(artists, 1, INSTR(artists, ', ') - 1)
                ELSE artists
            END,
            CASE
                WHEN INSTR(artists, ', ') > 0 THEN SUBSTR(artists, INSTR(artists, ', ') + 2)
                ELSE NULL
            END
        FROM songs

        UNION ALL

        SELECT
            songName,
            play_count,
            CASE
                WHEN INSTR(rest, ', ') > 0 THEN SUBSTR(rest, 1, INSTR(rest, ', ') - 1)
                ELSE rest
            END,
            CASE
                WHEN INSTR(rest, ', ') > 0 THEN SUBSTR(rest, INSTR(rest, ', ') + 2)
                ELSE NULL
            END
        FROM split
        WHERE rest IS NOT NULL
    )

SELECT
    artist,
    COUNT(*) AS song_count,
    SUM(play_count) AS total_streams,
    COUNT(CASE WHEN play_count > ? THEN 1 END) AS songs_over_threshold
FROM split
GROUP BY artist
HAVING songs_over_threshold > ? OR total_streams > ? OR (song_count > ? AND total_streams > ?)
ORDER BY total_streams DESC;
