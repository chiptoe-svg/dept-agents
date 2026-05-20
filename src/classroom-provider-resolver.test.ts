import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpRoot: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-test-'));
  process.chdir(tmpRoot);
  fs.mkdirSync(path.join(tmpRoot, 'config'), { recursive: true });
  vi.resetModules();
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.resetModules();
});

async function setRoster(rows: { agentGroupId: string; userId: string }[]) {
  const { setRosterLookupForTests } = await import('./classroom-provider-resolver.js');
  setRosterLookupForTests((gid: string) => {
    const row = rows.find((r) => r.agentGroupId === gid);
    return row ? { userId: row.userId, classId: 'default' } : null;
  });
}

describe('classroom-provider-resolver', () => {
  it('returns student apiKey when active=apiKey', async () => {
    const { addApiKey } = await import('./student-provider-auth.js');
    const { resolveStudentCreds } = await import('./classroom-provider-resolver.js');
    await setRoster([{ agentGroupId: 'g1', userId: 'alice@x.edu' }]);
    addApiKey('alice@x.edu', 'claude', 'sk-test');
    const r = await resolveStudentCreds('g1', 'claude');
    expect(r).toEqual({ kind: 'apiKey', value: 'sk-test' });
  });

  it('returns oauth accessToken when active=oauth and not expired', async () => {
    const { addOAuth } = await import('./student-provider-auth.js');
    const { resolveStudentCreds } = await import('./classroom-provider-resolver.js');
    await setRoster([{ agentGroupId: 'g1', userId: 'alice@x.edu' }]);
    addOAuth('alice@x.edu', 'claude', {
      accessToken: 'fresh',
      refreshToken: 'rt',
      expiresAt: Date.now() + 3600000,
    });
    const r = await resolveStudentCreds('g1', 'claude');
    expect(r).toEqual({ kind: 'oauth', accessToken: 'fresh' });
  });

  it('refreshes oauth when expiry is within 5min', async () => {
    const { addOAuth } = await import('./student-provider-auth.js');
    const { resolveStudentCreds, setOAuthRefresherForTests } = await import('./classroom-provider-resolver.js');
    await setRoster([{ agentGroupId: 'g1', userId: 'alice@x.edu' }]);
    addOAuth('alice@x.edu', 'claude', {
      accessToken: 'stale',
      refreshToken: 'rt',
      expiresAt: Date.now() + 60000,
    });
    setOAuthRefresherForTests(async () => ({
      accessToken: 'refreshed',
      refreshToken: 'rt2',
      expiresAt: Date.now() + 3600000,
    }));
    const r = await resolveStudentCreds('g1', 'claude');
    expect(r).toEqual({ kind: 'oauth', accessToken: 'refreshed' });
  });

  it('falls back to host .env when provideDefault=true and no creds', async () => {
    const { resolveStudentCreds, setClassPoolCredsForTests } = await import('./classroom-provider-resolver.js');
    await setRoster([{ agentGroupId: 'g1', userId: 'alice@x.edu' }]);
    fs.writeFileSync(
      path.join(tmpRoot, 'config', 'class-controls.json'),
      JSON.stringify({
        classes: {
          default: {
            tabsVisibleToStudents: [],
            authModesAvailable: [],
            providers: { claude: { allow: true, provideDefault: true, allowByo: true } },
          },
        },
      }),
    );
    setClassPoolCredsForTests((classId, provider) => ({
      kind: 'apiKey',
      value: `pool-${classId}-${provider}`,
    }));
    const r = await resolveStudentCreds('g1', 'claude');
    expect(r).toEqual({ kind: 'apiKey', value: 'pool-default-claude' });
  });

  it('returns connect_required when no creds and provideDefault=false', async () => {
    const { resolveStudentCreds } = await import('./classroom-provider-resolver.js');
    await setRoster([{ agentGroupId: 'g1', userId: 'alice@x.edu' }]);
    fs.writeFileSync(
      path.join(tmpRoot, 'config', 'class-controls.json'),
      JSON.stringify({
        classes: {
          default: {
            tabsVisibleToStudents: [],
            authModesAvailable: [],
            providers: { claude: { allow: true, provideDefault: false, allowByo: true } },
          },
        },
      }),
    );
    const r = await resolveStudentCreds('g1', 'claude');
    expect(r?.kind).toBe('connect_required');
    expect((r as { provider: string }).provider).toBe('claude');
  });

  it('returns forbidden when allow=false', async () => {
    const { resolveStudentCreds } = await import('./classroom-provider-resolver.js');
    await setRoster([{ agentGroupId: 'g1', userId: 'alice@x.edu' }]);
    fs.writeFileSync(
      path.join(tmpRoot, 'config', 'class-controls.json'),
      JSON.stringify({
        classes: {
          default: {
            tabsVisibleToStudents: [],
            authModesAvailable: [],
            providers: { claude: { allow: false, provideDefault: false, allowByo: false } },
          },
        },
      }),
    );
    const r = await resolveStudentCreds('g1', 'claude');
    expect(r?.kind).toBe('forbidden');
  });

  it('returns null when agentGroupId is not in roster (solo install path)', async () => {
    const { resolveStudentCreds } = await import('./classroom-provider-resolver.js');
    await setRoster([]);
    const r = await resolveStudentCreds('unknown-gid', 'claude');
    expect(r).toBeNull();
  });

  it('returns null when provider has no policy entry (unconfigured = Mode A fallthrough)', async () => {
    const { resolveStudentCreds } = await import('./classroom-provider-resolver.js');
    await setRoster([{ agentGroupId: 'g1', userId: 'alice@x.edu' }]);
    // Write a class-controls with empty providers map (fresh class)
    fs.writeFileSync(
      path.join(tmpRoot, 'config', 'class-controls.json'),
      JSON.stringify({
        classes: {
          default: {
            tabsVisibleToStudents: [],
            authModesAvailable: [],
            providers: {},
          },
        },
      }),
    );
    const r = await resolveStudentCreds('g1', 'claude');
    expect(r).toBeNull();
  });
});
