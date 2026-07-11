/**
 * provisionPiAuth — the openai-codex auth.json provisioning path.
 *
 * This lane talks to chatgpt.com directly (it BYPASSES the credential proxy),
 * so provisioning decides whose ChatGPT subscription a group's openai-codex
 * turns spend. The invariants under test:
 *
 *   (a) a group whose resolved user has their own codex OAuth gets THAT
 *       user's auth.json (never the owner's);
 *   (b) a NON-owner group whose user has no codex OAuth gets NO auth.json —
 *       the owner's ~/.codex/auth.json is never copied in;
 *   (c) the owner's own group gets the owner's ~/.codex/auth.json;
 *   (d) active=apiKey codex creds cannot produce an auth.json (chatgpt.com
 *       is not an API-key endpoint) — same "write nothing" outcome as (b).
 *
 * All token values below are synthetic test fixtures. Assertions are about
 * WHICH source was provisioned (or that no file was written) — never about
 * real credential contents.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import type { UserProviderCreds } from '../user-provider-auth.js';

vi.mock('../provisioning/agent-group-user.js', () => ({
  userIdForAgentGroup: vi.fn(),
}));
vi.mock('../modules/permissions/db/user-roles.js', () => ({
  isOwner: vi.fn(),
}));
vi.mock('../user-provider-auth.js', () => ({
  loadUserProviderCreds: vi.fn(),
  addOAuth: vi.fn(),
}));

import { userIdForAgentGroup } from '../provisioning/agent-group-user.js';
import { isOwner } from '../modules/permissions/db/user-roles.js';
import { loadUserProviderCreds } from '../user-provider-auth.js';
import { _provisionPiAuthForTests as provisionPiAuth } from './pi.js';

const mockUserIdForAgentGroup = vi.mocked(userIdForAgentGroup);
const mockIsOwner = vi.mocked(isOwner);
const mockLoadUserProviderCreds = vi.mocked(loadUserProviderCreds);

// Synthetic fixtures — markers, not secrets.
const OWNER_AUTH_MARKER = JSON.stringify({
  OPENAI_API_KEY: null,
  tokens: { access_token: 'owner-fixture-access', refresh_token: 'owner-fixture-refresh' },
});

const USER_OAUTH_CREDS: UserProviderCreds = {
  oauth: {
    accessToken: 'user-fixture-access',
    refreshToken: 'user-fixture-refresh',
    expiresAt: Date.now() + 3600_000,
    addedAt: Date.now(),
  },
  active: 'oauth',
};

let piAuthDir: string;
let hostHome: string;
let targetFile: string;

beforeEach(() => {
  vi.clearAllMocks();
  piAuthDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-provision-auth-'));
  hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-provision-home-'));
  targetFile = path.join(piAuthDir, 'auth.json');
  // Owner's personal ~/.codex/auth.json is always present on the host in
  // these tests — the point is proving when it is and is NOT copied.
  fs.mkdirSync(path.join(hostHome, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(hostHome, '.codex', 'auth.json'), OWNER_AUTH_MARKER);
});

afterEach(() => {
  fs.rmSync(piAuthDir, { recursive: true, force: true });
  fs.rmSync(hostHome, { recursive: true, force: true });
});

describe('provisionPiAuth (openai-codex auth.json source)', () => {
  it('(a) writes the resolved user’s OWN codex OAuth auth.json, not the owner’s', () => {
    mockUserIdForAgentGroup.mockReturnValue('playground:colleague');
    mockIsOwner.mockReturnValue(false);
    mockLoadUserProviderCreds.mockReturnValue(USER_OAUTH_CREDS);

    provisionPiAuth(piAuthDir, 'ag_colleague', hostHome);

    expect(fs.existsSync(targetFile)).toBe(true);
    const written = JSON.parse(fs.readFileSync(targetFile, 'utf-8'));
    // Source is the user's stored creds (fixture marker), NOT the owner file.
    expect(written.tokens.refresh_token).toBe('user-fixture-refresh');
    expect(fs.readFileSync(targetFile, 'utf-8')).not.toContain('owner-fixture');
    expect(mockLoadUserProviderCreds).toHaveBeenCalledWith('playground:colleague', 'codex');
  });

  it('(b) non-owner group with no codex OAuth: writes NOTHING, never copies the owner file', () => {
    mockUserIdForAgentGroup.mockReturnValue('playground:colleague');
    mockIsOwner.mockReturnValue(false);
    mockLoadUserProviderCreds.mockReturnValue(null);

    provisionPiAuth(piAuthDir, 'ag_colleague', hostHome);

    expect(fs.existsSync(targetFile)).toBe(false);
  });

  it('(b2) non-owner group: scrubs a stale auth.json left by a previous spawn', () => {
    mockUserIdForAgentGroup.mockReturnValue('playground:colleague');
    mockIsOwner.mockReturnValue(false);
    mockLoadUserProviderCreds.mockReturnValue(null);
    // Simulate a pre-fix spawn that leaked the owner's file into the session dir.
    fs.writeFileSync(targetFile, OWNER_AUTH_MARKER);

    provisionPiAuth(piAuthDir, 'ag_colleague', hostHome);

    expect(fs.existsSync(targetFile)).toBe(false);
  });

  it('(b3) memberless group (no resolved user): writes NOTHING', () => {
    mockUserIdForAgentGroup.mockReturnValue(null);

    provisionPiAuth(piAuthDir, 'ag_orphan', hostHome);

    expect(fs.existsSync(targetFile)).toBe(false);
    expect(mockIsOwner).not.toHaveBeenCalled();
  });

  it('(c) owner’s own group: the owner’s ~/.codex/auth.json is provisioned', () => {
    mockUserIdForAgentGroup.mockReturnValue('playground:owner_01');
    mockIsOwner.mockReturnValue(true);
    mockLoadUserProviderCreds.mockReturnValue(null);

    provisionPiAuth(piAuthDir, 'ag_owner', hostHome);

    expect(fs.existsSync(targetFile)).toBe(true);
    expect(fs.readFileSync(targetFile, 'utf-8')).toBe(OWNER_AUTH_MARKER);
    expect(mockIsOwner).toHaveBeenCalledWith('playground:owner_01');
  });

  it('(d) non-owner with active=apiKey codex creds: writes NOTHING (chatgpt.com is not an API-key endpoint)', () => {
    mockUserIdForAgentGroup.mockReturnValue('telegram:8731035088');
    mockIsOwner.mockReturnValue(false);
    mockLoadUserProviderCreds.mockReturnValue({
      apiKey: { value: 'sk-fixture-key', addedAt: Date.now() },
      oauth: {
        accessToken: 'expired-fixture-access',
        refreshToken: 'expired-fixture-refresh',
        expiresAt: Date.now() - 3600_000,
        addedAt: Date.now() - 86_400_000,
      },
      active: 'apiKey',
    });

    provisionPiAuth(piAuthDir, 'ag_apikey_user', hostHome);

    expect(fs.existsSync(targetFile)).toBe(false);
  });
});
