import { describe, it, expect } from 'vitest';

import { studentCredsToCodexAuthJson, extractRefreshedFromAuthJson } from './codex-auth-json.js';

describe('studentCredsToCodexAuthJson', () => {
  const baseOAuth = {
    accessToken: 'ya29.access',
    refreshToken: 'rt-refresh',
    expiresAt: 1_900_000_000_000,
    account: 'student@example.edu',
    addedAt: 1_800_000_000_000,
  };

  it('returns codex CLI auth.json shape for an active oauth student', () => {
    const out = studentCredsToCodexAuthJson({ active: 'oauth', oauth: baseOAuth });
    expect(out).toEqual({
      OPENAI_API_KEY: null,
      tokens: {
        access_token: 'ya29.access',
        refresh_token: 'rt-refresh',
      },
      last_refresh: new Date(1_800_000_000_000).toISOString(),
    });
  });

  it('returns null when student has only an apiKey (codex needs OAuth, not API key)', () => {
    const out = studentCredsToCodexAuthJson({
      active: 'apiKey',
      apiKey: { value: 'sk-test', addedAt: 0 },
    });
    expect(out).toBeNull();
  });

  it('returns null when active method is apiKey even if oauth is also stored', () => {
    const out = studentCredsToCodexAuthJson({
      active: 'apiKey',
      apiKey: { value: 'sk-test', addedAt: 0 },
      oauth: baseOAuth,
    });
    expect(out).toBeNull();
  });

  it('returns null for empty creds', () => {
    expect(studentCredsToCodexAuthJson(null)).toBeNull();
  });
});

describe('extractRefreshedFromAuthJson', () => {
  it('prefers the post-refresh openai-codex key', () => {
    const raw = {
      tokens: { access_token: 'stale-a', refresh_token: 'stale-r' },
      'openai-codex': { type: 'oauth', access: 'fresh-a', refresh: 'fresh-r', expires: 1_900_000_000_000 },
    };
    expect(extractRefreshedFromAuthJson(raw)).toEqual({
      accessToken: 'fresh-a',
      refreshToken: 'fresh-r',
      expiresAt: 1_900_000_000_000,
    });
  });

  it('falls back to codex CLI tokens block when no refresh has happened', () => {
    const raw = { tokens: { access_token: 'init-a', refresh_token: 'init-r' } };
    const out = extractRefreshedFromAuthJson(raw);
    expect(out?.accessToken).toBe('init-a');
    expect(out?.refreshToken).toBe('init-r');
  });

  it('returns null when neither shape is usable', () => {
    expect(extractRefreshedFromAuthJson(null)).toBeNull();
    expect(extractRefreshedFromAuthJson({})).toBeNull();
    expect(extractRefreshedFromAuthJson({ tokens: { access_token: 'only-access' } })).toBeNull();
    expect(extractRefreshedFromAuthJson({ 'openai-codex': { access: 'a' } })).toBeNull();
  });
});
