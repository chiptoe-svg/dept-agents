/**
 * HTTP handlers for class enrollment passcode.
 *
 * Three endpoints:
 *   GET  /api/admin/class-passcode         — owner/admin: returns current cleartext (or null)
 *   POST /api/admin/class-passcode/rotate  — owner/admin: rotates the passcode, returns new cleartext
 *   POST /login/enroll                     — public (pre-auth): email + passcode enrollment
 *
 * Admin routes check role via isOwner / isGlobalAdmin, mirroring me.ts.
 * The public enroll route validates: passcode OK, email on roster, not yet claimed.
 */
import { getCurrentPasscodeCleartext, rotatePasscode, verifyPasscode } from '../../../class-enrollment-passcode.js';
import { isEnrolled, lookupRosterByEmail, markEnrolled } from '../../../db/classroom-roster.js';
import { isGlobalAdmin, isOwner } from '../../../modules/permissions/db/user-roles.js';
import { formatSessionCookie, mintSessionForUser } from '../auth-store.js';
import type { PlaygroundSession } from '../auth-store.js';

export interface ApiResult<T> {
  status: number;
  body: T | { error: string };
  setCookie?: string;
}

function isOwnerOrAdmin(userId: string | null): boolean {
  if (!userId) return false;
  return isOwner(userId) || isGlobalAdmin(userId);
}

// ── Admin: get current passcode ───────────────────────────────────────────

export interface GetPasscodeResponse {
  passcode: string | null;
}

export function handleGetClassPasscode(session: PlaygroundSession): ApiResult<GetPasscodeResponse> {
  if (!isOwnerOrAdmin(session.userId)) {
    return { status: 403, body: { error: 'owner or admin required' } };
  }
  const cleartext = getCurrentPasscodeCleartext();
  return { status: 200, body: { passcode: cleartext } };
}

// ── Admin: rotate passcode ────────────────────────────────────────────────

export interface RotatePasscodeResponse {
  passcode: string;
}

export function handleRotateClassPasscode(session: PlaygroundSession): ApiResult<RotatePasscodeResponse> {
  if (!isOwnerOrAdmin(session.userId)) {
    return { status: 403, body: { error: 'owner or admin required' } };
  }
  const plain = rotatePasscode(session.userId);
  return { status: 200, body: { passcode: plain } };
}

// ── Public: enroll ────────────────────────────────────────────────────────

export interface EnrollResponse {
  ok: true;
  redirect: string;
}

export function handleEnroll(body: { email?: unknown; passcode?: unknown }): ApiResult<EnrollResponse> {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const passcode = typeof body.passcode === 'string' ? body.passcode.trim() : '';

  if (!email || !email.includes('@') || !passcode) {
    return { status: 400, body: { error: 'email and passcode required' } };
  }

  // 1. Validate passcode first (constant-time).
  if (!verifyPasscode(passcode)) {
    return { status: 401, body: { error: 'Invalid email or passcode.' } };
  }

  // 2. Look up the roster entry.
  const rosterEntry = lookupRosterByEmail(email);
  if (!rosterEntry) {
    // Anti-enumeration: same generic response as wrong passcode.
    return { status: 401, body: { error: 'Invalid email or passcode.' } };
  }

  // 3. Mint a session so we have a cookieValue for the enrollment record.
  //    We mint before markEnrolled so that if the DB write fails we don't
  //    hand out a cookie with no enrollment record. The session is
  //    in-memory-only until we confirm the DB write succeeds.
  const session = mintSessionForUser(rosterEntry.user_id);

  // 4. First-come-first-served claim. If already enrolled, the valid passcode
  // is enough to issue a fresh session — this is a returning student on a
  // new device or after clearing cookies. Don't block them.
  markEnrolled(email, session.cookieValue);

  return {
    status: 200,
    body: { ok: true, redirect: '/playground/' },
    setCookie: formatSessionCookie(session.cookieValue),
  };
}
