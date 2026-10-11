// Claim-on-first-use. While the instance has no owner, the
// 10-minute cron emails a single-use setup link to ALERT_EMAIL_TO, the send_email binding's
// verified destination, so only the person who deployed the instance can claim it. Links expire
// after 7 days; automatic sends stop after 3, and the landing page's resend is limited to once an
// hour and 5 a day. State: `claim` = {nonce, expires, sentAt, autoSends, resends: {day, count}}.
// Every send first reserves itself by swapping the stored claim atomically (compare-and-set on the
// raw value), so parallel requests or overlapping crons can't get past the limits.

import { localTime, sendEmail } from "../alerts";
import { logActivity } from "../activity";
import { getState } from "../db/state";
import type { Env } from "../env";
import { claimEmail } from "../emails/account";
import { emailConfig, quietly } from "../runtime";
import { constantTimeEqual, randomHex } from "../utils/crypto";
import { canLogIn, publicOrigin } from "./oauth";
import { getOwner } from "./owner";

export const CLAIM_KEY = "claim";
export const CLAIM_TTL_MS = 7 * 86_400_000;
export const MAX_AUTO_SENDS = 3;
export const RESEND_COOLDOWN_MS = 3_600_000;
export const MAX_RESENDS_PER_DAY = 5;
/** A resend reuses the current link while it has more than this left. */
const REUSE_MIN_REMAINING_MS = 86_400_000;
const HEX64 = /^[0-9a-f]{64}$/;

export type ClaimEmailResult = "owned" | "unconfigured" | "pending" | "sent" | "failed";

export interface Claim {
  nonce: string;
  /** Epoch ms. */
  expires: number;
  /** When the current link was last emailed, epoch ms. */
  sentAt: number;
  /** Links sent by the cron so far (it stops at MAX_AUTO_SENDS). */
  autoSends: number;
  /** Manual resends on `day` (UTC, YYYY-MM-DD). */
  resends: { day: string; count: number };
}

export async function readClaim(db: D1Database): Promise<Claim | null> {
  return (await loadClaim(db)).claim;
}

/** The stored claim and its raw value (the compare-and-set key for reserveClaim). */
async function loadClaim(db: D1Database): Promise<{ raw: string | null; claim: Claim | null }> {
  const raw = await getState(db, CLAIM_KEY);
  return { raw, claim: raw ? parseClaim(raw) : null };
}

function parseClaim(raw: string): Claim | null {
  try {
    const c = JSON.parse(raw) as Partial<Claim>;
    if (typeof c.nonce !== "string" || typeof c.expires !== "number") return null;
    return {
      nonce: c.nonce,
      expires: c.expires,
      sentAt: typeof c.sentAt === "number" ? c.sentAt : 0,
      autoSends: typeof c.autoSends === "number" ? c.autoSends : 0,
      resends: c.resends && typeof c.resends.day === "string" && typeof c.resends.count === "number" ? c.resends : { day: "", count: 0 },
    };
  } catch {
    return null;
  }
}

/** Whether `nonce` is the current, unexpired setup link (constant-time). */
export async function isValidClaimNonce(db: D1Database, nonce: string | null | undefined, now = Date.now()): Promise<boolean> {
  if (!nonce || !HEX64.test(nonce)) return false;
  const claim = await readClaim(db);
  return !!claim && claim.expires > now && (await constantTimeEqual(nonce, claim.nonce));
}

/**
 * Everything a setup link needs to work and be delivered: the email binding and addresses, the
 * public URL (to come back to) and the Spotify app's credentials. Without them no link is sent.
 */
export const canSendClaim = (env: Env): boolean => !!env.ALERT_EMAIL && !!env.ALERT_FROM && !!env.ALERT_EMAIL_TO && canLogIn(env);

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Emails a link with `nonce`; true when the binding accepted it. */
async function sendClaim(env: Env, nonce: string): Promise<boolean> {
  const origin = publicOrigin(env)!;
  return sendEmail(emailConfig(env), claimEmail({ publicUrl: origin, link: `${origin}/claim?k=${nonce}` }));
}

/**
 * Stores `next` only if the claim is still `prevRaw` (absent when null): exactly one of several
 * concurrent callers wins. True when this call did.
 */
async function reserveClaim(db: D1Database, prevRaw: string | null, next: string): Promise<boolean> {
  const res =
    prevRaw === null
      ? await db.prepare("INSERT INTO state (key, value, updated_at) VALUES (?1, ?2, datetime('now')) ON CONFLICT(key) DO NOTHING").bind(CLAIM_KEY, next).run()
      : await db.prepare("UPDATE state SET value = ?2, updated_at = datetime('now') WHERE key = ?1 AND value = ?3").bind(CLAIM_KEY, next, prevRaw).run();
  return res.meta.changes === 1;
}

/** Undoes a reservation whose email didn't go out (if it's still ours), so the next try can send. */
async function releaseClaim(db: D1Database, prevRaw: string | null, next: string): Promise<void> {
  if (prevRaw === null) await db.prepare("DELETE FROM state WHERE key = ?1 AND value = ?2").bind(CLAIM_KEY, next).run();
  else await db.prepare("UPDATE state SET value = ?3, updated_at = datetime('now') WHERE key = ?1 AND value = ?2").bind(CLAIM_KEY, next, prevRaw).run();
}

/** Reserve, send, and release again if the send failed. */
async function sendReserved(env: Env, db: D1Database, prevRaw: string | null, claim: Claim): Promise<"sent" | "lost" | "failed"> {
  const next = JSON.stringify(claim);
  if (!(await reserveClaim(db, prevRaw, next))) return "lost";
  if (await sendClaim(env, claim.nonce)) return "sent";
  await releaseClaim(db, prevRaw, next);
  return "failed";
}

/**
 * Called by the 10-minute sync cron: emails the single-use setup link while the instance has no
 * owner. "owned": there is one (or SPOTIFY_USER_ID pins it). "unconfigured": a link couldn't work
 * or be delivered. "pending": a link is out and unexpired, or 3 were sent already. "sent": a new
 * link went out (the claim is kept only then). "failed": sending failed; the next run retries.
 * Overlapping runs send one link: the others find it pending.
 */
export async function ensureClaimEmail(env: Env, db: D1Database, now = Date.now()): Promise<ClaimEmailResult> {
  if (await getOwner(db, env)) return "owned";
  if (!canSendClaim(env)) return "unconfigured";
  const { raw, claim: prev } = await loadClaim(db);
  if (prev && (prev.expires > now || prev.autoSends >= MAX_AUTO_SENDS)) return "pending";
  const claim: Claim = {
    nonce: randomHex(32),
    expires: now + CLAIM_TTL_MS,
    sentAt: now,
    autoSends: (prev?.autoSends ?? 0) + 1,
    resends: prev?.resends ?? { day: "", count: 0 },
  };
  const sent = await sendReserved(env, db, raw, claim);
  if (sent === "lost") return "pending"; // a parallel run is sending it
  if (sent === "failed") return "failed";
  await quietly("activity", () => logActivity(db, "email", "Sent the setup link to the owner's email", true, undefined, now));
  return "sent";
}

export type ResendResult =
  | { status: "owned" | "unconfigured" | "failed" }
  /** "sent" now, or a link was sent recently ("cooldown") or 5 times today ("limit"); sentAt is the latest send. */
  | { status: "sent" | "cooldown" | "limit"; sentAt: number };

/**
 * The landing page's "Resend" (unauthenticated, Origin-checked by the router): at most once an
 * hour and 5 times a day, only while unclaimed, and only to ALERT_EMAIL_TO. Reuses the current link
 * while it has more than a day left. Parallel requests send one email; the rest see the cooldown.
 */
export async function resendClaimEmail(env: Env, db: D1Database, now = Date.now()): Promise<ResendResult> {
  if (await getOwner(db, env)) return { status: "owned" };
  if (!canSendClaim(env)) return { status: "unconfigured" };
  const { raw, claim: prev } = await loadClaim(db);
  const today = utcDay(now);
  const sentToday = prev && prev.resends.day === today ? prev.resends.count : 0;
  if (prev && prev.sentAt && now - prev.sentAt < RESEND_COOLDOWN_MS) return { status: "cooldown", sentAt: prev.sentAt };
  if (sentToday >= MAX_RESENDS_PER_DAY) return { status: "limit", sentAt: prev!.sentAt };
  const reuse = prev && prev.expires - now > REUSE_MIN_REMAINING_MS;
  const claim: Claim = {
    nonce: reuse ? prev.nonce : randomHex(32),
    expires: reuse ? prev.expires : now + CLAIM_TTL_MS,
    sentAt: now,
    autoSends: prev?.autoSends ?? 0,
    resends: { day: today, count: sentToday + 1 },
  };
  const sent = await sendReserved(env, db, raw, claim);
  if (sent === "lost") return { status: "cooldown", sentAt: (await readClaim(db))?.sentAt ?? now }; // a parallel request sent it
  if (sent === "failed") return { status: "failed" };
  await quietly("activity", () => logActivity(db, "email", "Resent the setup link to the owner's email", true, undefined, now));
  return { status: "sent", sentAt: now };
}

/** "Sat, Oct 11, 3:20 PM PDT" in the deploy's time zone (the visitor may be elsewhere, hence the zone). */
export const sentTime = (env: Env, ms: number): string => localTime(ms, emailConfig(env).timeZone);
