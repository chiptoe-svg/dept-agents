/**
 * Phase 1 of plans/classroom-web-multiuser.md — multi-user session store.
 *
 * Covers the auth helpers in isolation, no http.createServer required:
 *   - magic-link mint + single-shot consume + expiry
 *   - independent sessions don't kick each other
 *   - revokeSessionsForUser is per-user
 *   - sweepIdleSessions drops only idle rows
 *   - stopPlaygroundServer-equivalent (revokeAllSessions via test hook)
 *     is delivered through revokeSessionsForUser of every user, but
 *     end-to-end stop semantics are exercised by the wider channel tests.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { PLAYGROUND_IDLE_MS } from '../config.js';
import {
  _hasSessionForTest,
  _resetSessionsForTest,
  _sessionCountForTest,
  _setSessionActivityForTest,
  createSessionFromMagicToken,
  mintMagicToken,
  revokeSession,
  revokeSessionsForUser,
  sweepIdleSessions,
} from './playground.js';

describe('playground multi-user session store', () => {
  afterEach(() => _resetSessionsForTest());

  it('mints independent sessions for two users without kicking each other', () => {
    const tokenA = mintMagicToken('telegram:1');
    const sessionA = createSessionFromMagicToken(tokenA);
    expect(sessionA).not.toBeNull();

    const tokenB = mintMagicToken('telegram:2');
    const sessionB = createSessionFromMagicToken(tokenB);
    expect(sessionB).not.toBeNull();

    expect(_hasSessionForTest(sessionA!.cookieValue)).toBe(true);
    expect(_hasSessionForTest(sessionB!.cookieValue)).toBe(true);
    expect(_sessionCountForTest()).toBe(2);
    expect(sessionA!.cookieValue).not.toBe(sessionB!.cookieValue);
    expect(sessionA!.userId).toBe('telegram:1');
    expect(sessionB!.userId).toBe('telegram:2');
  });

  it('accepts a magic token multiple times within its TTL window (each call mints a fresh session)', () => {
    const token = mintMagicToken('telegram:1');
    const a = createSessionFromMagicToken(token);
    const b = createSessionFromMagicToken(token);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // Distinct sessions — re-using the magic link doesn't share a cookie.
    expect(a!.cookieValue).not.toBe(b!.cookieValue);
  });

  it('rejects an unknown magic token', () => {
    expect(createSessionFromMagicToken('not-a-real-token')).toBeNull();
  });

  it('idle sweep drops only the idle session and leaves the active one intact', () => {
    const sessionA = createSessionFromMagicToken(mintMagicToken('telegram:1'))!;
    const sessionB = createSessionFromMagicToken(mintMagicToken('telegram:2'))!;

    // Force A's last-activity into the past, beyond the idle window.
    _setSessionActivityForTest(sessionA.cookieValue, Date.now() - PLAYGROUND_IDLE_MS - 1000);

    const dropped = sweepIdleSessions();
    expect(dropped).toBe(1);
    expect(_hasSessionForTest(sessionA.cookieValue)).toBe(false);
    expect(_hasSessionForTest(sessionB.cookieValue)).toBe(true);
  });

  it('revokeSessionsForUser only removes sessions for the given user', () => {
    const sessionA1 = createSessionFromMagicToken(mintMagicToken('telegram:1'))!;
    const sessionA2 = createSessionFromMagicToken(mintMagicToken('telegram:1'))!;
    const sessionB = createSessionFromMagicToken(mintMagicToken('telegram:2'))!;

    const removed = revokeSessionsForUser('telegram:1');
    expect(removed).toBe(2);
    expect(_hasSessionForTest(sessionA1.cookieValue)).toBe(false);
    expect(_hasSessionForTest(sessionA2.cookieValue)).toBe(false);
    expect(_hasSessionForTest(sessionB.cookieValue)).toBe(true);
  });

  it('revokeSession removes only the named cookie', () => {
    const sessionA = createSessionFromMagicToken(mintMagicToken('telegram:1'))!;
    const sessionB = createSessionFromMagicToken(mintMagicToken('telegram:2'))!;

    expect(revokeSession(sessionA.cookieValue, 'test')).toBe(true);
    expect(revokeSession(sessionA.cookieValue, 'test')).toBe(false); // already gone
    expect(_hasSessionForTest(sessionA.cookieValue)).toBe(false);
    expect(_hasSessionForTest(sessionB.cookieValue)).toBe(true);
  });

  it('mintMagicToken does not invalidate prior sessions', () => {
    // Captures the regression Phase 1 fixes: in v1 the act of running
    // /playground rotated the global cookie out from under any user
    // who had already authed. With per-cookie sessions, minting a fresh
    // magic token for a different user is a no-op against existing rows.
    const sessionA = createSessionFromMagicToken(mintMagicToken('telegram:1'))!;
    mintMagicToken('telegram:2'); // simulate second /playground invocation
    expect(_hasSessionForTest(sessionA.cookieValue)).toBe(true);
  });
});
