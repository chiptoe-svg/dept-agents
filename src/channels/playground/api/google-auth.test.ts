/**
 * Unit tests for /google-auth/start and /google-auth/callback.
 *
 * No live network calls — `exchangeCodeForTokens` is injected via the
 * `exchange` hook on `processGoogleAuthCallback`, and `loadOAuthClient` is
 * vi.mock'd so the suite never touches ~/.config/gws/client_secret.json.
 *
 * Test coverage:
 *   /start — no session → 302 /login
 *   /start — valid session → 302 to accounts.google.com (state + scopes verifiable)
 *   /callback — error=denied → 302 /playground/?google_auth_error=denied
 *   /callback — no state → 400
 *   /callback — expired/unknown state → 400
 *   /callback — session userId ≠ state userId → 403
 *   /callback — happy path: credentials written, metadata stamped, 302 /playground/?google_connected=1
 *   /callback — refresh_token absent from response BUT exists on disk → re-used
 *   /callback — refresh_token absent AND no existing on disk → 500
 */
import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock loadOAuthClient BEFORE any module that imports gws-auth is loaded.
vi.mock('../../../gws-auth.js', async () => {
  const actual = await vi.importActual<typeof import('../../../gws-auth.js')>('../../../gws-auth.js');
  return {
    ...actual,
    loadOAuthClient: () => ({ client_id: 'test-client-id', client_secret: 'test-client-secret' }),
  };
});

import { closeDb, initTestDb } from '../../../db/connection.js';
import { setAgentGroupMetadataKey } from '../../../db/agent-groups.js';
import { upsertRosterEntry } from '../../../db/classroom-roster.js';
import { runMigrations } from '../../../db/migrations/index.js';
import type { GwsCredentialsJson } from '../../../gws-auth.js';
import { writeStudentCredentials, loadStudentCredentials } from '../../../student-google-auth.js';
import { studentGwsCredentialsPath } from '../../../student-creds-paths.js';
import { _resetSessionsForTest, mintSessionForUser } from '../auth-store.js';
import { _resetForTest, _seedStateForTest, processGoogleAuthCallback } from './google-auth.js';

// ── Helpers ────────────────────────────────────────────────────────────────

type TokenResponse = Awaited<ReturnType<typeof import('../../../gws-auth.js').exchangeCodeForTokens>>;

function stubExchange(tokens: Partial<TokenResponse> & { access_token: string; expires_in: number }) {
  return async () => tokens as TokenResponse;
}

const TEST_USER_IDS = ['class:student_03', 'class:student_07', 'class:student_08'];

function cleanCredFiles(): void {
  for (const userId of TEST_USER_IDS) {
    const p = studentGwsCredentialsPath(userId);
    try {
      fs.rmSync(p, { force: true });
      fs.rmdirSync(path.dirname(p));
    } catch {
      /* ignore */
    }
  }
}

// ── Setup / teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  _resetSessionsForTest();
  _resetForTest();
});

afterEach(() => {
  closeDb();
  cleanCredFiles();
});

// ── processGoogleAuthCallback tests ───────────────────────────────────────

describe('processGoogleAuthCallback', () => {
  it('redirects to /playground/?google_auth_error=denied when error param present', async () => {
    const result = await processGoogleAuthCallback({
      code: null,
      state: 'irrelevant',
      error: 'access_denied',
      sessionUserId: 'class:student_03',
    });
    expect(result.status).toBe(302);
    expect(result.location).toBe('/playground/?google_auth_error=denied');
  });

  it('returns 400 when state is missing', async () => {
    const result = await processGoogleAuthCallback({
      code: 'some-code',
      state: null,
      error: null,
      sessionUserId: 'class:student_03',
    });
    expect(result.status).toBe(400);
    expect(result.body).toContain('Missing state');
  });

  it('returns 400 when state is unknown (never seeded)', async () => {
    const result = await processGoogleAuthCallback({
      code: 'some-code',
      state: 'never-seeded-state',
      error: null,
      sessionUserId: 'class:student_03',
    });
    expect(result.status).toBe(400);
    expect(result.body).toContain('Invalid or expired state');
  });

  it('returns 400 when state has already been consumed', async () => {
    _seedStateForTest('once-state', 'class:student_03');
    upsertRosterEntry({ email: 'alice@school.edu', user_id: 'class:student_03', agent_group_id: null });

    // First call consumes the state.
    await processGoogleAuthCallback({
      code: 'code-1',
      state: 'once-state',
      error: null,
      sessionUserId: 'class:student_03',
      exchange: stubExchange({ access_token: 'at', expires_in: 3600, refresh_token: 'rt' }),
    });

    // Second call with the same state → 400.
    const second = await processGoogleAuthCallback({
      code: 'code-2',
      state: 'once-state',
      error: null,
      sessionUserId: 'class:student_03',
      exchange: stubExchange({ access_token: 'at2', expires_in: 3600, refresh_token: 'rt2' }),
    });
    expect(second.status).toBe(400);
    expect(second.body).toContain('Invalid or expired state');
  });

  it('returns 403 when session userId does not match state userId', async () => {
    _seedStateForTest('state-A', 'class:student_03');
    const result = await processGoogleAuthCallback({
      code: 'some-code',
      state: 'state-A',
      error: null,
      sessionUserId: 'class:student_07', // different user!
    });
    expect(result.status).toBe(403);
    expect(result.body).toContain('Session mismatch');
  });

  it('returns 403 when session userId is null (unauthenticated callback)', async () => {
    _seedStateForTest('state-B', 'class:student_03');
    const result = await processGoogleAuthCallback({
      code: 'some-code',
      state: 'state-B',
      error: null,
      sessionUserId: null,
    });
    expect(result.status).toBe(403);
  });

  it('happy path: writes credentials, stamps metadata, redirects to /playground/?google_connected=1', async () => {
    upsertRosterEntry({ email: 'alice@school.edu', user_id: 'class:student_03', agent_group_id: 'ag_alice' });
    // Ensure the agent group exists so setAgentGroupMetadataKey has a row to update.
    const db = (await import('../../../db/connection.js')).getDb();
    db.prepare(
      `INSERT OR IGNORE INTO agent_groups (id, name, folder, agent_provider, model, created_at, metadata)
       VALUES ('ag_alice', 'Alice Agent', 'alice_folder', 'claude', 'claude-3-5-haiku-20241022', 0, NULL)`,
    ).run();

    _seedStateForTest('happy-state', 'class:student_03');

    const result = await processGoogleAuthCallback({
      code: 'auth-code',
      state: 'happy-state',
      error: null,
      sessionUserId: 'class:student_03',
      exchange: stubExchange({
        access_token: 'access-token-1',
        refresh_token: 'refresh-token-1',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'openid email https://www.googleapis.com/auth/drive',
      }),
    });

    expect(result.status).toBe(302);
    expect(result.location).toBe('/playground/?google_connected=1');

    // Credentials file written.
    const cred = JSON.parse(
      fs.readFileSync(studentGwsCredentialsPath('class:student_03'), 'utf-8'),
    ) as GwsCredentialsJson;
    expect(cred.type).toBe('authorized_user');
    expect(cred.client_id).toBe('test-client-id');
    expect(cred.client_secret).toBe('test-client-secret');
    expect(cred.refresh_token).toBe('refresh-token-1');
    expect(cred.access_token).toBe('access-token-1');

    // Metadata stamped on agent group.
    const { getAgentGroupMetadata } = await import('../../../db/agent-groups.js');
    const meta = getAgentGroupMetadata('ag_alice');
    expect(meta.student_user_id).toBe('class:student_03');
  });

  it('reuses existing on-disk refresh_token when Google omits one on re-consent', async () => {
    upsertRosterEntry({ email: 'bob@school.edu', user_id: 'class:student_07', agent_group_id: null });

    // Seed an existing credentials file with a refresh_token.
    const existingCreds: GwsCredentialsJson = {
      type: 'authorized_user',
      client_id: 'test-client-id',
      client_secret: 'test-client-secret',
      refresh_token: 'existing-refresh-token',
      access_token: 'old-access-token',
    };
    writeStudentCredentials('class:student_07', existingCreds);

    _seedStateForTest('reconsent-state', 'class:student_07');

    const result = await processGoogleAuthCallback({
      code: 'auth-code-2',
      state: 'reconsent-state',
      error: null,
      sessionUserId: 'class:student_07',
      exchange: stubExchange({
        access_token: 'new-access-token',
        // No refresh_token — Google omits on re-consent.
        expires_in: 3600,
      }),
    });

    expect(result.status).toBe(302);
    expect(result.location).toBe('/playground/?google_connected=1');

    const cred = JSON.parse(
      fs.readFileSync(studentGwsCredentialsPath('class:student_07'), 'utf-8'),
    ) as GwsCredentialsJson;
    expect(cred.refresh_token).toBe('existing-refresh-token'); // preserved
    expect(cred.access_token).toBe('new-access-token'); // updated
  });

  it('returns 500 with helpful message when refresh_token absent from response AND no existing on disk', async () => {
    upsertRosterEntry({ email: 'carol@school.edu', user_id: 'class:student_08', agent_group_id: null });
    _seedStateForTest('no-rt-state', 'class:student_08');

    const result = await processGoogleAuthCallback({
      code: 'auth-code-3',
      state: 'no-rt-state',
      error: null,
      sessionUserId: 'class:student_08',
      exchange: stubExchange({
        access_token: 'access-only',
        expires_in: 3600,
        // No refresh_token AND nothing on disk.
      }),
    });

    expect(result.status).toBe(500);
    expect(result.body).toContain('refresh_token');
    expect(result.body).toContain('prompt=consent');
  });
});

// ── /google-auth/start handler tests (via session-cookie plumbing) ─────────

describe('handleGoogleAuthStart', () => {
  it('returns 302 to /login when no session cookie is present', async () => {
    // We can't easily call the HTTP handler without a real http.IncomingMessage, so
    // we test through the server.ts authenticate() pattern directly:
    // an absent cookie → getSessionByCookie returns null → should redirect to /login.
    //
    // Instead of spinning up a full server we verify the exported pure-function
    // behaviour by testing that a session-less call to the handler redirects
    // correctly. We create a minimal fake req/res pair.
    const { handleGoogleAuthStart } = await import('./google-auth.js');

    let statusCode = 0;
    let locationHeader = '';
    const fakeReq = {
      url: '/google-auth/start',
      headers: {},
      method: 'GET',
    } as unknown as import('http').IncomingMessage;
    const fakeRes = {
      writeHead(status: number, headers?: Record<string, string>) {
        statusCode = status;
        locationHeader = headers?.['location'] ?? headers?.location ?? '';
      },
      end() {},
    } as unknown as import('http').ServerResponse;

    const handled = await handleGoogleAuthStart(fakeReq, fakeRes);
    expect(handled).toBe(true);
    expect(statusCode).toBe(302);
    expect(locationHeader).toBe('/login');
  });

  it('returns 302 to accounts.google.com with state + scopes when session is valid', async () => {
    const { handleGoogleAuthStart } = await import('./google-auth.js');

    // Mint a real session.
    const session = mintSessionForUser('class:student_03');
    const cookie = `nc_playground=${session.cookieValue}`;

    let statusCode = 0;
    let locationHeader = '';
    const fakeReq = {
      url: '/google-auth/start',
      headers: { cookie },
      method: 'GET',
    } as unknown as import('http').IncomingMessage;
    const fakeRes = {
      writeHead(status: number, headers?: Record<string, string>) {
        statusCode = status;
        locationHeader = headers?.['location'] ?? headers?.location ?? '';
      },
      end() {},
    } as unknown as import('http').ServerResponse;

    const handled = await handleGoogleAuthStart(fakeReq, fakeRes);
    expect(handled).toBe(true);
    expect(statusCode).toBe(302);

    // Should be a Google consent URL.
    expect(locationHeader).toContain('accounts.google.com');
    const consentUrl = new URL(locationHeader);
    expect(consentUrl.searchParams.get('state')).toBeTruthy();
    expect(consentUrl.searchParams.get('response_type')).toBe('code');
    // Scopes must include drive.
    const scope = consentUrl.searchParams.get('scope') ?? '';
    expect(scope).toContain('drive');
    expect(scope).toContain('openid');
  });

  it('returns false for non-matching path', async () => {
    const { handleGoogleAuthStart } = await import('./google-auth.js');
    const fakeReq = {
      url: '/some-other-path',
      headers: {},
      method: 'GET',
    } as unknown as import('http').IncomingMessage;
    const fakeRes = {} as unknown as import('http').ServerResponse;
    const handled = await handleGoogleAuthStart(fakeReq, fakeRes);
    expect(handled).toBe(false);
  });
});
