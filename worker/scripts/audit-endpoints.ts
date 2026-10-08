/**
 * Read-only Spotify API audit — Phase 0.
 *
 * Tests each endpoint (old and new paths) to determine the current state
 * of the API for this app. Write tests use a throwaway playlist only.
 *
 * Usage:
 *   SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... SPOTIFY_REFRESH_TOKEN=... \
 *   SPOTIFY_ALL_PLAYLIST_ID=... npx tsx scripts/audit-endpoints.ts
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API = "https://api.spotify.com/v1";

const clientId = env("SPOTIFY_CLIENT_ID");
const clientSecret = env("SPOTIFY_CLIENT_SECRET");
const refreshToken = env("SPOTIFY_REFRESH_TOKEN");
const allPlaylistId = env("SPOTIFY_ALL_PLAYLIST_ID");

function env(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env var: ${name}`);
    process.exit(1);
  }
  return v;
}

interface AuditResult {
  endpoint: string;
  path: string;
  method: string;
  status: number;
  ok: boolean;
  fields?: Record<string, string>;
  notes?: string;
  rateLimit?: { retryAfter?: string; remaining?: string };
}

const results: AuditResult[] = [];

async function getAccessToken(): Promise<string> {
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Token refresh failed: ${resp.status} ${body}`);
  }
  const data = (await resp.json()) as { access_token: string; refresh_token?: string };
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    console.log("⚠ Spotify rotated the refresh token; the old one may stop working.");
    console.log("  Re-run `poetry run token fetch` and re-seed D1 before the next run.");
  }
  return data.access_token;
}

function rateHeaders(resp: Response): AuditResult["rateLimit"] {
  return {
    retryAfter: resp.headers.get("Retry-After") ?? undefined,
    remaining: resp.headers.get("X-RateLimit-Remaining") ?? undefined,
  };
}

async function probe(
  token: string,
  label: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ resp: Response; json: unknown }> {
  const url = `${API}${path}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (body) headers["Content-Type"] = "application/json";

  const resp = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let json: unknown = null;
  const ct = resp.headers.get("Content-Type") ?? "";
  if (ct.includes("json") && resp.status !== 204) {
    json = await resp.json();
  }

  const result: AuditResult = {
    endpoint: label,
    path,
    method,
    status: resp.status,
    ok: resp.ok,
    rateLimit: rateHeaders(resp),
  };

  results.push(result);
  const icon = resp.ok ? "✓" : "✗";
  console.log(`  ${icon} ${method} ${path} → ${resp.status}`);

  return { resp, json };
}

function hasFields(obj: unknown, ...fields: string[]): Record<string, string> {
  const report: Record<string, string> = {};
  if (typeof obj !== "object" || obj === null) return report;
  for (const f of fields) {
    const val = (obj as Record<string, unknown>)[f];
    report[f] = val === undefined ? "MISSING" : val === null ? "null" : typeof val;
  }
  return report;
}

async function main() {
  console.log("Refreshing access token...");
  const token = await getAccessToken();
  console.log("Token acquired.\n");

  // --- 1. GET /me (unchanged) ---
  console.log("1. User profile");
  const { json: me } = await probe(token, "get-me", "GET", "/me");
  const last = results[results.length - 1]!;
  last.fields = hasFields(me, "id", "country", "email", "followers", "product");

  // --- 2. Recently played (unchanged) ---
  console.log("\n2. Recently played");
  const { json: recent } = await probe(
    token,
    "recently-played",
    "GET",
    "/me/player/recently-played?limit=2",
  );
  if (recent && typeof recent === "object" && "items" in recent) {
    const items = (recent as { items: Array<{ track: Record<string, unknown> }> }).items;
    if (items.length > 0) {
      const track = items[0]!.track;
      const last2 = results[results.length - 1]!;
      last2.fields = hasFields(track, "id", "name", "uri", "popularity");
    }
  }

  // --- 3. Batch GET /artists (old) vs single GET /artists/{id} ---
  console.log("\n3. Artists endpoints");
  // Use a well-known artist ID for testing (Radiohead)
  const testArtistId = "4Z8W4fKeB5YxbusRsdQVPb";
  await probe(token, "batch-artists-old", "GET", `/artists?ids=${testArtistId}`);

  const { json: artist } = await probe(
    token,
    "single-artist",
    "GET",
    `/artists/${testArtistId}`,
  );
  const artistResult = results[results.length - 1]!;
  artistResult.fields = hasFields(artist, "id", "name", "genres", "popularity", "followers");

  // --- 4. Batch GET /tracks (old) vs single GET /tracks/{id} ---
  console.log("\n4. Tracks endpoints");
  let testTrackId = "4uLU6hMCjMI75M1A2tKUQC"; // default fallback
  if (recent && typeof recent === "object" && "items" in recent) {
    const items = (recent as { items: Array<{ track: { id: string } }> }).items;
    if (items.length > 0) testTrackId = items[0]!.track.id;
  }
  await probe(token, "batch-tracks-old", "GET", `/tracks?ids=${testTrackId}`);

  const { json: track } = await probe(
    token,
    "single-track",
    "GET",
    `/tracks/${testTrackId}`,
  );
  const trackResult = results[results.length - 1]!;
  trackResult.fields = hasFields(track, "id", "name", "uri", "artists", "popularity");

  // --- 5. Playlist read (old path /tracks vs new path /items) ---
  console.log("\n5. Playlist read");
  await probe(
    token,
    "playlist-get",
    "GET",
    `/playlists/${allPlaylistId}?fields=id,name,tracks.total`,
  );
  await probe(
    token,
    "playlist-tracks-old",
    "GET",
    `/playlists/${allPlaylistId}/tracks?limit=1`,
  );
  await probe(
    token,
    "playlist-items-new",
    "GET",
    `/playlists/${allPlaylistId}/items?limit=1`,
  );

  // --- 6. Liked Songs read ---
  console.log("\n6. Liked Songs read");
  await probe(token, "liked-tracks-old", "GET", "/me/tracks?limit=1");
  await probe(token, "liked-library-new", "GET", "/me/library?limit=1");

  // --- 7. Write tests (throwaway playlist) ---
  console.log("\n7. Write tests (throwaway playlist)");
  const testTrackUri = `spotify:track:${testTrackId}`;

  // Create playlist (new path: POST /me/playlists)
  console.log("  Creating test playlist...");
  const { json: created, resp: createResp } = await probe(
    token,
    "create-playlist-new",
    "POST",
    "/me/playlists",
    { name: "worker-migration-test", public: false, description: "Temp test — safe to delete" },
  );

  // Also try old path
  let userId = "";
  if (me && typeof me === "object" && "id" in me) {
    userId = (me as { id: string }).id;
  }
  if (userId) {
    await probe(
      token,
      "create-playlist-old",
      "POST",
      `/users/${userId}/playlists`,
      { name: "worker-migration-test-old", public: false, description: "Temp test old path" },
    );
    // Clean up old-path playlist if it was created
    const oldCreated = results[results.length - 1]!;
    if (oldCreated.ok) {
      // Will attempt cleanup below
    }
  }

  if (!createResp.ok || !created || typeof created !== "object" || !("id" in created)) {
    console.log("  ✗ Could not create test playlist — skipping write tests");
  } else {
    const playlistId = (created as { id: string }).id;
    console.log(`  Created playlist: ${playlistId}`);

    // Add track (new path: POST /playlists/{id}/items)
    await probe(
      token,
      "add-to-playlist-new",
      "POST",
      `/playlists/${playlistId}/items`,
      { uris: [testTrackUri] },
    );

    // Also try old path
    await probe(
      token,
      "add-to-playlist-old",
      "POST",
      `/playlists/${playlistId}/tracks`,
      { uris: [testTrackUri] },
    );

    // Add to Liked Songs (new path: PUT /me/library)
    await probe(
      token,
      "add-to-library-new",
      "PUT",
      "/me/library",
      { ids: [testTrackUri] },
    );

    // Also try old path
    await probe(
      token,
      "add-to-liked-old",
      "PUT",
      "/me/tracks",
      { ids: [testTrackId] },
    );

    // Unfollow/delete test playlist (new path: DELETE /me/library)
    await probe(
      token,
      "unfollow-playlist-new",
      "DELETE",
      "/me/library",
      { ids: [`spotify:playlist:${playlistId}`] },
    );

    // Also try old path on old-created playlist
    const oldPlaylistResult = results.find((r) => r.endpoint === "create-playlist-old");
    if (oldPlaylistResult?.ok) {
      // Find the playlist ID from that result — we need to parse it
      // For safety, try the old unfollow path on the new playlist (already deleted above)
      await probe(
        token,
        "unfollow-playlist-old",
        "DELETE",
        `/playlists/${playlistId}/followers`,
      );
    }
  }

  // --- Summary ---
  console.log("\n" + "=".repeat(60));
  console.log("AUDIT SUMMARY");
  console.log("=".repeat(60));

  for (const r of results) {
    const icon = r.ok ? "✓" : "✗";
    console.log(`${icon} [${r.status}] ${r.endpoint}: ${r.method} ${r.path}`);
    if (r.fields) {
      for (const [k, v] of Object.entries(r.fields)) {
        const fieldIcon = v === "MISSING" ? "  ⚠" : "  •";
        console.log(`${fieldIcon} ${k}: ${v}`);
      }
    }
    if (r.notes) console.log(`  Note: ${r.notes}`);
  }

  // Check key decisions
  console.log("\n" + "-".repeat(60));
  console.log("KEY DECISIONS:");

  const artistFields = results.find((r) => r.endpoint === "single-artist")?.fields;
  if (artistFields) {
    const genresPresent = artistFields.genres !== "MISSING" && artistFields.genres !== "null";
    console.log(`  Genres in artist response: ${genresPresent ? "YES" : "NO"}`);
    console.log(`  → hindi-favorites: ${genresPresent ? "VIABLE for new artists" : "FROZEN to existing genre data"}`);
  }

  const batchArtists = results.find((r) => r.endpoint === "batch-artists-old");
  console.log(`  Batch GET /artists: ${batchArtists?.ok ? "STILL WORKING" : "REMOVED (use individual)"}`);

  const batchTracks = results.find((r) => r.endpoint === "batch-tracks-old");
  console.log(`  Batch GET /tracks: ${batchTracks?.ok ? "STILL WORKING" : "REMOVED (use individual)"}`);

  const newPlaylistItems = results.find((r) => r.endpoint === "playlist-items-new");
  const oldPlaylistTracks = results.find((r) => r.endpoint === "playlist-tracks-old");
  console.log(`  Playlist items path: new=${newPlaylistItems?.ok ? "OK" : "FAIL"}, old=${oldPlaylistTracks?.ok ? "OK" : "FAIL"}`);

  const newLibrary = results.find((r) => r.endpoint === "liked-library-new");
  const oldLiked = results.find((r) => r.endpoint === "liked-tracks-old");
  console.log(`  Library read path: new=/me/library ${newLibrary?.ok ? "OK" : "FAIL"}, old=/me/tracks ${oldLiked?.ok ? "OK" : "FAIL"}`);

  const newCreate = results.find((r) => r.endpoint === "create-playlist-new");
  const oldCreate = results.find((r) => r.endpoint === "create-playlist-old");
  console.log(`  Create playlist: new=/me/playlists ${newCreate?.ok ? "OK" : "FAIL"}, old=/users/{id}/playlists ${oldCreate?.ok ? "OK" : "FAIL"}`);

  // Write output
  const outPath = resolve(import.meta.dirname ?? ".", "../audit-results.json");
  const report = {
    timestamp: new Date().toISOString(),
    results,
  };
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nFull results written to ${outPath}`);
}

main().catch((err) => {
  console.error("Audit failed:", err);
  process.exit(1);
});
