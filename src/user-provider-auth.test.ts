import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture tmpDir before the factory runs so the factory closure can close
// over it. Reassigned per-test in beforeEach; the factory reads `tmpDir` at
// call time, so assignments before each test are visible. Same pattern as
// student-google-auth.test.ts — student-creds-paths.ts resolves DATA_DIR at
// module load, so the path helper must be mocked rather than chdir'd around.
let tmpDir = '';

// Inline regex: can't import the real sanitizeUserIdForPath here (would defeat the mock).
// Mirror: provider-auth.test.ts uses the same factory body.
vi.mock('./student-creds-paths.js', () => ({
  sanitizeUserIdForPath: (userId: string) => userId.replace(/[^A-Za-z0-9_-]/g, '_'),
  userProviderCredsPath: (userId: string, providerId: string) => {
    const sanitized = userId.replace(/[^A-Za-z0-9_-]/g, '_');
    return path.join(tmpDir, 'user-provider-creds', sanitized, `${providerId}.json`);
  },
}));

import {
  addApiKey,
  addOAuth,
  clearMethod,
  hasUserProviderCreds,
  loadUserProviderCreds,
  setActiveMethod,
} from './user-provider-auth.js';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('user-provider-auth', () => {
  it('addApiKey on empty store sets active=apiKey', () => {
    addApiKey('alice@x.edu', 'claude', 'sk-ant-test');
    const creds = loadUserProviderCreds('alice@x.edu', 'claude');
    expect(creds?.active).toBe('apiKey');
    expect(creds?.apiKey?.value).toBe('sk-ant-test');
    expect(creds?.oauth).toBeUndefined();
  });

  it('addOAuth on empty store sets active=oauth', () => {
    addOAuth('alice@x.edu', 'claude', {
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: 999,
      account: 'alice',
    });
    const creds = loadUserProviderCreds('alice@x.edu', 'claude');
    expect(creds?.active).toBe('oauth');
    expect(creds?.oauth?.accessToken).toBe('at');
  });

  it('adding the second method leaves active unchanged', () => {
    addApiKey('alice@x.edu', 'claude', 'sk-1');
    addOAuth('alice@x.edu', 'claude', {
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: 999,
    });
    expect(loadUserProviderCreds('alice@x.edu', 'claude')?.active).toBe('apiKey');
  });

  it('setActiveMethod switches active when both methods present', () => {
    addApiKey('alice@x.edu', 'claude', 'sk-1');
    addOAuth('alice@x.edu', 'claude', { accessToken: 'at', refreshToken: 'rt', expiresAt: 999 });
    setActiveMethod('alice@x.edu', 'claude', 'oauth');
    expect(loadUserProviderCreds('alice@x.edu', 'claude')?.active).toBe('oauth');
  });

  it('clearMethod removes only the named method and flips active', () => {
    addApiKey('alice@x.edu', 'claude', 'sk-1');
    addOAuth('alice@x.edu', 'claude', { accessToken: 'at', refreshToken: 'rt', expiresAt: 999 });
    setActiveMethod('alice@x.edu', 'claude', 'oauth');
    clearMethod('alice@x.edu', 'claude', 'oauth');
    const creds = loadUserProviderCreds('alice@x.edu', 'claude');
    expect(creds?.oauth).toBeUndefined();
    expect(creds?.active).toBe('apiKey');
  });

  it('clearMethod with no remaining method removes the file', () => {
    addApiKey('alice@x.edu', 'claude', 'sk-1');
    clearMethod('alice@x.edu', 'claude', 'apiKey');
    expect(loadUserProviderCreds('alice@x.edu', 'claude')).toBeNull();
    expect(hasUserProviderCreds('alice@x.edu', 'claude')).toBe(false);
  });

  it('hasUserProviderCreds returns false for never-written user', () => {
    expect(hasUserProviderCreds('nobody@x.edu', 'claude')).toBe(false);
  });

  it('sanitizes user_id for filesystem (slashes, colons, dots)', () => {
    addApiKey('playground:alice@x.edu', 'claude', 'sk-1');
    const sanitized = 'playground_alice_x_edu';
    const expectedPath = path.join(tmpDir, 'user-provider-creds', sanitized, 'claude.json');
    expect(fs.existsSync(expectedPath)).toBe(true);
  });

  it('file is created with mode 0600 and dir with mode 0700', () => {
    addApiKey('alice', 'claude', 'sk-1');
    const dir = path.join(tmpDir, 'user-provider-creds', 'alice');
    const file = path.join(dir, 'claude.json');
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});
