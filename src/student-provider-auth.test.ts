import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  addApiKey,
  addOAuth,
  clearMethod,
  hasStudentProviderCreds,
  loadStudentProviderCreds,
  setActiveMethod,
} from './student-provider-auth.js';

let tmpRoot: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-test-'));
  process.chdir(tmpRoot);
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('student-provider-auth', () => {
  it('addApiKey on empty store sets active=apiKey', () => {
    addApiKey('alice@x.edu', 'claude', 'sk-ant-test');
    const creds = loadStudentProviderCreds('alice@x.edu', 'claude');
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
    const creds = loadStudentProviderCreds('alice@x.edu', 'claude');
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
    expect(loadStudentProviderCreds('alice@x.edu', 'claude')?.active).toBe('apiKey');
  });

  it('setActiveMethod switches active when both methods present', () => {
    addApiKey('alice@x.edu', 'claude', 'sk-1');
    addOAuth('alice@x.edu', 'claude', { accessToken: 'at', refreshToken: 'rt', expiresAt: 999 });
    setActiveMethod('alice@x.edu', 'claude', 'oauth');
    expect(loadStudentProviderCreds('alice@x.edu', 'claude')?.active).toBe('oauth');
  });

  it('clearMethod removes only the named method and flips active', () => {
    addApiKey('alice@x.edu', 'claude', 'sk-1');
    addOAuth('alice@x.edu', 'claude', { accessToken: 'at', refreshToken: 'rt', expiresAt: 999 });
    setActiveMethod('alice@x.edu', 'claude', 'oauth');
    clearMethod('alice@x.edu', 'claude', 'oauth');
    const creds = loadStudentProviderCreds('alice@x.edu', 'claude');
    expect(creds?.oauth).toBeUndefined();
    expect(creds?.active).toBe('apiKey');
  });

  it('clearMethod with no remaining method removes the file', () => {
    addApiKey('alice@x.edu', 'claude', 'sk-1');
    clearMethod('alice@x.edu', 'claude', 'apiKey');
    expect(loadStudentProviderCreds('alice@x.edu', 'claude')).toBeNull();
    expect(hasStudentProviderCreds('alice@x.edu', 'claude')).toBe(false);
  });

  it('hasStudentProviderCreds returns false for never-written user', () => {
    expect(hasStudentProviderCreds('nobody@x.edu', 'claude')).toBe(false);
  });

  it('sanitizes user_id for filesystem (slashes, colons, dots)', () => {
    addApiKey('playground:alice@x.edu', 'claude', 'sk-1');
    const sanitized = 'playground_alice_at_x.edu';
    const expectedPath = path.join(tmpRoot, 'data', 'student-provider-creds', sanitized, 'claude.json');
    expect(fs.existsSync(expectedPath)).toBe(true);
  });

  it('file is created with mode 0600 and dir with mode 0700', () => {
    addApiKey('alice', 'claude', 'sk-1');
    const dir = path.join(tmpRoot, 'data', 'student-provider-creds', 'alice');
    const file = path.join(dir, 'claude.json');
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});
