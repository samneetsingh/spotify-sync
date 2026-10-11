import type { TokenResponse } from "./types";
import { SpotifyError } from "./errors";

const TOKEN_URL = "https://accounts.spotify.com/api/token";

/** Everything the Worker does; shared by `npm run token` and the reconnect link. */
export const SPOTIFY_SCOPE = "user-read-recently-played playlist-modify-private user-library-modify user-library-read";

export function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<TokenResponse> {
  return tokenRequest(clientId, clientSecret, { grant_type: "refresh_token", refresh_token: refreshToken });
}

/** Trades an authorization code from the login redirect for tokens. */
export function exchangeCode(clientId: string, clientSecret: string, code: string, redirectUri: string): Promise<TokenResponse> {
  return tokenRequest(clientId, clientSecret, { grant_type: "authorization_code", code, redirect_uri: redirectUri });
}

async function tokenRequest(clientId: string, clientSecret: string, params: Record<string, string>): Promise<TokenResponse> {
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new SpotifyError(
      `${params.grant_type === "refresh_token" ? "Token refresh" : "Code exchange"} failed: ${resp.status} ${body}`,
      resp.status,
      body,
    );
  }

  return resp.json() as Promise<TokenResponse>;
}
