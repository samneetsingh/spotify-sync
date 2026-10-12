import type { WriteMode } from "../env";
import type {
  CreatePlaylistResponse,
  MyPlaylistsResponse,
  PlaylistItemsResponse,
  PlaylistResponse,
  RecentlyPlayedResponse,
  SpotifyArtistFull,
  SpotifyTrack,
  TokenResponse,
  UserProfile,
} from "./types";
import { RateLimitError, SpotifyError } from "./errors";
import { refreshAccessToken } from "./auth";
import { getState, setState } from "../db/state";

const API_BASE = "https://api.spotify.com/v1";
const MAX_RETRIES = 1;
const RETRY_DELAY_MS = 1000;
const MAX_RETRY_AFTER_S = 30;

export interface SpotifyAction {
  action: "addToPlaylist" | "replacePlaylistItems" | "addToLikedSongs" | "createPlaylist" | "unfollowPlaylist";
  target: string | null;
  items: string[];
  executed: boolean;
}

export class SpotifyClient {
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private tokenRefresh: Promise<string> | null = null;
  private readonly spotifyWritesEnabled: boolean;
  private actions: SpotifyAction[] = [];

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly db: D1Database,
    writeMode: WriteMode,
  ) {
    this.spotifyWritesEnabled = writeMode === "live";
  }

  private async ensureToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }
    // Concurrent requests (e.g. getTracks and getArtists in parallel) share one refresh, so a
    // rotated refresh token is saved once and never overwritten by a slower, older response.
    this.tokenRefresh ??= this.refreshToken().finally(() => {
      this.tokenRefresh = null;
    });
    return this.tokenRefresh;
  }

  private async refreshToken(): Promise<string> {
    const refreshToken = await getState(this.db, "spotify_refresh_token");
    if (!refreshToken) {
      throw new SpotifyError("No refresh token in D1 state table", 0);
    }

    const token: TokenResponse = await refreshAccessToken(
      this.clientId,
      this.clientSecret,
      refreshToken,
    );

    this.accessToken = token.access_token;
    this.tokenExpiresAt = Date.now() + (token.expires_in - 60) * 1000;

    if (token.refresh_token && token.refresh_token !== refreshToken) {
      await setState(this.db, "spotify_refresh_token", token.refresh_token);
      console.log("Spotify refresh token was rotated — saved new token to D1");
    }

    return this.accessToken;
  }

  private async request(
    url: string,
    init: RequestInit = {},
    retryCount = 0,
  ): Promise<Response> {
    const token = await this.ensureToken();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);

    const resp = await fetch(url, { ...init, headers });

    if (resp.status === 429) {
      const retryAfter = Math.min(
        parseInt(resp.headers.get("Retry-After") ?? "5", 10),
        MAX_RETRY_AFTER_S,
      );
      if (retryCount < MAX_RETRIES) {
        await sleep(retryAfter * 1000);
        return this.request(url, init, retryCount + 1);
      }
      const body = await resp.text();
      throw new RateLimitError(retryAfter, body);
    }

    if (resp.status === 401 && retryCount < MAX_RETRIES) {
      this.accessToken = null;
      this.tokenExpiresAt = 0;
      return this.request(url, init, retryCount + 1);
    }

    if (resp.status >= 500 && retryCount < MAX_RETRIES) {
      await sleep(RETRY_DELAY_MS);
      return this.request(url, init, retryCount + 1);
    }

    if (!resp.ok) {
      const body = await resp.text();
      throw new SpotifyError(
        `Spotify API ${init.method ?? "GET"} ${url} → ${resp.status}: ${body}`,
        resp.status,
        body,
      );
    }

    return resp;
  }

  private async get<T>(path: string, params?: Record<string, string>, signal?: AbortSignal): Promise<T> {
    const url = new URL(`${API_BASE}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }
    const resp = await this.request(url.toString(), signal ? { signal } : {});
    return resp.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const resp = await this.request(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return resp.json() as Promise<T>;
  }

  private async put(path: string, body: unknown): Promise<void> {
    await this.request(`${API_BASE}${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async delete(path: string, body?: unknown): Promise<void> {
    await this.request(`${API_BASE}${path}`, {
      method: "DELETE",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  // --- Read endpoints (always allowed) ---

  async getRecentlyPlayed(params: {
    limit?: number;
    after?: number;
  }): Promise<RecentlyPlayedResponse> {
    const p: Record<string, string> = {};
    if (params.limit != null) p.limit = String(params.limit);
    if (params.after != null) p.after = String(params.after);
    return this.get("/me/player/recently-played", p);
  }

  async getPlaylist(
    playlistId: string,
    fields?: string,
  ): Promise<PlaylistResponse> {
    const p: Record<string, string> = {};
    if (fields) p.fields = fields;
    return this.get(`/playlists/${playlistId}`, p);
  }

  async getPlaylistItems(
    playlistId: string,
    params: { limit?: number; offset?: number; fields?: string },
  ): Promise<PlaylistItemsResponse> {
    const p: Record<string, string> = {};
    if (params.limit != null) p.limit = String(params.limit);
    if (params.offset != null) p.offset = String(params.offset);
    if (params.fields) p.fields = params.fields;
    return this.get(`/playlists/${playlistId}/tracks`, p);
  }

  /** Playlists the user owns or follows. */
  async getMyPlaylists(params: { limit?: number; offset?: number }): Promise<MyPlaylistsResponse> {
    const p: Record<string, string> = {};
    if (params.limit != null) p.limit = String(params.limit);
    if (params.offset != null) p.offset = String(params.offset);
    return this.get("/me/playlists", p);
  }

  async getMe(): Promise<UserProfile> {
    return this.get("/me");
  }

  /** `signal` aborts the API request (and its retry), not the token refresh before it. */
  async getArtists(ids: string[], signal?: AbortSignal): Promise<{ artists?: Array<SpotifyArtistFull | null> }> {
    return this.get("/artists", { ids: ids.join(",") }, signal);
  }

  async getArtist(id: string): Promise<SpotifyArtistFull> {
    return this.get(`/artists/${id}`);
  }

  /** `signal` aborts the API request (and its retry), not the token refresh before it. */
  async getTracks(ids: string[], signal?: AbortSignal): Promise<{ tracks?: Array<SpotifyTrack | null> }> {
    return this.get("/tracks", { ids: ids.join(",") }, signal);
  }

  async getTrack(id: string): Promise<SpotifyTrack> {
    return this.get(`/tracks/${id}`);
  }

  // --- Write endpoints: only sent in live mode; every call is recorded ---

  /** Returns and clears the actions recorded since the last drain. */
  drainActions(): SpotifyAction[] {
    const out = this.actions;
    this.actions = [];
    return out;
  }

  private async write(
    action: SpotifyAction["action"],
    target: string | null,
    items: string[],
    send: () => Promise<unknown>,
  ): Promise<boolean> {
    if (!this.spotifyWritesEnabled) {
      console.log(JSON.stringify({ would_do: action, target, count: items.length, items }));
      this.actions.push({ action, target, items, executed: false });
      return false;
    }
    await send();
    this.actions.push({ action, target, items, executed: true });
    return true;
  }

  async addToPlaylist(playlistId: string, uris: string[]): Promise<void> {
    await this.write("addToPlaylist", playlistId, uris, () =>
      this.post(`/playlists/${playlistId}/tracks`, { uris }),
    );
  }

  /** Replaces the playlist's whole contents (Spotify accepts at most 100 URIs here). */
  async replacePlaylistItems(playlistId: string, uris: string[]): Promise<void> {
    if (uris.length > 100) throw new Error(`replacePlaylistItems takes at most 100 URIs (got ${uris.length})`);
    await this.write("replacePlaylistItems", playlistId, uris, () =>
      this.put(`/playlists/${playlistId}/tracks`, { uris }),
    );
  }

  async addToLikedSongs(trackIds: string[]): Promise<void> {
    await this.write("addToLikedSongs", null, trackIds, () =>
      this.put("/me/tracks", { ids: trackIds }),
    );
  }

  /** In non-live modes returns a placeholder id so callers can continue. */
  async createPlaylist(params: {
    name: string;
    public?: boolean;
    description?: string;
  }): Promise<CreatePlaylistResponse> {
    let created: CreatePlaylistResponse = { id: `would-create:${params.name}` };
    await this.write("createPlaylist", null, [params.name], async () => {
      created = await this.post<CreatePlaylistResponse>("/me/playlists", {
        name: params.name,
        public: params.public ?? false,
        description: params.description ?? "",
      });
    });
    return created;
  }

  async unfollowPlaylist(playlistId: string): Promise<void> {
    await this.write("unfollowPlaylist", playlistId, [], () =>
      this.delete(`/playlists/${playlistId}/followers`),
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
