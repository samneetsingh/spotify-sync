// Claim-on-first-use. While the instance has no owner, the
// 10-minute cron emails a single-use setup link to ALERT_EMAIL_TO, the send_email binding's
// verified destination, so only the person who deployed the instance can claim it. Links expire
// after 7 days; automatic sends stop after 3, and the landing page's resend is limited to once an
// hour and 5 a day. State: `claim` = {nonce, expires, sentAt, autoSends, resends: {day, count}}.

import { localTime, sendEmail } from "../alerts";
import { logActivity } from "../activity";
import { getState, setState } from "../db/state";
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
  const raw = await getState(db, CLAIM_KEY);
  if (!raw) return null;
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
 * Called by the 10-minute sync cron: emails the single-use setup link while the instance has no
 * owner. "owned": there is one (or SPOTIFY_USER_ID pins it). "unconfigured": a link couldn't work
 * or be delivered. "pending": a link is out and unexpired, or 3 were sent already. "sent": a new
 * link went out (the claim is saved only then). "failed": sending failed; the next run retries.
 */
export async function ensureClaimEmail(env: Env, db: D1Database, now = Date.now()): Promise<ClaimEmailResult> {
  if (await getOwner(db, env)) return "owned";
  if (!canSendClaim(env)) return "unconfigured";
  const prev = await readClaim(db);
  if (prev && (prev.expires > now || prev.autoSends >= MAX_AUTO_SENDS)) return "pending";
  const claim: Claim = {
    nonce: randomHex(32),
    expires: now + CLAIM_TTL_MS,
    sentAt: now,
    autoSends: (prev?.autoSends ?? 0) + 1,
    resends: prev?.resends ?? { day: "", count: 0 },
  };
  if (!(await sendClaim(env, claim.nonce))) return "failed";
  await setState(db, CLAIM_KEY, JSON.stringify(claim));
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
 * while it has more than a day left.
 */
export async function resendClaimEmail(env: Env, db: D1Database, now = Date.now()): Promise<ResendResult> {
  if (await getOwner(db, env)) return { status: "owned" };
  if (!canSendClaim(env)) return { status: "unconfigured" };
  const prev = await readClaim(db);
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
  if (!(await sendClaim(env, claim.nonce))) return { status: "failed" };
  await setState(db, CLAIM_KEY, JSON.stringify(claim));
  await quietly("activity", () => logActivity(db, "email", "Resent the setup link to the owner's email", true, undefined, now));
  return { status: "sent", sentAt: now };
}

/** "Sat, Oct 11, 3:20 PM PDT" in the deploy's time zone (the visitor may be elsewhere, hence the zone). */
export const sentTime = (env: Env, ms: number): string => localTime(ms, emailConfig(env).timeZone);
