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
  const { setRosterLookupForTests } = await import('./user-provider-resolver.js');
  setRosterLookupForTests((gid: string) => {
    const row = rows.find((r) => r.agentGroupId === gid);
    return row ? { userId: row.userId, classId: 'default' } : null;
  });
}

describe('user-provider-resolver', () => {
  it('returns student apiKey when active=apiKey', async () => {
    const { addApiKey } = await import('./user-provider-auth.js');
    const { resolveUserCreds } = await import('./user-provider-resolver.js');
    await setRoster([{ agentGroupId: 'g1', userId: 'alice@x.edu' }]);
    addApiKey('alice@x.edu', 'claude', 'sk-test');
    const r = await resolveUserCreds('g1', 'claude');
    expect(r).toEqual({ kind: 'apiKey', value: 'sk-test' });
  });

  it('returns oauth accessToken when active=oauth and not expired', async () => {
    const { addOAuth } = await import('./user-provider-auth.js');
    const { resolveUserCreds } = await import('./user-provider-resolver.js');
    await setRoster([{ agentGroupId: 'g1', userId: 'alice@x.edu' }]);
    addOAuth('alice@x.edu', 'claude', {
      accessToken: 'fresh',
      refreshToken: 'rt',
      expiresAt: Date.now() + 3600000,
    });
    const r = await resolveUserCreds('g1', 'claude');
    expect(r).toEqual({ kind: 'oauth', accessToken: 'fresh' });
  });

  it('refreshes oauth when expiry is within 5min', async () => {
    const { addOAuth } = await import('./user-provider-auth.js');
    const { resolveUserCreds, setOAuthRefresherForTests } = await import('./user-provider-resolver.js');
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
    const r = await resolveUserCreds('g1', 'claude');
    expect(r).toEqual({ kind: 'oauth', accessToken: 'refreshed' });
  });

  it('falls back to host .env when provideDefault=true and no creds', async () => {
    const { resolveUserCreds, setClassPoolCredsForTests } = await import('./user-provider-resolver.js');
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
    const r = await resolveUserCreds('g1', 'claude');
    expect(r).toEqual({ kind: 'apiKey', value: 'pool-default-claude' });
  });

  it('returns connect_required when no creds and provideDefault=false', async () => {
    const { resolveUserCreds } = await import('./user-provider-resolver.js');
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
    const r = await resolveUserCreds('g1', 'claude');
    expect(r?.kind).toBe('connect_required');
    expect((r as { provider: string }).provider).toBe('claude');
  });

  it('returns forbidden when allow=false', async () => {
    const { resolveUserCreds } = await import('./user-provider-resolver.js');
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
    const r = await resolveUserCreds('g1', 'claude');
    expect(r?.kind).toBe('forbidden');
  });

  it('returns null when agentGroupId is not in roster (solo install path)', async () => {
    const { resolveUserCreds } = await import('./user-provider-resolver.js');
    await setRoster([]);
    const r = await resolveUserCreds('unknown-gid', 'claude');
    expect(r).toBeNull();
  });

  it('returns null when provider has no policy entry (unconfigured = Mode A fallthrough)', async () => {
    const { resolveUserCreds } = await import('./user-provider-resolver.js');
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
    const r = await resolveUserCreds('g1', 'claude');
    expect(r).toBeNull();
  });
});

// ── C-1: class pool = owner's per-user creds ────────────────────────────
describe('user-provider-resolver: class pool = owner creds (C-1)', () => {
  async function writeProvideDefaultPolicy(providerId: string) {
    fs.writeFileSync(
      path.join(tmpRoot, 'config', 'class-controls.json'),
      JSON.stringify({
        classes: {
          default: {
            tabsVisibleToStudents: [],
            authModesAvailable: [],
            providers: { [providerId]: { allow: true, provideDefault: true, allowByo: false } },
          },
        },
      }),
    );
  }

  async function setOwner(userId: string | null) {
    const { setOwnerLookupForTests } = await import('./user-provider-resolver.js');
    setOwnerLookupForTests(() => userId);
  }

  it('returns owner apiKey when provideDefault and owner has api-key cred', async () => {
    const { addApiKey } = await import('./user-provider-auth.js');
    const { resolveUserCreds } = await import('./user-provider-resolver.js');
    await setRoster([{ agentGroupId: 'g1', userId: 'student@x.edu' }]);
    await setOwner('instructor@x.edu');
    await writeProvideDefaultPolicy('claude');
    addApiKey('instructor@x.edu', 'claude', 'sk-instructor');
    const r = await resolveUserCreds('g1', 'claude');
    expect(r).toEqual({ kind: 'apiKey', value: 'sk-instructor' });
  });

  it('returns owner oauth accessToken when provideDefault and owner has oauth', async () => {
    const { addOAuth } = await import('./user-provider-auth.js');
    const { resolveUserCreds } = await import('./user-provider-resolver.js');
    await setRoster([{ agentGroupId: 'g1', userId: 'student@x.edu' }]);
    await setOwner('instructor@x.edu');
    await writeProvideDefaultPolicy('codex');
    addOAuth('instructor@x.edu', 'codex', {
      accessToken: 'instructor-oauth',
      refreshToken: 'rt',
      expiresAt: Date.now() + 3600_000,
    });
    const r = await resolveUserCreds('g1', 'codex');
    expect(r).toEqual({ kind: 'oauth', accessToken: 'instructor-oauth' });
  });

  it('refreshes owner oauth on near-expiry and persists new token under owner', async () => {
    const { addOAuth, loadUserProviderCreds } = await import('./user-provider-auth.js');
    const { resolveUserCreds, setOAuthRefresherForTests } = await import('./user-provider-resolver.js');
    await setRoster([{ agentGroupId: 'g1', userId: 'student@x.edu' }]);
    await setOwner('instructor@x.edu');
    await writeProvideDefaultPolicy('codex');
    addOAuth('instructor@x.edu', 'codex', {
      accessToken: 'stale',
      refreshToken: 'rt',
      expiresAt: Date.now() + 60_000,
      account: 'instructor@x.edu',
    });
    setOAuthRefresherForTests(async () => ({
      accessToken: 'refreshed',
      refreshToken: 'rt2',
      expiresAt: Date.now() + 3600_000,
    }));
    const r = await resolveUserCreds('g1', 'codex');
    expect(r).toEqual({ kind: 'oauth', accessToken: 'refreshed' });
    // New token should be persisted under owner so the next call doesn't refresh.
    const ownerCreds = loadUserProviderCreds('instructor@x.edu', 'codex');
    expect(ownerCreds?.oauth?.accessToken).toBe('refreshed');
  });

  it('returns null when provideDefault but owner has no creds for that provider', async () => {
    const { resolveUserCreds } = await import('./user-provider-resolver.js');
    await setRoster([{ agentGroupId: 'g1', userId: 'student@x.edu' }]);
    await setOwner('instructor@x.edu');
    await writeProvideDefaultPolicy('claude');
    // No addApiKey/addOAuth for instructor — they haven't connected.
    const r = await resolveUserCreds('g1', 'claude');
    expect(r).toBeNull();
  });

  it('returns null when provideDefault but no owner is configured (solo install)', async () => {
    const { resolveUserCreds } = await import('./user-provider-resolver.js');
    await setRoster([{ agentGroupId: 'g1', userId: 'student@x.edu' }]);
    await setOwner(null);
    await writeProvideDefaultPolicy('claude');
    const r = await resolveUserCreds('g1', 'claude');
    expect(r).toBeNull();
  });

  it('falls back to sibling API key when codex is empty but openai-platform is set', async () => {
    const { addApiKey } = await import('./user-provider-auth.js');
    const { resolveUserCreds } = await import('./user-provider-resolver.js');
    await setRoster([{ agentGroupId: 'g1', userId: 'student@x.edu' }]);
    await setOwner('instructor@x.edu');
    await writeProvideDefaultPolicy('codex');
    addApiKey('instructor@x.edu', 'openai-platform', 'sk-from-platform');
    // No codex creds — proxy is asking for /openai/ route.
    const r = await resolveUserCreds('g1', 'codex');
    expect(r).toEqual({ kind: 'apiKey', value: 'sk-from-platform' });
  });

  it('falls back to sibling API key when openai-platform is empty but codex is set', async () => {
    const { addApiKey } = await import('./user-provider-auth.js');
    const { resolveUserCreds } = await import('./user-provider-resolver.js');
    await setRoster([{ agentGroupId: 'g1', userId: 'student@x.edu' }]);
    await setOwner('instructor@x.edu');
    await writeProvideDefaultPolicy('openai-platform');
    addApiKey('instructor@x.edu', 'codex', 'sk-from-codex');
    const r = await resolveUserCreds('g1', 'openai-platform');
    expect(r).toEqual({ kind: 'apiKey', value: 'sk-from-codex' });
  });
});
