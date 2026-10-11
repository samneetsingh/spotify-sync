// Response shapes we read. Fields are optional/nullable because the parsers
// mirror the Python `.get()` handling of missing data.

export interface SpotifyArtistSimple {
  id?: string | null;
  name?: string | null;
}

export interface SpotifyArtistFull {
  id?: string | null;
  name?: string | null;
  genres?: string[] | null;
  popularity?: number | null;
  followers?: { total?: number | null } | null;
  images?: SpotifyImage[] | null;
}

export interface SpotifyImage {
  url?: string | null;
  width?: number | null;
}

export interface SpotifyTrack {
  id?: string | null;
  uri?: string | null;
  name?: string | null;
  artists?: SpotifyArtistSimple[] | null;
  album?: { name?: string | null; release_date?: string | null; images?: SpotifyImage[] | null } | null;
  duration_ms?: number | null;
  explicit?: boolean | null;
  popularity?: number | null;
  external_ids?: { isrc?: string | null } | null;
}

export interface SpotifyPlayHistory {
  track?: SpotifyTrack | null;
  played_at?: string | null;
  context?: { type?: string | null; uri?: string | null } | null;
}

export interface RecentlyPlayedResponse {
  items?: SpotifyPlayHistory[] | null;
}

export interface PlaylistItemsResponse {
  items?: Array<{ track?: SpotifyTrack | null }> | null;
  next?: string | null;
}

export interface MyPlaylistsResponse {
  items?: Array<{ id?: string } | null> | null;
  next?: string | null;
}

export interface PlaylistResponse {
  tracks?: { total?: number | null } | null;
}

export interface UserProfile {
  id: string;
  display_name?: string | null;
}

export interface CreatePlaylistResponse {
  id: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
}
