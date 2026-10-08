/// <reference types="@cloudflare/vitest-plugin/types" />

declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    SPOTIFY_CLIENT_ID: string;
    SPOTIFY_CLIENT_SECRET: string;
    SPOTIFY_ALL_PLAYLIST_ID: string;
    WRITE_MODE: string;
    SYNC_FULL_SECRET: string;
  }
}
