/**
 * Integration test: token revocation kills live playground sessions
 * (Plan 3 final-review Fix 2).
 *
 * Unlike class-login-tokens.test.ts (which mocks the auth-store), this file
 * uses the REAL auth-store so we can assert the observable security
 * property: after `revokeAllForUser` / `rotateClassLoginToken`, a session
 * cookie minted from the old token no longer authenticates —
 * `getSessionByCookie` returns null. Without the cascade, an attacker who
 * already redeemed a stolen URL keeps an in-memory session indefinitely
 * (activity bumps beat the idle sweep) even after the token row is revoked.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db/connection.js', () => ({
  getDb: vi.fn(() => testDb),
}));
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));
vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('./gmail-send.js', () => ({
  sendGmailMessage: vi.fn(async () => ({ messageId: 'mock' })),
}));
vi.mock('./channels/playground/api/login-pin.js', () => ({
  registerPinSender: vi.fn(),
  registerTokenLookup: vi.fn(),
}));

let testDb: Database.Database;

import { moduleClassLoginTokens } from './db/migrations/module-class-login-tokens.js';
import { _resetSessionsForTest, getSessionByCookie, mintSessionForUser } from './channels/playground/auth-store.js';
import { issueClassLoginToken, revokeAllForUser, rotateClassLoginToken } from './class-login-tokens.js';

beforeEach(() => {
  testDb = new Database(':memory:');
  moduleClassLoginTokens.up(testDb);
  _resetSessionsForTest();
});

afterEach(() => {
  _resetSessionsForTest();
  testDb.close();
});

describe('token revocation cascades into live sessions', () => {
  it('revokeAllForUser kills the user session — getSessionByCookie returns null', () => {
    issueClassLoginToken('playground:mallory');
    // Simulate a redeemed token: the redeemer mints a session for the user.
    const session = mintSessionForUser('playground:mallory');
    expect(getSessionByCookie(session.cookieValue)).not.toBeNull();

    revokeAllForUser('playground:mallory');

    expect(getSessionByCookie(session.cookieValue)).toBeNull();
  });

  it('rotateClassLoginToken kills existing sessions (they must re-auth with the new URL)', () => {
    issueClassLoginToken('playground:mallory');
    const session = mintSessionForUser('playground:mallory');

    rotateClassLoginToken('playground:mallory');

    expect(getSessionByCookie(session.cookieValue)).toBeNull();
  });

  it('revokes every session the user held, on any device', () => {
    issueClassLoginToken('playground:mallory');
    const s1 = mintSessionForUser('playground:mallory');
    const s2 = mintSessionForUser('playground:mallory');

    revokeAllForUser('playground:mallory');

    expect(getSessionByCookie(s1.cookieValue)).toBeNull();
    expect(getSessionByCookie(s2.cookieValue)).toBeNull();
  });

  it("leaves other users' sessions alone", () => {
    issueClassLoginToken('playground:mallory');
    const other = mintSessionForUser('playground:alice');

    revokeAllForUser('playground:mallory');

    expect(getSessionByCookie(other.cookieValue)).not.toBeNull();
  });

  it('revoking with no active token rows still clears lingering sessions', () => {
    const session = mintSessionForUser('playground:mallory');

    expect(revokeAllForUser('playground:mallory')).toBe(0);

    expect(getSessionByCookie(session.cookieValue)).toBeNull();
  });
});
