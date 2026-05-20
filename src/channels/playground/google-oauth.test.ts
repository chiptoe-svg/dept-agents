/**
 * OAuth-callback unit tests — drive `processOAuthCallback` directly with
 * a stubbed token-exchange so the suite never touches network. Covers:
 *   - id_token decode (a real Google JWT is base64url(header).base64url(payload).sig)
 *   - state validation (missing / unknown / consumed)
 *   - email-not-on-roster → 403 "not enrolled"
 *   - email-on-roster → 302 + Set-Cookie + per-student creds file written
 */
import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the GWS auth module BEFORE importing google-oauth so the latter
// picks up the mocked loadOAuthClient. gws-auth resolves
// ~/.config/gws/credentials.json at import time, so HOME shenanigans
// won't override it; vi.mock is the clean way to inject test creds.
vi.mock('../../gws-auth.js', async () => {
  const actual = await vi.importActual<typeof import('../../gws-auth.js')>('../../gws-auth.js');
  return {
    ...actual,
    loadOAuthClient: () => ({ client_id: 'fake-client-id', client_secret: 'fake-client-secret' }),
  };
});

import { closeDb, initTestDb } from '../../db/connection.js';
import { upsertRosterEntry } from '../../db/classroom-roster.js';
import { runMigrations } from '../../db/migrations/index.js';
import { _resetSessionsForTest } from '../playground.js';
import {
  _resetOAuthStateForTest,
  _seedOAuthStateForTest,
  decodeGoogleIdToken,
  processOAuthCallback,
  studentGwsCredentialsPath,
} from './google-oauth.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  _resetSessionsForTest();
  _resetOAuthStateForTest();
});

afterEach(() => {
  closeDb();
  // Sweep any per-student creds the tests wrote.
  for (const userId of ['class:student_03', 'class:student_07', 'class:s1']) {
    const credPath = studentGwsCredentialsPath(userId);
    fs.rmSync(credPath, { force: true });
    try {
      fs.rmdirSync(path.dirname(credPath));
    } catch {
      /* ignore */
    }
  }
});

function makeIdToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fake-signature`;
}

describe('decodeGoogleIdToken', () => {
  it('extracts email from a valid 3-part JWT', () => {
    const tok = makeIdToken({ email: 'alice@school.edu', email_verified: true });
    const payload = decodeGoogleIdToken(tok);
    expect(payload?.email).toBe('alice@school.edu');
    expect(payload?.email_verified).toBe(true);
  });

  it('returns null on malformed input', () => {
    expect(decodeGoogleIdToken('not-a-jwt')).toBeNull();
    expect(decodeGoogleIdToken('a.b')).toBeNull();
    expect(decodeGoogleIdToken('a.!!!.c')).toBeNull();
  });
});

describe('processOAuthCallback', () => {
  function stubExchange(tokens: Record<string, unknown>) {
    return async () =>
      tokens as unknown as Awaited<ReturnType<typeof import('../../gws-auth.js').exchangeCodeForTokens>>;
  }

  it('returns 400 when code is missing', async () => {
    const result = await processOAuthCallback({ code: null, state: 'whatever' });
    expect(result.status).toBe(400);
  });

  it('returns 400 when state is unknown', async () => {
    const result = await processOAuthCallback({ code: 'auth-code', state: 'never-seeded' });
    expect(result.status).toBe(400);
  });

  it('returns 400 when state has already been consumed', async () => {
    _seedOAuthStateForTest('once');
    await processOAuthCallback({
      code: 'c',
      state: 'once',
      exchange: stubExchange({ id_token: makeIdToken({ email: 'a@x.com', email_verified: true }) }),
    });
    const second = await processOAuthCallback({
      code: 'c',
      state: 'once',
      exchange: stubExchange({ id_token: makeIdToken({ email: 'a@x.com', email_verified: true }) }),
    });
    expect(second.status).toBe(400);
  });

  it('returns 403 when the email is not on the roster', async () => {
    _seedOAuthStateForTest('s');
    const result = await processOAuthCallback({
      code: 'c',
      state: 's',
      exchange: stubExchange({
        id_token: makeIdToken({ email: 'stranger@x.com', email_verified: true }),
        refresh_token: 'r',
      }),
    });
    expect(result.status).toBe(403);
    expect(result.body).toContain('Not enrolled');
  });

  it('returns 400 when email is unverified', async () => {
    _seedOAuthStateForTest('s');
    upsertRosterEntry({ email: 'unverified@x.com', user_id: 'class:s1' });
    const result = await processOAuthCallback({
      code: 'c',
      state: 's',
      exchange: stubExchange({
        id_token: makeIdToken({ email: 'unverified@x.com', email_verified: false }),
        refresh_token: 'r',
      }),
    });
    expect(result.status).toBe(400);
    expect(result.body).toContain('not verified');
  });

  it('on roster hit: 302 + Set-Cookie + persists per-student credentials', async () => {
    _seedOAuthStateForTest('s');
    upsertRosterEntry({ email: 'alice@school.edu', user_id: 'class:student_03' });
    const result = await processOAuthCallback({
      code: 'c',
      state: 's',
      exchange: stubExchange({
        id_token: makeIdToken({ email: 'alice@school.edu', email_verified: true }),
        access_token: 'access-A',
        refresh_token: 'refresh-A',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'openid email https://www.googleapis.com/auth/drive',
      }),
    });
    expect(result.status).toBe(302);
    expect(result.setCookie).toBeDefined();
    expect(result.setCookie).toContain('nc_playground=');
    expect(result.setCookie).toContain('HttpOnly');
    expect(result.setCookie).toContain('SameSite=Lax');

    const credPath = studentGwsCredentialsPath('class:student_03');
    expect(fs.existsSync(credPath)).toBe(true);
    const cred = JSON.parse(fs.readFileSync(credPath, 'utf8')) as {
      client_id: string;
      refresh_token: string;
      access_token: string;
    };
    expect(cred.client_id).toBe('fake-client-id');
    expect(cred.refresh_token).toBe('refresh-A');
    expect(cred.access_token).toBe('access-A');
  });

  it('preserves on-disk refresh_token when Google omits one on re-consent', async () => {
    _seedOAuthStateForTest('first');
    upsertRosterEntry({ email: 'bob@school.edu', user_id: 'class:student_07' });
    await processOAuthCallback({
      code: 'c',
      state: 'first',
      exchange: stubExchange({
        id_token: makeIdToken({ email: 'bob@school.edu', email_verified: true }),
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 3600,
      }),
    });

    _seedOAuthStateForTest('second');
    await processOAuthCallback({
      code: 'c2',
      state: 'second',
      exchange: stubExchange({
        id_token: makeIdToken({ email: 'bob@school.edu', email_verified: true }),
        access_token: 'access-2',
        // no refresh_token — Google omits on re-consent
        expires_in: 3600,
      }),
    });

    const cred = JSON.parse(fs.readFileSync(studentGwsCredentialsPath('class:student_07'), 'utf8')) as {
      refresh_token: string;
      access_token: string;
    };
    expect(cred.refresh_token).toBe('refresh-1'); // preserved
    expect(cred.access_token).toBe('access-2'); // updated
  });
});
