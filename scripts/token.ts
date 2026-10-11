/**
 * Spotify login: runs the OAuth flow in your browser and stores the resulting refresh
 * token in the D1 `state` table, where the Worker reads (and rotates) it. Never prints it.
 *
 * Usage: npm run token [-- --db spotify-automation-test] [--no-open]
 * Needs SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET and SPOTIFY_REDIRECT_URI in .dev.vars.
 * The redirect URI must be a loopback http URL (e.g. http://127.0.0.1:8888/callback)
 * registered in the Spotify app; Spotify rejects "localhost".
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { SPOTIFY_SCOPE } from "../src/spotify/auth";
import { DEFAULT_DB, flag, requireVars, seedRefreshToken, tokenRequest } from "./lib";

const TIMEOUT_MS = 5 * 60_000;

const db = flag("db", DEFAULT_DB);
const vars = requireVars("SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET", "SPOTIFY_REDIRECT_URI");
const redirect = new URL(vars.SPOTIFY_REDIRECT_URI!);
if (redirect.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(redirect.hostname)) {
  throw new Error("SPOTIFY_REDIRECT_URI must be http://127.0.0.1:<port>/<path> for the local login flow");
}

const state = crypto.randomUUID();
const authUrl = new URL("https://accounts.spotify.com/authorize");
authUrl.search = new URLSearchParams({
  response_type: "code",
  client_id: vars.SPOTIFY_CLIENT_ID!,
  scope: SPOTIFY_SCOPE,
  redirect_uri: redirect.href,
  state,
  show_dialog: "true",
}).toString();

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", redirect.origin);
  if (url.pathname !== redirect.pathname) {
    res.writeHead(404).end();
    return;
  }
  const finish = (status: number, message: string, exitCode: number) => {
    res.writeHead(status, { "Content-Type": "text/plain" }).end(`${message}\nYou can close this tab.`);
    console.log(message);
    server.close();
    process.exitCode = exitCode;
  };
  if (url.searchParams.get("state") !== state) return finish(400, "Login failed: state mismatch.", 1);
  const code = url.searchParams.get("code");
  if (!code) return finish(400, `Login failed: ${url.searchParams.get("error") ?? "no code returned"}.`, 1);
  try {
    const token = await tokenRequest(vars.SPOTIFY_CLIENT_ID!, vars.SPOTIFY_CLIENT_SECRET!, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect.href,
    });
    if (!token.refresh_token) throw new Error("Spotify returned no refresh token");
    seedRefreshToken(db, token.refresh_token);
    finish(200, `Login complete. Refresh token saved to D1 database "${db}".`, 0);
  } catch (err) {
    finish(500, `Login failed: ${err instanceof Error ? err.message : String(err)}`, 1);
  }
});

server.listen(Number(redirect.port || 80), redirect.hostname.replace(/^\[|\]$/g, ""), () => {
  console.log(`Opening Spotify login in your browser. If it doesn't open, visit:\n${authUrl.href}\n`);
  if (!process.argv.includes("--no-open")) {
    spawn(process.platform === "darwin" ? "open" : "xdg-open", [authUrl.href], { stdio: "ignore", detached: true }).on("error", () => {});
  }
});
setTimeout(() => {
  console.error("Timed out waiting for the Spotify login.");
  process.exit(1);
}, TIMEOUT_MS).unref();
