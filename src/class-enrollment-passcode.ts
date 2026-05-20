/**
 * Class enrollment passcode — a single 4-digit code shown on the
 * instructor's Home card. Students use it (+ their roster email) to
 * claim a seat in the playground on enrollment day.
 *
 * Design decisions:
 *   - Single-row table: delete the old row on rotate, insert a new one.
 *   - Cleartext cached in a module-local Map keyed by created_at ISO string.
 *     After a host restart the cleartext is gone (the Map is empty); the
 *     instructor clicks [Rotate] to generate a fresh code. This is
 *     acceptable: enrollment is a one-shot classroom exercise, not a
 *     long-running shared secret, and storing cleartext to disk
 *     (even in data/) would widen the credential surface for little gain.
 *   - scrypt hashing mirrors class-login-pins.ts exactly (same N, key len,
 *     constant-time compare).
 */
import crypto from 'crypto';

import { getDb } from './db/connection.js';
import { log } from './log.js';

const SCRYPT_KEY_LEN = 32;
const SCRYPT_N = 16384;

interface PasscodeRow {
  id: number;
  passcode_hash: string;
  passcode_salt: string;
  created_at: string;
  rotated_by_user_id: string | null;
}

// Module-local cache: created_at → cleartext.
// The Map holds at most one entry (cleared on each rotation).
const cleartextCache = new Map<string, string>();

function nowIso(): string {
  return new Date().toISOString();
}

function hashPasscode(plain: string, salt: Buffer): Buffer {
  return crypto.scryptSync(plain, salt, SCRYPT_KEY_LEN, { N: SCRYPT_N });
}

function randomDigits(n: number): string {
  const bytes = crypto.randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += String(bytes[i]! % 10);
  return out;
}

/** Get the current passcode row from the DB (hash + metadata). */
export function getCurrentPasscode(): { passcode_hash: string; passcode_salt: string; created_at: string } | null {
  const row = getDb()
    .prepare('SELECT passcode_hash, passcode_salt, created_at FROM class_enrollment_passcodes LIMIT 1')
    .get() as Pick<PasscodeRow, 'passcode_hash' | 'passcode_salt' | 'created_at'> | undefined;
  return row ?? null;
}

/**
 * Return the current passcode in cleartext, IFF it was generated in this
 * process (cached in module-local Map). Returns null after a host restart
 * because the hash is one-way and the plaintext was never persisted.
 */
export function getCurrentPasscodeCleartext(): string | null {
  const row = getCurrentPasscode();
  if (!row) return null;
  return cleartextCache.get(row.created_at) ?? null;
}

/**
 * Generate a new 4-digit passcode, scrypt-hash it, persist to DB, and
 * cache the cleartext for this process. Returns the cleartext.
 */
export function rotatePasscode(rotatedByUserId: string | null = null): string {
  const plain = randomDigits(4);
  const salt = crypto.randomBytes(16);
  const hash = hashPasscode(plain, salt);
  const createdAt = nowIso();

  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM class_enrollment_passcodes').run();
    db.prepare(
      `INSERT INTO class_enrollment_passcodes (passcode_hash, passcode_salt, created_at, rotated_by_user_id)
       VALUES (?, ?, ?, ?)`,
    ).run(hash.toString('hex'), salt.toString('hex'), createdAt, rotatedByUserId);
  })();

  cleartextCache.clear();
  cleartextCache.set(createdAt, plain);

  log.info('class-enrollment-passcode: rotated', { createdAt, rotatedBy: rotatedByUserId });
  return plain;
}

/**
 * Constant-time verify of a candidate plaintext against the current
 * stored hash. Returns false if no passcode has been set yet.
 */
export function verifyPasscode(plain: string): boolean {
  const row = getCurrentPasscode();
  if (!row) return false;

  const salt = Buffer.from(row.passcode_salt, 'hex');
  const storedHash = Buffer.from(row.passcode_hash, 'hex');
  const candidateHash = hashPasscode(plain, salt);

  if (candidateHash.length !== storedHash.length) return false;
  return crypto.timingSafeEqual(candidateHash, storedHash);
}

/** Test hook — clear the in-memory cleartext cache. */
export function _resetCleartextCacheForTest(): void {
  cleartextCache.clear();
}
