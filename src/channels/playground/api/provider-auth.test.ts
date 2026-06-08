import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

// Capture tmpDir before the mock factory runs so the factory closure can
// close over it. Reassigned per-test in beforeEach; the factory reads
// `tmpDir` at call time. Same pattern as student-google-auth.test.ts —
// student-creds-paths.ts resolves DATA_DIR at module load, so the path
// helper must be mocked rather than chdir'd around.
let tmpDir = '';

// Inline regex: can't import the real sanitizeUserIdForPath here (would defeat the mock).
// Mirror: user-provider-auth.test.ts uses the same factory body.
vi.mock('../../../student-creds-paths.js', () => ({
  sanitizeUserIdForPath: (userId: string) => userId.replace(/[^A-Za-z0-9_-]/g, '_'),
  userProviderCredsPath: (userId: string, providerId: string) => {
    const sanitized = userId.replace(/[^A-Za-z0-9_-]/g, '_');
    return path.join(tmpDir, 'user-provider-creds', sanitized, `${providerId}.json`);
  },
}));

import { registerProvider, resetRegistryForTests } from '../../../providers/auth-registry.js';
import { addOAuth, hasUserProviderCreds, loadUserProviderCreds } from '../../../user-provider-auth.js';
import {
  handleProviderAuthStart,
  handleProviderAuthExchange,
  getOAuthStateStoreForTests,
  setTokenExchangerForTests,
  handleGetProviderStatus,
  handlePostApiKey,
  handleSetActive,
  handleDisconnect,
} from './provider-auth.js';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-auth-test-'));
  resetRegistryForTests();
  getOAuthStateStoreForTests().clear();
  registerProvider({
    id: 'claude',
    displayName: 'Anthropic',
    proxyRoutePrefix: '',
    credentialFileShape: 'mixed',
    apiKey: {
      placeholder: 'sk-ant-api03-…',
      validatePrefix: 'sk-ant-',
    },
    oauth: {
      clientId: 'cid-claude',
      authorizeUrl: 'https://example.com/oauth/authorize',
      tokenUrl: 'https://example.com/oauth/token',
      redirectUri: 'https://example.com/code/callback',
      scopes: ['user'],
      refreshGrantBody: (rt, cid) => `grant_type=refresh_token&refresh_token=${rt}&client_id=${cid}`,
      pkce: 'S256',
      authCodeBodyFormat: 'json',
      connectInstructions: 'Sign in then paste the code.',
    },
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('handleProviderAuthStart (paste-back)', () => {
  it('returns 200 with JSON {authorizeUrl, state, instructions, displayName} for known provider', () => {
    const result = handleProviderAuthStart('claude', { userId: 'alice@x.edu' });
    expect(result.status).toBe(200);
    const body = result.body as { authorizeUrl: string; state: string; instructions: string; displayName: string };
    expect(body.authorizeUrl).toContain('https://example.com/oauth/authorize');
    expect(body.authorizeUrl).toContain('client_id=cid-claude');
    expect(body.authorizeUrl).toContain('code_challenge_method=S256');
    expect(body.authorizeUrl).toContain('redirect_uri=https%3A%2F%2Fexample.com%2Fcode%2Fcallback');
    expect(body.authorizeUrl).toContain(`state=${encodeURIComponent(body.state)}`);
    expect(body.authorizeUrl).toMatch(/code_challenge=[^&]+/);
    expect(body.instructions).toBe('Sign in then paste the code.');
    expect(body.displayName).toBe('Anthropic');
  });

  it('stores state in TtlMap bound to user_id, providerId, and PKCE verifier', () => {
    handleProviderAuthStart('claude', { userId: 'alice@x.edu' });
    const store = getOAuthStateStoreForTests();
    const entries = [...store.entriesForTest()];
    expect(entries).toHaveLength(1);
    expect(entries[0]![1].userId).toBe('alice@x.edu');
    expect(entries[0]![1].providerId).toBe('claude');
    expect(entries[0]![1].pkceVerifier).toMatch(/^[A-Za-z0-9-._~]+$/);
    expect(entries[0]![1].pkceVerifier.length).toBeGreaterThanOrEqual(43);
  });

  it('returns 404 for unknown provider', () => {
    const result = handleProviderAuthStart('nope', { userId: 'alice@x.edu' });
    expect(result.status).toBe(404);
  });

  it('returns 400 when provider has no oauth config', () => {
    registerProvider({
      id: 'apikey-only',
      displayName: 'X',
      proxyRoutePrefix: '/x/',
      credentialFileShape: 'api-key',
      apiKey: { placeholder: 'k' },
    });
    const result = handleProviderAuthStart('apikey-only', { userId: 'alice@x.edu' });
    expect(result.status).toBe(400);
  });
});

describe('handleProviderAuthExchange (paste-back)', () => {
  beforeEach(() => {
    setTokenExchangerForTests(async (_spec, code, _verifier, _redirectUri) => {
      if (code === 'good-code') {
        return {
          accessToken: 'at-from-exchange',
          refreshToken: 'rt-from-exchange',
          expiresIn: 3600,
          account: 'alice@anthropic',
        };
      }
      return null;
    });
  });

  it('rejects unknown state', async () => {
    const r = await handleProviderAuthExchange(
      'claude',
      { code: 'any-code', state: 'unknown-state' },
      { userId: 'alice@x.edu' },
    );
    expect(r.status).toBe(400);
  });

  it('rejects missing code or state', async () => {
    const r = await handleProviderAuthExchange('claude', { code: '', state: 's' } as never, { userId: 'alice@x.edu' });
    expect(r.status).toBe(400);
  });

  it('exchanges code, persists creds, returns 200 on success', async () => {
    const start = handleProviderAuthStart('claude', { userId: 'alice@x.edu' });
    const { state } = start.body as { state: string };
    const r = await handleProviderAuthExchange('claude', { code: 'good-code', state }, { userId: 'alice@x.edu' });
    expect(r.status).toBe(200);
    expect((r.body as { ok: boolean }).ok).toBe(true);
    expect(hasUserProviderCreds('alice@x.edu', 'claude')).toBe(true);
    const creds = loadUserProviderCreds('alice@x.edu', 'claude');
    expect(creds?.active).toBe('oauth');
    expect(creds?.oauth?.accessToken).toBe('at-from-exchange');
  });

  it('rejects state from a different session user', async () => {
    const start = handleProviderAuthStart('claude', { userId: 'alice@x.edu' });
    const { state } = start.body as { state: string };
    const r = await handleProviderAuthExchange('claude', { code: 'good-code', state }, { userId: 'bob@x.edu' });
    expect(r.status).toBe(403);
  });

  it('rejects state/provider mismatch', async () => {
    registerProvider({
      id: 'codex',
      displayName: 'OpenAI',
      proxyRoutePrefix: '/openai/',
      credentialFileShape: 'mixed',
      oauth: {
        clientId: 'cid-codex',
        authorizeUrl: 'https://example.com/codex/authorize',
        tokenUrl: 'https://example.com/codex/token',
        redirectUri: 'http://localhost:1455/auth/callback',
        scopes: ['openid'],
        refreshGrantBody: () => '',
        pkce: 'S256',
        authCodeBodyFormat: 'form',
        connectInstructions: 'codex',
      },
    });
    const start = handleProviderAuthStart('claude', { userId: 'alice@x.edu' });
    const { state } = start.body as { state: string };
    const r = await handleProviderAuthExchange('codex', { code: 'good-code', state }, { userId: 'alice@x.edu' });
    expect(r.status).toBe(400);
  });

  it('returns 502 on exchange failure', async () => {
    const start = handleProviderAuthStart('claude', { userId: 'alice@x.edu' });
    const { state } = start.body as { state: string };
    const r = await handleProviderAuthExchange('claude', { code: 'bad-code', state }, { userId: 'alice@x.edu' });
    expect(r.status).toBe(502);
  });
});

describe('GET /api/me/providers/:id', () => {
  it('returns connected:false when no creds', () => {
    const r = handleGetProviderStatus('claude', { userId: 'fresh@x.edu' });
    expect(r.body).toEqual({ hasApiKey: false, hasOAuth: false, active: null });
  });

  it('returns connection details including active method', () => {
    addOAuth('alice@x.edu', 'claude', {
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: Date.now() + 1000,
      account: 'alice',
    });
    const r = handleGetProviderStatus('claude', { userId: 'alice@x.edu' });
    expect(r.body).toMatchObject({
      hasApiKey: false,
      hasOAuth: true,
      active: 'oauth',
      oauth: { account: 'alice' },
    });
  });
});

describe('POST /api/me/providers/:id/api-key', () => {
  it('rejects empty key', () => {
    const r = handlePostApiKey('claude', { apiKey: '' }, { userId: 'alice@x.edu' });
    expect(r.status).toBe(400);
  });

  it('rejects key that does not match validatePrefix', () => {
    const r = handlePostApiKey('claude', { apiKey: 'wrong-prefix-key' }, { userId: 'alice@x.edu' });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toContain('sk-ant-');
  });

  it('stores key and sets active=apiKey when no oauth present', () => {
    const r = handlePostApiKey('claude', { apiKey: 'sk-ant-test' }, { userId: 'alice@x.edu' });
    expect(r.status).toBe(200);
    const status = handleGetProviderStatus('claude', { userId: 'alice@x.edu' });
    expect(status.body).toMatchObject({ hasApiKey: true, active: 'apiKey' });
  });
});

describe('POST /api/me/providers/:id/active', () => {
  it('switches active when both methods present', () => {
    handlePostApiKey('claude', { apiKey: 'sk-ant-1' }, { userId: 'alice@x.edu' });
    addOAuth('alice@x.edu', 'claude', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 1000 });
    const r = handleSetActive('claude', { active: 'oauth' }, { userId: 'alice@x.edu' });
    expect(r.status).toBe(200);
    expect((handleGetProviderStatus('claude', { userId: 'alice@x.edu' }).body as { active: string }).active).toBe(
      'oauth',
    );
  });

  it('rejects activating a method that is not set', () => {
    handlePostApiKey('claude', { apiKey: 'sk-ant-1' }, { userId: 'alice@x.edu' });
    const r = handleSetActive('claude', { active: 'oauth' }, { userId: 'alice@x.edu' });
    expect(r.status).toBe(400);
  });
});

describe('DELETE /api/me/providers/:id', () => {
  it('clears named method', () => {
    handlePostApiKey('claude', { apiKey: 'sk-ant-1' }, { userId: 'alice@x.edu' });
    addOAuth('alice@x.edu', 'claude', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 1000 });
    const r = handleDisconnect('claude', { which: 'oauth' }, { userId: 'alice@x.edu' });
    expect(r.status).toBe(200);
    expect((handleGetProviderStatus('claude', { userId: 'alice@x.edu' }).body as { hasOAuth: boolean }).hasOAuth).toBe(
      false,
    );
  });

  it('removes file when both methods cleared', () => {
    handlePostApiKey('claude', { apiKey: 'sk-ant-1' }, { userId: 'alice@x.edu' });
    handleDisconnect('claude', { which: 'apiKey' }, { userId: 'alice@x.edu' });
    const status = handleGetProviderStatus('claude', { userId: 'alice@x.edu' });
    expect(status.body).toMatchObject({ hasApiKey: false, hasOAuth: false, active: null });
  });
});
