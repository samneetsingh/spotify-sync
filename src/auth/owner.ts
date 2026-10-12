// Who owns this instance. SPOTIFY_USER_ID, when set, wins
// ("config"; existing deployments keep working with no migration); otherwise the account that
// completed the emailed setup link, pinned in `state` ("claimed"). Unclaimed: null.

import { getState } from "../db/state";
import type { Env } from "../env";

export const OWNER_KEY = "owner:spotify_id";
export const OWNER_NAME_KEY = "owner:display_name";
/** Set (to an ISO time) when the owner finishes or skips the guided tour; until then every login lands on Home, where it starts. */
export const ONBOARDING_KEY = "onboarding:done";

/** The effective owner: SPOTIFY_USER_ID when set ("config"), else `state` owner:spotify_id ("claimed"). */
export interface Owner {
  id: string;
  source: "config" | "claimed";
}

/** The env override, or null when unset or blank (the template fills "" when there's none). */
export const configuredOwnerId = (env: Env): string | null => env.SPOTIFY_USER_ID?.trim() || null;

/** The effective owner, or null while the instance is unclaimed. One D1 read unless the env override is set. */
export async function getOwner(db: D1Database, env: Env): Promise<Owner | null> {
  const configured = configuredOwnerId(env);
  if (configured) return { id: configured, source: "config" };
  const claimed = await getState(db, OWNER_KEY);
  return claimed ? { id: claimed, source: "claimed" } : null;
}

/**
 * Statements that record a successful login by the owner: the new refresh token, the display name,
 * and the owner pin. Under the env override the pin is upserted, so SPOTIFY_USER_ID can later be
 * removed without the owner changing; a claimed pin is already set (and never overwritten here).
 */
export function saveLoginStatements(db: D1Database, owner: Owner, me: { id: string; displayName: string | null }, refreshToken: string): D1PreparedStatement[] {
  const upsert = (key: string, value: string) =>
    db
      .prepare("INSERT INTO state (key, value, updated_at) VALUES (?1, ?2, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .bind(key, value);
  const statements = [upsert("spotify_refresh_token", refreshToken), upsert(OWNER_NAME_KEY, me.displayName ?? me.id)];
  if (owner.source === "config") statements.push(upsert(OWNER_KEY, me.id));
  return statements;
}
