/**
 * Class login tokens — long-lived per-roster URL tokens.
 *
 * Each row in `class_login_tokens` is one durable token a student can
 * bookmark. The playground's `GET /?token=...` handler (in trunk's
 * `server.ts`) looks them up via the redeemer this module registers
 * at import time, then issues a session cookie via
 * `mintSessionForUser`. Token = identity; session = authenticated
 * browser.
 *
 * Operations:
 *   - `issueClassLoginToken(userId)` — mint a fresh token, return it.
 *   - `revokeAllForUser(userId)` — mark every active token for a user
 *     as revoked. Used by rotate before issuing a fresh one.
 *   - `lookupActiveToken(token)` — find the user_id for a non-revoked
 *     token. Used by the redeemer hook.
 *   - `listTokensForUser(userId)` — used by the CLI list/rotate
 *     commands so the instructor can see the current state.
 *
 * Lives on the `classroom` branch (per rule 5). Installed by
 * `/add-classroom`; not part of trunk's baseline.
 */
import crypto from 'crypto';

import { getDb } from './db/connection.js';
import { readEnvFile } from './env.js';
import { log } from './log.js';
import {
  mintSessionForUser,
  registerClassTokenRedeemer,
  registerLostLinkRecoverer,
  setPinRequiredForClassToken,
  type PlaygroundSession,
} from './channels/playground/auth-store.js';
import { registerPinSender, registerTokenLookup } from './channels/playground/api/login-pin.js';
import { sendGmailMessage } from './gmail-send.js';

const TOKEN_BYTES = 24; // 24 bytes → 48 hex chars; ample entropy.

export interface ClassLoginTokenRow {
  token: string;
  user_id: string;
  created_at: string;
  revoked_at: string | null;
}

function randomTokenString(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * Mint a fresh token for `userId` and persist it. Returns the raw
 * token string the caller should embed in a URL.
 */
export function issueClassLoginToken(userId: string): string {
  const token = randomTokenString();
  const createdAt = new Date().toISOString();
  getDb()
    .prepare('INSERT INTO class_login_tokens (token, user_id, created_at, revoked_at) VALUES (?, ?, ?, NULL)')
    .run(token, userId, createdAt);
  return token;
}

/**
 * Mark every currently-active token for `userId` as revoked. Returns
 * the number of rows updated. Idempotent: a no-op when the user has
 * no active tokens.
 */
export function revokeAllForUser(userId: string): number {
  const revokedAt = new Date().toISOString();
  const info = getDb()
    .prepare('UPDATE class_login_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
    .run(revokedAt, userId);
  return info.changes;
}

/**
 * Resolve a raw token to its `user_id`. Returns null when the token
 * doesn't exist or has been revoked.
 */
export function lookupActiveToken(token: string): string | null {
  const row = getDb()
    .prepare('SELECT user_id FROM class_login_tokens WHERE token = ? AND revoked_at IS NULL')
    .get(token) as { user_id: string } | undefined;
  return row?.user_id ?? null;
}

/**
 * Every token (active + revoked) for a user, newest first. Used by
 * the CLI's `list` and `rotate` commands.
 */
export function listTokensForUser(userId: string): ClassLoginTokenRow[] {
  return getDb()
    .prepare(
      'SELECT token, user_id, created_at, revoked_at FROM class_login_tokens WHERE user_id = ? ORDER BY created_at DESC',
    )
    .all(userId) as ClassLoginTokenRow[];
}

/**
 * Convenience for the rotate flow: revoke any active tokens, then
 * mint a fresh one. Returns the new token.
 */
export function rotateClassLoginToken(userId: string): string {
  revokeAllForUser(userId);
  return issueClassLoginToken(userId);
}

/**
 * The redeemer registered with the playground auth-store. Called when
 * a `GET /?token=...` request comes in. Looks the token up; if active,
 * mints a session for the resolved user_id and returns it. Otherwise
 * returns null and the request falls through to the normal auth flow.
 */
function classTokenRedeemer(token: string): PlaygroundSession | null {
  let userId: string | null;
  try {
    userId = lookupActiveToken(token);
  } catch (err) {
    // DB not initialized yet (very early in startup) or other transient
    // failure — log and fall through. Better to refuse one login than to
    // crash the server.
    log.warn('class-login-tokens redeemer DB error', { err: String(err) });
    return null;
  }
  if (!userId) return null;
  log.info('Class login token redeemed', { userId });
  return mintSessionForUser(userId);
}

registerClassTokenRedeemer(classTokenRedeemer);

/**
 * Lost-link recovery — fires when a student submits their email on
 * /login. Looks them up in `classroom_roster`, rotates their token,
 * and emails the fresh URL via Resend.
 *
 * Silent on miss (no roster row, no RESEND_API_KEY, Resend API error):
 * the caller already returns a generic success response so we can't
 * leak which case happened. Just log and return.
 */
function resolveUserIdByEmail(email: string): string | null {
  const row = getDb().prepare('SELECT user_id FROM classroom_roster WHERE LOWER(email) = LOWER(?)').get(email) as
    | { user_id: string }
    | undefined;
  return row?.user_id ?? null;
}

function publicPlaygroundBaseUrl(): string {
  // Read fresh on every call: process.env first, then .env (the launchd
  // service spawns without inheriting shell .env, so the readEnvFile path
  // is what makes the value available to the running host).
  const url = process.env.PUBLIC_PLAYGROUND_URL || readEnvFile(['PUBLIC_PLAYGROUND_URL']).PUBLIC_PLAYGROUND_URL;
  return (url || 'http://localhost:3002').replace(/\/+$/, '');
}

async function sendLostLinkEmail(toEmail: string, loginUrl: string): Promise<void> {
  const env = readEnvFile(['RESEND_API_KEY', 'RESEND_FROM_ADDRESS', 'RESEND_FROM_NAME']);
  if (!env.RESEND_API_KEY) {
    log.warn('Lost-link recovery: RESEND_API_KEY not set — email not sent', { email: toEmail });
    return;
  }
  const from = env.RESEND_FROM_NAME ? `${env.RESEND_FROM_NAME} <${env.RESEND_FROM_ADDRESS}>` : env.RESEND_FROM_ADDRESS;
  if (!from) {
    log.warn('Lost-link recovery: RESEND_FROM_ADDRESS not set — email not sent', { email: toEmail });
    return;
  }
  const payload = {
    from,
    to: [toEmail],
    subject: 'Your NanoClaw login link',
    text: `Hi,\n\nHere's your fresh login link for the class playground:\n\n${loginUrl}\n\nBookmark it — this URL is your identity. If you lose it again, request another from the same page.\n\nYour previous link (if any) has been deactivated.\n`,
  };
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      log.error('Lost-link recovery: Resend API error', { status: resp.status, body: text.slice(0, 300) });
      return;
    }
    log.info('Lost-link recovery email sent', { email: toEmail });
  } catch (err) {
    log.error('Lost-link recovery: fetch failed', { err: String(err) });
  }
}

export async function recoverLostLinkForEmail(email: string): Promise<void> {
  const userId = resolveUserIdByEmail(email);
  if (!userId) {
    log.info('Lost-link recovery: no roster entry', { email });
    return;
  }
  const token = rotateClassLoginToken(userId);
  const url = `${publicPlaygroundBaseUrl()}/?token=${token}`;
  await sendLostLinkEmail(email, url);
}

registerLostLinkRecoverer(recoverLostLinkForEmail);

// --- /add-classroom-pin wiring ---
// PIN-2FA gates first-device class-token sign-ins behind an email-delivered
// 6-digit code. Token → email lookup uses the same classroom_roster join the
// lost-link recoverer uses; PIN delivery goes through the host Gmail adapter
// (src/gmail-send.ts) using the instructor's GWS account.
registerTokenLookup((token) => {
  const row = getDb()
    .prepare(
      `SELECT t.user_id, r.email
       FROM class_login_tokens t
       INNER JOIN classroom_roster r ON r.user_id = t.user_id
       WHERE t.token = ? AND t.revoked_at IS NULL`,
    )
    .get(token) as { user_id: string; email: string } | undefined;
  return row ? { userId: row.user_id, email: row.email } : null;
});

registerPinSender(async (email, pin) => {
  await sendGmailMessage({
    to: email,
    subject: 'Your sign-in code',
    body: `Your sign-in code is: ${pin}\n\nIt expires in 10 minutes. Do not share this code.`,
  });
});

setPinRequiredForClassToken(true);

// Eagerly bind the playground HTTP server at host startup so students can
// click their class-token URLs without the instructor first nudging via
// /playground on Telegram. Without this, every service restart leaves
// port 3002 unbound until manual /playground, which doesn't fit the
// classroom UX. PLAYGROUND_ENABLED still gates the call.
//
// The playground.js import is dynamic (deferred until the onHostReady
// callback fires) so we don't pull the playground module chain into
// module-init — that would force every test that mocks auth-store to
// also mock onSessionRevoked / onAllSessionsCleared / sse internals.
import { onHostReady } from './response-registry.js';
import { PLAYGROUND_ENABLED } from './config.js';

onHostReady(async () => {
  if (!PLAYGROUND_ENABLED) return;
  try {
    const { startPlaygroundServer } = await import('./channels/playground.js');
    await startPlaygroundServer();
    log.info('Classroom auto-started playground server');
  } catch (err) {
    log.error('Classroom failed to auto-start playground', { err });
  }
});
