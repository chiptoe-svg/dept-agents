import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const NOW = '2026-07-10T00:00:00Z';

let tmpRoot: string;
let originalCwd: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-test-'));
  process.chdir(tmpRoot);
  fs.mkdirSync(path.join(tmpRoot, 'config'), { recursive: true });
  vi.resetModules();
  // Seed the central DB with the entity model the resolver reads:
  // g1 has one member (playground:alice); g_empty has none.
  const { initTestDb, runMigrations, getDb } = await import('./db/index.js');
  initTestDb();
  runMigrations(getDb());
  const { createUser } = await import('./modules/permissions/db/users.js');
  const { createAgentGroup } = await import('./db/agent-groups.js');
  const { addMember } = await import('./modules/permissions/db/agent-group-members.js');
  createUser({ id: 'playground:alice', kind: 'playground', display_name: 'Alice', created_at: NOW });
  createAgentGroup({
    id: 'g1',
    name: 'Alice',
    folder: 'user_alice',
    agent_provider: 'pi',
    created_at: NOW,
    metadata: '{}',
  });
  addMember({ user_id: 'playground:alice', agent_group_id: 'g1', added_by: null, added_at: NOW });
  createAgentGroup({
    id: 'g_empty',
    name: 'Empty',
    folder: 'user_empty',
    agent_provider: 'pi',
    created_at: NOW,
    metadata: '{}',
  });
});

afterEach(async () => {
  const { closeDb } = await import('./db/index.js');
  closeDb();
  process.chdir(originalCwd);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.resetModules();
});

describe('user-provider-resolver (entity model, connect-optional)', () => {
  it('returns the member’s apiKey when active=apiKey', async () => {
    const { addApiKey } = await import('./user-provider-auth.js');
    const { resolveUserCreds } = await import('./user-provider-resolver.js');
    addApiKey('playground:alice', 'claude', 'sk-test');
    const r = await resolveUserCreds('g1', 'claude');
    expect(r).toEqual({ kind: 'apiKey', value: 'sk-test' });
  });

  it('returns the member’s oauth accessToken when active=oauth and not expired', async () => {
    const { addOAuth } = await import('./user-provider-auth.js');
    const { resolveUserCreds } = await import('./user-provider-resolver.js');
    addOAuth('playground:alice', 'claude', {
      accessToken: 'fresh',
      refreshToken: 'rt',
      expiresAt: Date.now() + 3600000,
    });
    const r = await resolveUserCreds('g1', 'claude');
    expect(r).toEqual({ kind: 'oauth', accessToken: 'fresh' });
  });

  it('refreshes oauth when expiry is within 5min and persists under the member', async () => {
    const { addOAuth, loadUserProviderCreds } = await import('./user-provider-auth.js');
    const { resolveUserCreds, setOAuthRefresherForTests } = await import('./user-provider-resolver.js');
    addOAuth('playground:alice', 'claude', {
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
    expect(loadUserProviderCreds('playground:alice', 'claude')?.oauth?.accessToken).toBe('refreshed');
  });

  it('falls back to null (dept backstop) when oauth refresh fails', async () => {
    const { addOAuth } = await import('./user-provider-auth.js');
    const { resolveUserCreds, setOAuthRefresherForTests } = await import('./user-provider-resolver.js');
    addOAuth('playground:alice', 'claude', {
      accessToken: 'stale',
      refreshToken: 'rt',
      expiresAt: Date.now() + 60000,
    });
    setOAuthRefresherForTests(async () => null);
    const r = await resolveUserCreds('g1', 'claude');
    expect(r).toBeNull();
  });

  it('returns null (dept backstop) when the member has no creds — not a policy object', async () => {
    const { resolveUserCreds } = await import('./user-provider-resolver.js');
    const r = await resolveUserCreds('g1', 'claude');
    expect(r).toBeNull();
  });

  it('returns null (dept backstop) for a memberless group', async () => {
    const { resolveUserCreds } = await import('./user-provider-resolver.js');
    const r = await resolveUserCreds('g_empty', 'claude');
    expect(r).toBeNull();
  });

  it('returns null (dept backstop) for an unknown group', async () => {
    const { resolveUserCreds } = await import('./user-provider-resolver.js');
    const r = await resolveUserCreds('g_nope', 'claude');
    expect(r).toBeNull();
  });
});

describe('user-provider-resolver: connect is OPTIONAL — never forbidden / connect_required', () => {
  // Hostile fixture: a classroom_roster binding, which the OLD resolver
  // consulted (the per-class policy module it also read is deleted).
  // The rewritten resolver must ignore it — no input may produce a policy
  // sentinel.
  async function seedHostileRosterBinding() {
    const { upsertRosterEntry } = await import('./db/classroom-roster.js');
    upsertRosterEntry({ email: 'alice@x.edu', user_id: 'playground:alice', agent_group_id: 'g1' });
  }

  it('never returns forbidden or connect_required, even with a roster binding present', async () => {
    const { resolveUserCreds } = await import('./user-provider-resolver.js');
    await seedHostileRosterBinding();
    const r = await resolveUserCreds('g1', 'claude');
    expect(r).toBeNull();
    expect(r === null || (r.kind !== 'forbidden' && r.kind !== 'connect_required')).toBe(true);
  });
});

describe('user-provider-resolver: sibling API-key fallback (re-keyed to the member)', () => {
  it('falls back to the member’s openai-platform key when codex is requested', async () => {
    const { addApiKey } = await import('./user-provider-auth.js');
    const { resolveUserCreds } = await import('./user-provider-resolver.js');
    addApiKey('playground:alice', 'openai-platform', 'sk-from-platform');
    const r = await resolveUserCreds('g1', 'codex');
    expect(r).toEqual({ kind: 'apiKey', value: 'sk-from-platform' });
  });

  it('falls back to the member’s codex key when openai-platform is requested', async () => {
    const { addApiKey } = await import('./user-provider-auth.js');
    const { resolveUserCreds } = await import('./user-provider-resolver.js');
    addApiKey('playground:alice', 'codex', 'sk-from-codex');
    const r = await resolveUserCreds('g1', 'openai-platform');
    expect(r).toEqual({ kind: 'apiKey', value: 'sk-from-codex' });
  });
});

describe('user-provider-resolver: backstop recorder hook', () => {
  it('records the backstop when resolution falls through to null', async () => {
    const { resolveUserCreds, setBackstopRecorder } = await import('./user-provider-resolver.js');
    const calls: Array<[string, string]> = [];
    setBackstopRecorder((gid, pid) => calls.push([gid, pid]));
    const r = await resolveUserCreds('g1', 'claude');
    expect(r).toBeNull();
    expect(calls).toEqual([['g1', 'claude']]);
  });

  it('records the backstop for a memberless group', async () => {
    const { resolveUserCreds, setBackstopRecorder } = await import('./user-provider-resolver.js');
    const calls: Array<[string, string]> = [];
    setBackstopRecorder((gid, pid) => calls.push([gid, pid]));
    await resolveUserCreds('g_empty', 'codex');
    expect(calls).toEqual([['g_empty', 'codex']]);
  });

  it('still returns null (backstop) when the recorder throws — recorder failure never propagates', async () => {
    const { resolveUserCreds, setBackstopRecorder } = await import('./user-provider-resolver.js');
    setBackstopRecorder(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });
    const r = await resolveUserCreds('g1', 'claude');
    expect(r).toBeNull();
  });

  it('does NOT record a backstop when the member’s own creds are used', async () => {
    const { addApiKey } = await import('./user-provider-auth.js');
    const { resolveUserCreds, setBackstopRecorder } = await import('./user-provider-resolver.js');
    const calls: Array<[string, string]> = [];
    setBackstopRecorder((gid, pid) => calls.push([gid, pid]));
    addApiKey('playground:alice', 'claude', 'sk-test');
    const r = await resolveUserCreds('g1', 'claude');
    expect(r).toEqual({ kind: 'apiKey', value: 'sk-test' });
    expect(calls).toEqual([]);
  });
});
