// Shared helpers for local maintenance scripts (run with `npx tsx scripts/<name>.ts`).
// Credentials come from .dev.vars; the database is reached through `wrangler d1 execute`,
// using the generated wrangler config (see wranglerConfig below).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MIGRATIONS, migrationStatements } from "../src/db/schema";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN_RE = /^[A-Za-z0-9_-]+$/;

/**
 * The wrangler config the scripts pass to wrangler: $WRANGLER_CONFIG (another instance's
 * generated config), else wrangler.generated.toml from `npm run configure` when it exists.
 * Without either, wrangler reads the wrangler.toml template and `--db` is required.
 */
export const wranglerConfig: string | undefined = (() => {
  const explicit = process.env.WRANGLER_CONFIG;
  if (explicit) {
    if (!existsSync(resolve(ROOT, explicit))) throw new Error(`WRANGLER_CONFIG file not found: ${explicit}`);
    return explicit;
  }
  return existsSync(resolve(ROOT, "wrangler.generated.toml")) ? "wrangler.generated.toml" : undefined;
})();

/**
 * `--db <name>`, else the production database_name of the active wrangler config (the first
 * one in the file: the template puts [[d1_databases]] before [env.test]).
 */
export function targetDb(): string {
  const explicit = flag("db", "");
  if (explicit) return explicit;
  const name = wranglerConfig && readFileSync(resolve(ROOT, wranglerConfig), "utf8").match(/^database_name\s*=\s*"([^"]+)"/m)?.[1];
  if (!name) throw new Error("No database: pass --db <name>, or run `npm run configure` first");
  return name;
}

/** Parses .dev.vars (KEY=VALUE lines). */
export function devVars(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(`${ROOT}/.dev.vars`, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0 && !line.trimStart().startsWith("#")) {
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

export function requireVars(...names: string[]): Record<string, string> {
  const vars = devVars();
  const missing = names.filter((n) => !vars[n]);
  if (missing.length) throw new Error(`Missing in .dev.vars: ${missing.join(", ")}`);
  return vars;
}

/** `--name value` flag lookup. */
export function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

function wrangler(args: string[], retried = false): string {
  try {
    const config = wranglerConfig ? ["-c", wranglerConfig] : [];
    return execFileSync("npx", ["wrangler", ...args, ...config], { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    // The bare "Command failed" hides the reason; wrangler puts it on stderr, or on stdout with --json.
    const { stderr, stdout } = err as { stderr?: string; stdout?: string };
    const detail = (stderr?.trim() || stdout?.trim() || "").slice(-800);
    // The first API call after wrangler refreshes its expired OAuth token can fail with
    // 7403 ("account not valid"); the next one succeeds (seen in wrangler's logs, 2026-10-11).
    if (!retried && detail.includes("7403")) return wrangler(args, true);
    throw new Error(`wrangler ${args.slice(0, 3).join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
}

/** Runs one SQL statement against the remote database and returns its rows. */
export function d1Rows<T = Record<string, unknown>>(db: string, sql: string): T[] {
  const out = JSON.parse(wrangler(["d1", "execute", db, "--remote", "--json", "--command", sql]));
  if (!Array.isArray(out)) throw new Error(`D1 error: ${JSON.stringify(out).slice(0, 500)}`);
  return out[0].results as T[];
}

/** Runs a SQL file against the remote database (atomic per file), retrying up to 3 times. */
export function d1ExecFile(db: string, file: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      const out = wrangler(["d1", "execute", db, "--remote", "--file", file, "--yes"]);
      if (!out.includes("ERROR")) return;
      throw new Error(out.slice(-500));
    } catch (err) {
      if (attempt >= 3) throw err;
      console.warn(`  retrying ${file} (attempt ${attempt} failed)`);
    }
  }
}

/** SQL literal for a string/number/null value. */
export function lit(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** The database's schema version; 0 for a brand-new database. */
export function schemaVersion(db: string): number {
  const exists = d1Rows(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").length > 0;
  return exists ? Number(d1Rows<{ v: number | null }>(db, "SELECT MAX(version) AS v FROM schema_migrations")[0]?.v ?? 0) : 0;
}

/**
 * Applies the Worker's pending migrations (src/db/schema.ts, the same statements its migrate()
 * runs) in one atomic file, so the scripts work on a brand-new database before the first deploy.
 */
export function ensureSchema(db: string): void {
  const latest = MIGRATIONS[MIGRATIONS.length - 1]!.version;
  const pending = MIGRATIONS.filter((m) => m.version > schemaVersion(db));
  if (!pending.length) return;
  const dir = mkdtempSync(join(tmpdir(), "spotify-schema-"));
  try {
    const file = join(dir, "schema.sql");
    writeFileSync(file, pending.flatMap(migrationStatements).map((sql) => `${sql};`).join("\n") + "\n");
    d1ExecFile(db, file);
    console.log(`Applied schema v${pending.map((m) => m.version).join(", v")} to ${db}.`);
  } catch (err) {
    // A Worker job may have applied the same migrations meanwhile (v9's ALTER TABLEs aren't idempotent).
    if (schemaVersion(db) < latest) throw err;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function seedRefreshToken(db: string, token: string): void {
  if (!TOKEN_RE.test(token)) throw new Error("Unexpected characters in refresh token; not seeding");
  d1Rows(
    db,
    `INSERT INTO state(key, value, updated_at) VALUES('spotify_refresh_token', '${token}', datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`,
  );
}

/** Exchanges the database's refresh token for an access token, saving a rotated refresh token back. */
export async function accessTokenFromD1(db: string): Promise<string> {
  const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET } = requireVars("SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET");
  const refresh = d1Rows<{ value: string }>(db, "SELECT value FROM state WHERE key = 'spotify_refresh_token'")[0]?.value;
  if (!refresh) throw new Error(`No refresh token in ${db}; run: npm run token`);
  const token = await tokenRequest(SPOTIFY_CLIENT_ID!, SPOTIFY_CLIENT_SECRET!, { grant_type: "refresh_token", refresh_token: refresh });
  if (token.refresh_token && token.refresh_token !== refresh) {
    seedRefreshToken(db, token.refresh_token);
    console.log("Spotify rotated the refresh token; saved the new one to D1.");
  }
  return token.access_token;
}

export async function tokenRequest(
  clientId: string,
  clientSecret: string,
  body: Record<string, string>,
): Promise<{ access_token: string; refresh_token?: string }> {
  const resp = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body),
  });
  if (!resp.ok) throw new Error(`Spotify token request failed: ${resp.status} ${await resp.text()}`);
  return resp.json() as Promise<{ access_token: string; refresh_token?: string }>;
}

/** GET a Spotify Web API path, retrying once on 429 / 5xx. */
export async function spotifyGet<T>(accessToken: string, path: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const resp = await fetch(`https://api.spotify.com/v1${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (resp.ok) return resp.json() as Promise<T>;
    if (attempt < 3 && (resp.status === 429 || resp.status >= 500)) {
      const wait = Math.min(Number(resp.headers.get("Retry-After") ?? "2"), 30);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    throw new Error(`Spotify GET ${path} -> ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
}
