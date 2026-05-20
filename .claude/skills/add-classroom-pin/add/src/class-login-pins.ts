/**
 * Email-PIN 2FA on class-token URLs.
 *
 * When a student opens a class-token URL on a fresh device (no valid
 * playground cookie), the redeemer hands off to this module to:
 *   1. Mint a 6-digit PIN, store its scrypt hash with TTL, send via Resend
 *   2. Redirect the student to /login/pin?p=<pendingId> (entry form)
 *   3. On PIN entry, verify against the hash, mint the playground session
 *
 * Cookie-bearing returning visitors skip the PIN dance entirely — the
 * redeemer detects the existing session up-front and returns it directly.
 *
 * PIN policy:
 *   - 6 random digits (10^6 = 1M space)
 *   - 10-minute TTL
 *   - 3 verify attempts before lockout
 *   - Single-use (used_at marker after first successful verify)
 *   - scrypt-hashed at rest (constant-time comparison via timingSafeEqual)
 *
 * Lives on the `classroom` branch. Installed by `/add-classroom-pin`.
 */
import crypto from 'crypto';

import { getDb } from './db/connection.js';
import { log } from './log.js';

const PIN_LENGTH = 6;
const PIN_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS = 3;
const SCRYPT_KEY_LEN = 32;
const SCRYPT_N = 16384; // CPU cost; 2^14 — fast enough for a 6-digit PIN, slow enough to deter brute force

export interface ClassLoginPinRow {
  id: string;
  token: string;
  email: string;
  user_id: string;
  pin_hash: string;
  pin_salt: string;
  expires_at: string;
  attempts: number;
  used_at: string | null;
  created_at: string;
}

export type IssuePinResult =
  | { ok: true; pendingId: string; pin: string }
  | { ok: false; reason: 'unknown-token' | 'token-revoked' };

export type VerifyPinResult =
  | { ok: true; userId: string }
  | { ok: false; reason: 'unknown-pending' | 'expired' | 'used' | 'wrong-pin' | 'rate-limited' };

function randomDigits(n: number): string {
  // crypto-quality random digits (avoids Math.random's predictability).
  const bytes = crypto.randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += String(bytes[i]! % 10);
  return out;
}

function newPendingId(): string {
  return crypto.randomBytes(16).toString('hex'); // 32-char hex → 128 bits
}

function hashPin(pin: string, salt: Buffer): Buffer {
  return crypto.scryptSync(pin, salt, SCRYPT_KEY_LEN, { N: SCRYPT_N });
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Mint a PIN for a class-token redemption attempt.
 *
 * Returns the PIN itself (caller emails it to the student) plus a pendingId
 * that the entry form references. The PIN is NOT persisted in plaintext —
 * only its scrypt hash is stored.
 *
 * Caller is responsible for: looking up the user_id + email from the token
 * (via class_login_tokens + classroom_roster), and for actually delivering
 * the PIN by email.
 */
export function issuePin(token: string, userId: string, email: string): IssuePinResult {
  const db = getDb();
  // Verify token is active (not revoked).
  const tokenRow = db
    .prepare('SELECT user_id, revoked_at FROM class_login_tokens WHERE token = ?')
    .get(token) as { user_id: string; revoked_at: string | null } | undefined;
  if (!tokenRow) return { ok: false, reason: 'unknown-token' };
  if (tokenRow.revoked_at !== null) return { ok: false, reason: 'token-revoked' };

  const pin = randomDigits(PIN_LENGTH);
  const salt = crypto.randomBytes(16);
  const hash = hashPin(pin, salt);
  const pendingId = newPendingId();
  const expiresAt = new Date(Date.now() + PIN_TTL_MS).toISOString();

  db.prepare(
    `INSERT INTO class_login_pins (id, token, email, user_id, pin_hash, pin_salt, expires_at, attempts, used_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
  ).run(pendingId, token, email, userId, hash.toString('hex'), salt.toString('hex'), expiresAt, nowIso());

  log.info('class-login-pins: PIN issued', { pendingId, userIdHash: hashId(userId), expiresAt });
  return { ok: true, pendingId, pin };
}

/**
 * Verify a PIN entered by a student. On success returns the userId so the
 * caller (HTTP handler) can mint the playground session via mintSessionForUser.
 *
 * Side effects:
 *   - Increments attempts on every call (whether match or not)
 *   - Marks used_at on successful match (single-use)
 *   - Returns rate-limited if attempts already maxed before this call
 */
export function verifyPin(pendingId: string, candidatePin: string): VerifyPinResult {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, user_id, pin_hash, pin_salt, expires_at, attempts, used_at
         FROM class_login_pins WHERE id = ?`,
    )
    .get(pendingId) as Omit<ClassLoginPinRow, 'token' | 'email' | 'created_at'> | undefined;
  if (!row) return { ok: false, reason: 'unknown-pending' };
  if (row.used_at !== null) return { ok: false, reason: 'used' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'rate-limited' };

  // Increment attempts atomically before checking the hash.
  db.prepare('UPDATE class_login_pins SET attempts = attempts + 1 WHERE id = ?').run(pendingId);

  const candidateHash = hashPin(candidatePin, Buffer.from(row.pin_salt, 'hex'));
  const storedHash = Buffer.from(row.pin_hash, 'hex');
  if (candidateHash.length !== storedHash.length || !crypto.timingSafeEqual(candidateHash, storedHash)) {
    log.info('class-login-pins: wrong PIN', { pendingId, attempts: row.attempts + 1 });
    return { ok: false, reason: 'wrong-pin' };
  }

  // Match — mark used.
  db.prepare('UPDATE class_login_pins SET used_at = ? WHERE id = ?').run(nowIso(), pendingId);
  log.info('class-login-pins: PIN verified', { pendingId, userIdHash: hashId(row.user_id) });
  return { ok: true, userId: row.user_id };
}

/**
 * Look up the email + token + user for a pendingId. HTTP layer uses this to
 * decide where to redirect after verify (back to the cookie + /playground/
 * 302 the original redeemer would have done).
 */
export function getPending(pendingId: string): { email: string; userId: string; token: string } | null {
  const db = getDb();
  const row = db
    .prepare('SELECT email, user_id, token FROM class_login_pins WHERE id = ?')
    .get(pendingId) as { email: string; user_id: string; token: string } | undefined;
  if (!row) return null;
  return { email: row.email, userId: row.user_id, token: row.token };
}

/**
 * Sweep expired/used PINs from the table. Call periodically (e.g. host-sweep).
 * Returns the number of rows deleted.
 */
export function sweepExpiredPins(): number {
  const db = getDb();
  const result = db
    .prepare(
      `DELETE FROM class_login_pins
         WHERE expires_at < ? OR used_at IS NOT NULL`,
    )
    .run(new Date(Date.now() - 60 * 60 * 1000).toISOString()); // keep used rows for 1h for log correlation
  return result.changes;
}

// Don't log raw user IDs (which embed channel handles); hash for privacy.
function hashId(userId: string): string {
  return crypto.createHash('sha256').update(userId).digest('hex').slice(0, 12);
}
