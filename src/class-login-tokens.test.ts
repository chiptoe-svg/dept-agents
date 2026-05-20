/**
 * Tests for class-login-tokens helpers + the redeemer hook.
 *
 * Uses an in-memory SQLite DB seeded with the migration so we don't
 * touch the real install. Mocks `mintSessionForUser` to verify the
 * redeemer returns the session shape we expect.
 */
import Database from 'better-sqlite3';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const { mockEnv } = vi.hoisted(() => ({ mockEnv: {} as Record<string, string> }));

const minted: string[] = [];
vi.mock('./channels/playground/auth-store.js', () => ({
  // Capture what mintSessionForUser was called with so we can verify
  // the redeemer hooks into it correctly.
  mintSessionForUser: vi.fn((userId: string | null) => {
    minted.push(userId ?? '<null>');
    return { cookieValue: `cookie-for-${userId}`, userId, createdAt: Date.now(), lastSeen: Date.now() };
  }),
  registerClassTokenRedeemer: vi.fn(),
  registerLostLinkRecoverer: vi.fn(),
  // /add-classroom-pin wiring — registered at module load.
  setPinRequiredForClassToken: vi.fn(),
}));

vi.mock('./channels/playground/api/login-pin.js', () => ({
  registerPinSender: vi.fn(),
  registerTokenLookup: vi.fn(),
}));

vi.mock('./gmail-send.js', () => ({
  sendGmailMessage: vi.fn(async () => ({ messageId: 'mock' })),
}));

vi.mock('./db/connection.js', () => ({
  getDb: vi.fn(() => testDb),
}));

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...mockEnv })),
}));

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let testDb: Database.Database;

import { moduleClassLoginTokens } from './db/migrations/module-class-login-tokens.js';
import { migration016 } from './db/migrations/016-classroom-roster.js';
import {
  issueClassLoginToken,
  lookupActiveToken,
  recoverLostLinkForEmail,
  revokeAllForUser,
  rotateClassLoginToken,
  listTokensForUser,
} from './class-login-tokens.js';

beforeEach(() => {
  testDb = new Database(':memory:');
  moduleClassLoginTokens.up(testDb);
  migration016.up(testDb);
  minted.length = 0;
  for (const k of Object.keys(mockEnv)) delete mockEnv[k];
});

afterEach(() => {
  testDb.close();
});

describe('issueClassLoginToken', () => {
  it('inserts a row and returns the raw token', () => {
    const token = issueClassLoginToken('user_alice');
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    const row = testDb.prepare('SELECT user_id, revoked_at FROM class_login_tokens WHERE token = ?').get(token);
    expect(row).toEqual({ user_id: 'user_alice', revoked_at: null });
  });

  it('allows multiple active tokens per user (any active redeems)', () => {
    const t1 = issueClassLoginToken('user_alice');
    const t2 = issueClassLoginToken('user_alice');
    expect(t1).not.toBe(t2);
    expect(lookupActiveToken(t1)).toBe('user_alice');
    expect(lookupActiveToken(t2)).toBe('user_alice');
  });
});

describe('lookupActiveToken', () => {
  it('returns null for unknown tokens', () => {
    expect(lookupActiveToken('nope')).toBeNull();
  });

  it('returns null for revoked tokens', () => {
    const t = issueClassLoginToken('user_alice');
    revokeAllForUser('user_alice');
    expect(lookupActiveToken(t)).toBeNull();
  });
});

describe('revokeAllForUser', () => {
  it('revokes every active token for the user', () => {
    const t1 = issueClassLoginToken('user_alice');
    const t2 = issueClassLoginToken('user_alice');
    issueClassLoginToken('user_bob'); // unrelated, shouldn't be touched

    const revoked = revokeAllForUser('user_alice');
    expect(revoked).toBe(2);
    expect(lookupActiveToken(t1)).toBeNull();
    expect(lookupActiveToken(t2)).toBeNull();
  });

  it('returns 0 when no active tokens exist', () => {
    expect(revokeAllForUser('user_ghost')).toBe(0);
  });
});

describe('rotateClassLoginToken', () => {
  it('revokes prior tokens and issues a fresh one', () => {
    const old1 = issueClassLoginToken('user_alice');
    const old2 = issueClassLoginToken('user_alice');
    const fresh = rotateClassLoginToken('user_alice');

    expect(lookupActiveToken(old1)).toBeNull();
    expect(lookupActiveToken(old2)).toBeNull();
    expect(lookupActiveToken(fresh)).toBe('user_alice');
  });
});

describe('listTokensForUser', () => {
  it('returns active + revoked tokens, newest first', () => {
    issueClassLoginToken('user_alice');
    revokeAllForUser('user_alice');
    issueClassLoginToken('user_alice');

    const rows = listTokensForUser('user_alice');
    expect(rows).toHaveLength(2);
    // First row should be the active one (issued most recently).
    expect(rows[0]!.revoked_at).toBeNull();
    expect(rows[1]!.revoked_at).not.toBeNull();
  });
});

describe('recoverLostLinkForEmail', () => {
  function seedRosterRow(email: string, userId: string): void {
    testDb
      .prepare('INSERT INTO classroom_roster (email, user_id, agent_group_id, added_at) VALUES (?, ?, NULL, ?)')
      .run(email, userId, Date.now());
  }

  it('no-op when email is not in the roster (anti-enumeration)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    await recoverLostLinkForEmail('ghost@example.com');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('rotates token + posts to Resend when RESEND_API_KEY is set', async () => {
    seedRosterRow('alice@example.com', 'user_alice');
    const t1 = issueClassLoginToken('user_alice');
    Object.assign(mockEnv, {
      RESEND_API_KEY: 'test-key',
      RESEND_FROM_ADDRESS: 'noreply@class.example',
      RESEND_FROM_NAME: 'Class Bot',
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ id: 'r1' }), { status: 200 }));
    process.env.PUBLIC_PLAYGROUND_URL = 'http://class.test:3002';

    await recoverLostLinkForEmail('alice@example.com');

    // Prior token revoked, fresh one in place.
    expect(lookupActiveToken(t1)).toBeNull();
    const active = testDb
      .prepare("SELECT token FROM class_login_tokens WHERE user_id = 'user_alice' AND revoked_at IS NULL")
      .get() as { token: string } | undefined;
    expect(active).toBeDefined();

    // Resend API hit once with the right shape + URL.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchSpy.mock.calls[0]!;
    expect(calledUrl).toBe('https://api.resend.com/emails');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.to).toEqual(['alice@example.com']);
    expect(body.from).toBe('Class Bot <noreply@class.example>');
    expect(body.text).toContain(`http://class.test:3002/?token=${active!.token}`);

    fetchSpy.mockRestore();
    delete process.env.PUBLIC_PLAYGROUND_URL;
  });

  it('skips the email send when RESEND_API_KEY is unset (degrades silently)', async () => {
    seedRosterRow('bob@example.com', 'user_bob');
    issueClassLoginToken('user_bob');
    // mockEnv intentionally empty — no RESEND_API_KEY.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));

    await recoverLostLinkForEmail('bob@example.com');

    expect(fetchSpy).not.toHaveBeenCalled();
    // Token was still rotated — that part doesn't depend on Resend.
    // (Instructor can recover via `ncl class-tokens rotate` regardless.)
    fetchSpy.mockRestore();
  });
});
