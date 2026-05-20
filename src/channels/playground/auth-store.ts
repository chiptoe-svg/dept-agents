/**
 * Multi-user playground session store.
 *
 * Two short-lived token maps drive the auth flow:
 *   - `pendingMagicTokens` — minted by /playground (Telegram) or by an
 *     OAuth callback. Single-use, 5-minute TTL via `TtlMap`. Consumed
 *     by /auth?key=<token>, which mints a fresh cookie + session row.
 *   - `sessions` — one row per authenticated browser cookie. Multiple
 *     concurrent users get multiple rows; revocation is per-cookie or
 *     per-user, never the global single-cookie wipe the v1 store did.
 *
 * Side-effect coupling with SSE clients is via `onSessionRevoked` /
 * `onAllSessionsCleared` hooks. `sse.ts` registers itself at import
 * time so revocation here transparently closes the right streams
 * without auth-store needing to know what an SSE client is.
 *
 * Idle sweep runs on a 1-min timer (started by `startIdleSweep`,
 * stopped by `stopIdleSweep`). Sweeps both maps so neither grows
 * unbounded under mint-without-consume traffic.
 */
import crypto from 'crypto';

import { PLAYGROUND_IDLE_MS } from '../../config.js';
import { log } from '../../log.js';
import { TtlMap } from './ttl-map.js';

export const COOKIE_NAME = 'nc_playground';
/**
 * Magic-link tokens stay valid for 1 hour after mint and are reusable
 * within that window — the user can re-open or share the link with
 * themselves on another device without going back to /playground for
 * a fresh one. Each consumption still mints a *new* session cookie,
 * so revoking one device doesn't kick the others.
 */
const MAGIC_TOKEN_TTL_MS = 60 * 60 * 1000;
const IDLE_SWEEP_INTERVAL_MS = 60 * 1000;
const SESSION_COOKIE_MAX_AGE_S = 7 * 24 * 60 * 60;

interface PendingMagicToken {
  userId: string | null; // who issued the link (e.g. "telegram:42"); null = anonymous
}

export interface PlaygroundSession {
  cookieValue: string;
  userId: string | null;
  createdAt: number;
  lastActivityAt: number;
}

const pendingMagicTokens = new TtlMap<string, PendingMagicToken>(MAGIC_TOKEN_TTL_MS);
const sessions = new Map<string /*cookieValue*/, PlaygroundSession>();

let idleSweepTimer: NodeJS.Timeout | null = null;

// ── Revocation hooks (decouple from SSE module) ─────────────────────────

type SessionRevokedHandler = (cookieValue: string) => void;
type AllSessionsClearedHandler = () => void;

const sessionRevokedHooks: SessionRevokedHandler[] = [];
const allClearedHooks: AllSessionsClearedHandler[] = [];

/** Register a callback fired whenever a single session is revoked. */
export function onSessionRevoked(handler: SessionRevokedHandler): void {
  sessionRevokedHooks.push(handler);
}

/** Register a callback fired whenever all sessions are cleared. */
export function onAllSessionsCleared(handler: AllSessionsClearedHandler): void {
  allClearedHooks.push(handler);
}

function notifyRevoked(cookieValue: string): void {
  for (const h of sessionRevokedHooks) {
    try {
      h(cookieValue);
    } catch (err) {
      log.warn('session-revoked handler threw', { err });
    }
  }
}

function notifyAllCleared(): void {
  for (const h of allClearedHooks) {
    try {
      h();
    } catch (err) {
      log.warn('all-sessions-cleared handler threw', { err });
    }
  }
}

// ── Magic-link flow ─────────────────────────────────────────────────────

export function mintMagicToken(userId: string | null = null): string {
  const token = crypto.randomBytes(24).toString('base64url');
  pendingMagicTokens.set(token, { userId });
  return token;
}

export function createSessionFromMagicToken(token: string): PlaygroundSession | null {
  // peek (not take) so the same magic link can mint a fresh session
  // every time within its TTL window. Each call yields a new cookie.
  const entry = pendingMagicTokens.peek(token);
  if (!entry) return null;
  return mintSessionForUser(entry.userId);
}

/**
 * Direct path to a fresh session for an already-authenticated user.
 * Used by Phase 2's Google OAuth callback — Google has already proved
 * the user's identity, so no magic-token round-trip is needed.
 */
export function mintSessionForUser(userId: string | null): PlaygroundSession {
  const cookieValue = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  const session: PlaygroundSession = {
    cookieValue,
    userId,
    createdAt: now,
    lastActivityAt: now,
  };
  sessions.set(cookieValue, session);
  return session;
}

/** Format the `Set-Cookie` header value for a freshly-minted session. */
export function formatSessionCookie(cookieValue: string): string {
  return `${COOKIE_NAME}=${cookieValue}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_COOKIE_MAX_AGE_S}`;
}

// ── Session lookup + revocation ─────────────────────────────────────────

/**
 * Look up a session by cookie. Returns null on unknown cookie or idle
 * expiry; bumps `lastActivityAt` on success. Map lookup is O(1) keyed
 * on the cookie value, so there's no per-byte timing oracle across
 * known cookies.
 */
export function getSessionByCookie(cookieValue: string): PlaygroundSession | null {
  const session = sessions.get(cookieValue);
  if (!session) return null;
  if (Date.now() - session.lastActivityAt > PLAYGROUND_IDLE_MS) {
    revokeSession(session.cookieValue, 'idle');
    return null;
  }
  session.lastActivityAt = Date.now();
  return session;
}

export function revokeSession(cookieValue: string, reason: string): boolean {
  const session = sessions.get(cookieValue);
  if (!session) return false;
  sessions.delete(cookieValue);
  notifyRevoked(cookieValue);
  log.info('Playground session revoked', { userId: session.userId, reason });
  return true;
}

export function revokeSessionsForUser(userId: string): number {
  let count = 0;
  for (const [cookieValue, session] of sessions) {
    if (session.userId !== userId) continue;
    sessions.delete(cookieValue);
    notifyRevoked(cookieValue);
    count += 1;
  }
  if (count > 0) log.info('Playground sessions revoked for user', { userId, count });
  return count;
}

export function revokeAllSessions(reason: string): void {
  const count = sessions.size;
  sessions.clear();
  pendingMagicTokens.clear();
  notifyAllCleared();
  if (count > 0) log.info('Playground sessions cleared', { count, reason });
}

// ── Idle sweep ──────────────────────────────────────────────────────────

/**
 * Drop sessions past PLAYGROUND_IDLE_MS and any expired magic tokens.
 * Called on a timer while the server runs; also exported for tests.
 */
export function sweepIdleSessions(now: number = Date.now()): number {
  let dropped = 0;
  for (const [cookieValue, session] of sessions) {
    if (now - session.lastActivityAt > PLAYGROUND_IDLE_MS) {
      sessions.delete(cookieValue);
      notifyRevoked(cookieValue);
      dropped += 1;
    }
  }
  // Also sweep pending magic tokens so the map stays bounded under
  // mint-without-consume traffic.
  pendingMagicTokens.sweep(now);
  if (dropped > 0) log.info('Playground idle sweep', { dropped });
  return dropped;
}

export function startIdleSweep(): void {
  if (idleSweepTimer) return;
  idleSweepTimer = setInterval(() => sweepIdleSessions(), IDLE_SWEEP_INTERVAL_MS);
  idleSweepTimer.unref?.();
}

export function stopIdleSweep(): void {
  if (!idleSweepTimer) return;
  clearInterval(idleSweepTimer);
  idleSweepTimer = null;
}

// ── Test hooks ──────────────────────────────────────────────────────────

/** Wipe in-memory session + token state. Tests only. */
export function _resetSessionsForTest(): void {
  sessions.clear();
  pendingMagicTokens.clear();
  stopIdleSweep();
  // Don't clear hook lists — they're set up at module init time and
  // tests that depend on those (sse close on revoke) would silently
  // break otherwise.
}

/** Force a session's lastActivityAt for idle-expiry tests. */
export function _setSessionActivityForTest(cookieValue: string, lastActivityAt: number): void {
  const session = sessions.get(cookieValue);
  if (session) session.lastActivityAt = lastActivityAt;
}

/** Inspect session count for tests. */
export function _sessionCountForTest(): number {
  return sessions.size;
}

/** Check whether a cookie still maps to a session (without bumping activity). */
export function _hasSessionForTest(cookieValue: string): boolean {
  return sessions.has(cookieValue);
}

/**
 * Extension hook — lets a classroom-installed module register a
 * persistent-token redeemer that consults its own token table (e.g.,
 * class_login_tokens) and returns a fresh session for a matched
 * student. Used by the `GET /?token=...` public route in server.ts.
 *
 * Default null — when nothing is registered, the route falls through to
 * the normal /login redirect. Extension-installed in trunk by
 * /add-classroom from the classroom branch; trunk itself doesn't know
 * about class tokens.
 */
type ClassTokenRedeemer = (token: string) => PlaygroundSession | null;
let classTokenRedeemer: ClassTokenRedeemer | null = null;

export function registerClassTokenRedeemer(fn: ClassTokenRedeemer): void {
  classTokenRedeemer = fn;
}

export function redeemClassToken(token: string): PlaygroundSession | null {
  if (!classTokenRedeemer) return null;
  return classTokenRedeemer(token);
}

/** Test hook — clear any registered class-token redeemer. */
export function _resetClassTokenRedeemerForTest(): void {
  classTokenRedeemer = null;
}

// >>> classroom-pin:hook START — installed by /add-classroom-pin
/**
 * When true, the class-token redeemer in server.ts redirects to
 * /login/pin?token=... instead of minting a cookie immediately, gating
 * first-device sign-in behind an email-delivered 6-digit PIN.
 * Toggled at host startup by the classroom module's bootstrap.
 */
let pinRequiredForClassToken = false;
export function setPinRequiredForClassToken(required: boolean): void {
  pinRequiredForClassToken = required;
}
export function isPinRequiredForClassToken(): boolean {
  return pinRequiredForClassToken;
}
// <<< classroom-pin:hook END

/**
 * Lost-link recovery — extension hook. When a student forgets their
 * bookmarked `?token=...` URL, they enter their email on the /login
 * page and the registered recoverer rotates their token + emails the
 * fresh URL. Trunk doesn't know how to send mail or look up roster
 * entries; the classroom branch registers an implementation at install
 * time. When no recoverer is registered, the /login/recover route
 * returns the "contact your instructor" fallback.
 *
 * The recoverer must be careful not to leak whether the email was
 * found — same response shape on hit and miss.
 */
export type LostLinkRecoverer = (email: string) => Promise<void>;
let lostLinkRecoverer: LostLinkRecoverer | null = null;

export function registerLostLinkRecoverer(fn: LostLinkRecoverer): void {
  lostLinkRecoverer = fn;
}

export function hasLostLinkRecoverer(): boolean {
  return lostLinkRecoverer !== null;
}

export async function recoverLostLink(email: string): Promise<void> {
  if (!lostLinkRecoverer) return;
  await lostLinkRecoverer(email);
}

/** Test hook — clear any registered lost-link recoverer. */
export function _resetLostLinkRecovererForTest(): void {
  lostLinkRecoverer = null;
}
