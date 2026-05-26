import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'bun:test';

import { getPiAuthApiKey } from './pi-auth.js';

describe('getPiAuthApiKey', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads Pi-format oauth credentials from auth.json', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-auth-test-'));
    tmpDirs.push(tmp);
    const authPath = path.join(tmp, 'auth.json');
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        'openai-codex': {
          type: 'oauth',
          access: 'access-token',
          refresh: 'refresh-token',
          expires: Date.now() + 60_000,
        },
      }),
    );

    const result = await getPiAuthApiKey('openai-codex', authPath);
    expect(result?.apiKey).toBe('access-token');
  });

  it('adapts Codex CLI auth.json into Pi openai-codex oauth credentials', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-auth-test-'));
    tmpDirs.push(tmp);
    const authPath = path.join(tmp, 'auth.json');
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: null,
        tokens: {
          access_token: 'codex-access-token',
          refresh_token: 'codex-refresh-token',
          id_token: 'codex-id-token',
          account_id: 'acct_123',
        },
        last_refresh: new Date().toISOString(),
      }),
    );

    const result = await getPiAuthApiKey('openai-codex', authPath);
    expect(result?.apiKey).toBe('codex-access-token');
  });

  it('reads JWT exp from Codex access token instead of using last_refresh + 55min', async () => {
    // Build a minimal JWT with exp 10 days in the future
    const futureExp = Math.floor(Date.now() / 1000) + 10 * 24 * 60 * 60;
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ exp: futureExp, sub: 'user_123' })).toString('base64url');
    const jwtToken = `${header}.${payload}.fake-sig`;

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-auth-test-'));
    tmpDirs.push(tmp);
    const authPath = path.join(tmp, 'auth.json');
    // last_refresh is 2 hours ago — without JWT fix this would trigger a refresh
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: null,
        tokens: {
          access_token: jwtToken,
          refresh_token: 'codex-refresh-token',
        },
        last_refresh: twoHoursAgo,
      }),
    );

    // Should succeed using the JWT's exp (10 days away) without attempting refresh
    const result = await getPiAuthApiKey('openai-codex', authPath);
    expect(result?.apiKey).toBe(jwtToken);
  });

  it('returns ANTHROPIC_API_KEY placeholder for anthropic provider (api-key mode)', async () => {
    // In classroom, container-runner injects ANTHROPIC_API_KEY=placeholder.
    // The credential proxy at ANTHROPIC_BASE_URL substitutes the real key;
    // pi-auth just passes the placeholder through so the SDK initializes.
    process.env.ANTHROPIC_API_KEY = 'placeholder';
    try {
      const result = await getPiAuthApiKey('anthropic');
      expect(result?.apiKey).toBe('placeholder');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('returns sk-ant-oat- prefix for anthropic provider (oauth mode)', async () => {
    // In classroom OAuth mode, container-runner injects CLAUDE_CODE_OAUTH_TOKEN=placeholder.
    // pi-auth must return a value with `sk-ant-oat-` prefix so pi-ai's Anthropic
    // client sends Authorization: Bearer (which the proxy substitutes), not
    // x-api-key (which the proxy passes through in oauth mode → 401).
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'placeholder';
    try {
      const result = await getPiAuthApiKey('anthropic');
      expect(result?.apiKey.startsWith('sk-ant-oat-')).toBe(true);
    } finally {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it('returns null for anthropic when no env var is set', async () => {
    const prevApiKey = process.env.ANTHROPIC_API_KEY;
    const prevOAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    try {
      const result = await getPiAuthApiKey('anthropic');
      expect(result).toBeNull();
    } finally {
      if (prevApiKey !== undefined) process.env.ANTHROPIC_API_KEY = prevApiKey;
      if (prevOAuth !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = prevOAuth;
    }
  });

  it('returns null for openai-codex when auth.json is absent', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-auth-test-'));
    tmpDirs.push(tmp);
    const authPath = path.join(tmp, 'auth.json'); // not created
    const result = await getPiAuthApiKey('openai-codex', authPath);
    expect(result).toBeNull();
  });
});
