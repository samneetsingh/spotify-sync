import type { TokenResponse } from "./types";
import { SpotifyError } from "./errors";

const TOKEN_URL = "https://accounts.spotify.com/api/token";

export async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<TokenResponse> {
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new SpotifyError(
      `Token refresh failed: ${resp.status} ${body}`,
      resp.status,
      body,
    );
  }

  return resp.json() as Promise<TokenResponse>;
}
