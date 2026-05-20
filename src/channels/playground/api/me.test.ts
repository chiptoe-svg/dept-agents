import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PlaygroundSession } from '../auth-store.js';

const sess = (userId: string | null, cookieValue = 'x'): PlaygroundSession =>
  ({ userId, cookieValue }) as PlaygroundSession;

// Shared base mocks that every google-status/disconnect test needs.
function mockBase({
  hasCredentials = false,
  roster = null as { email: string; user_id: string; agent_group_id: string | null } | null,
  cleared = [] as string[],
  metaSet = [] as Array<{ id: string; key: string; value: unknown }>,
} = {}) {
  vi.doMock('../../../student-google-auth.js', () => ({
    hasStudentCredentials: () => hasCredentials,
    clearStudentCredentials: (userId: string) => {
      cleared.push(userId);
    },
  }));
  vi.doMock('../../../db/classroom-roster.js', () => ({
    lookupRosterByUserId: () => roster,
  }));
  vi.doMock('../../../db/agent-groups.js', () => ({
    getPlaygroundAgentForUser: () => null,
    setAgentGroupMetadataKey: (id: string, key: string, value: unknown) => {
      metaSet.push({ id, key, value });
    },
  }));
  vi.doMock('../auth-store.js', () => ({
    revokeSession: () => {},
    revokeSessionsForUser: () => 0,
  }));
}

describe('GET /api/me/google', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('returns connected:false + roster email when user has no credentials', async () => {
    mockBase({
      hasCredentials: false,
      roster: { email: 'alice@example.com', user_id: 'class:student_01', agent_group_id: 'ag_1' },
    });
    const { handleGetGoogleStatus } = await import('./me.js');
    const r = handleGetGoogleStatus(sess('class:student_01'));
    expect(r.status).toBe(200);
    const body = r.body as { connected: boolean; email: string | null };
    expect(body.connected).toBe(false);
    expect(body.email).toBe('alice@example.com');
  });

  it('returns connected:true + roster email when user has credentials', async () => {
    mockBase({
      hasCredentials: true,
      roster: { email: 'bob@example.com', user_id: 'class:student_02', agent_group_id: 'ag_2' },
    });
    const { handleGetGoogleStatus } = await import('./me.js');
    const r = handleGetGoogleStatus(sess('class:student_02'));
    expect(r.status).toBe(200);
    const body = r.body as { connected: boolean; email: string | null };
    expect(body.connected).toBe(true);
    expect(body.email).toBe('bob@example.com');
  });

  it('returns connected:false + null email when user is not on roster', async () => {
    mockBase({ hasCredentials: false, roster: null });
    const { handleGetGoogleStatus } = await import('./me.js');
    const r = handleGetGoogleStatus(sess('class:student_99'));
    expect(r.status).toBe(200);
    const body = r.body as { connected: boolean; email: string | null };
    expect(body.connected).toBe(false);
    expect(body.email).toBeNull();
  });

  it('returns 401 when userId is null', async () => {
    mockBase();
    const { handleGetGoogleStatus } = await import('./me.js');
    const r = handleGetGoogleStatus(sess(null));
    expect(r.status).toBe(401);
  });
});

describe('POST /api/me/google/disconnect', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('clears credentials, unstamps agent_group metadata, returns ok:true', async () => {
    const cleared: string[] = [];
    const metaSet: Array<{ id: string; key: string; value: unknown }> = [];
    mockBase({
      hasCredentials: true,
      roster: { email: 'alice@example.com', user_id: 'class:student_01', agent_group_id: 'ag_abc' },
      cleared,
      metaSet,
    });
    const { handleGoogleDisconnect } = await import('./me.js');
    const r = handleGoogleDisconnect(sess('class:student_01'));
    expect(r.status).toBe(200);
    expect((r.body as { ok: boolean }).ok).toBe(true);
    expect(cleared).toContain('class:student_01');
    expect(metaSet).toEqual([{ id: 'ag_abc', key: 'student_user_id', value: null }]);
  });

  it('is idempotent when no credentials exist — still returns ok:true', async () => {
    const cleared: string[] = [];
    const metaSet: Array<{ id: string; key: string; value: unknown }> = [];
    mockBase({
      hasCredentials: false,
      roster: { email: 'alice@example.com', user_id: 'class:student_01', agent_group_id: 'ag_abc' },
      cleared,
      metaSet,
    });
    const { handleGoogleDisconnect } = await import('./me.js');
    const r = handleGoogleDisconnect(sess('class:student_01'));
    expect(r.status).toBe(200);
    expect((r.body as { ok: boolean }).ok).toBe(true);
    // clearStudentCredentials is always called (no-op when file doesn't exist)
    expect(cleared).toContain('class:student_01');
  });

  it('skips metadata update when user has no roster entry', async () => {
    const cleared: string[] = [];
    const metaSet: Array<{ id: string; key: string; value: unknown }> = [];
    mockBase({ hasCredentials: false, roster: null, cleared, metaSet });
    const { handleGoogleDisconnect } = await import('./me.js');
    const r = handleGoogleDisconnect(sess('class:student_99'));
    expect(r.status).toBe(200);
    expect(metaSet).toHaveLength(0);
  });

  it('returns 401 when userId is null', async () => {
    mockBase();
    const { handleGoogleDisconnect } = await import('./me.js');
    const r = handleGoogleDisconnect(sess(null));
    expect(r.status).toBe(401);
  });
});

describe('GET /api/me/agent', () => {
  afterEach(() => {
    vi.resetModules();
  });

  // resolveRole inside me.ts hits user-roles → getDb. Without a real DB
  // initialized, that throws. Mock just the predicates the call chain uses.
  function mockUserRoles() {
    vi.doMock('../../../modules/permissions/db/user-roles.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../../modules/permissions/db/user-roles.js')>();
      return {
        ...actual,
        isOwner: () => false,
        isGlobalAdmin: () => false,
        isAdminOfAgentGroup: () => false,
      };
    });
  }

  it('returns the user-assigned agent group + user info', async () => {
    mockUserRoles();
    vi.doMock('../../../db/agent-groups.js', () => ({
      getPlaygroundAgentForUser: () => ({ id: 'ag_123', name: 'Felix', folder: 'telegram_main' }),
    }));
    const { handleGetMyAgent } = await import('./me.js');
    const r = handleGetMyAgent(sess('telegram:42'));
    expect(r.status).toBe(200);
    expect((r.body as { agent: { name: string } }).agent.name).toBe('Felix');
  });

  it('returns 404 when no agent group can be resolved', async () => {
    mockUserRoles();
    vi.doMock('../../../db/agent-groups.js', () => ({
      getPlaygroundAgentForUser: () => null,
    }));
    const { handleGetMyAgent } = await import('./me.js');
    const r = handleGetMyAgent(sess('telegram:42'));
    expect(r.status).toBe(404);
  });

  it('handles anonymous (userId null) via the fallback path', async () => {
    mockUserRoles();
    vi.doMock('../../../db/agent-groups.js', () => ({
      getPlaygroundAgentForUser: () => ({ id: 'ag_999', name: 'main', folder: 'main' }),
    }));
    const { handleGetMyAgent } = await import('./me.js');
    const r = handleGetMyAgent(sess(null));
    expect(r.status).toBe(200);
    expect((r.body as { agent: { id: string } }).agent.id).toBe('ag_999');
  });
});

describe('POST /api/me/logout', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('handleLogout revokes the current session', async () => {
    let revoked: string | undefined;
    vi.doMock('../auth-store.js', () => ({
      revokeSession: (cookie: string) => {
        revoked = cookie;
      },
      revokeSessionsForUser: () => 0,
    }));
    vi.doMock('../../../db/agent-groups.js', () => ({
      getPlaygroundAgentForUser: () => null,
    }));
    const { handleLogout } = await import('./me.js');
    const r = handleLogout(sess('telegram:42', 'cookie-x'));
    expect(r.status).toBe(200);
    expect(revoked).toBe('cookie-x');
  });
});

describe('POST /api/me/logout-all', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('handleLogoutAll revokes all sessions for the user', async () => {
    let revokedUser: string | undefined;
    vi.doMock('../auth-store.js', () => ({
      revokeSession: () => {},
      revokeSessionsForUser: (userId: string) => {
        revokedUser = userId;
        return 3;
      },
    }));
    vi.doMock('../../../db/agent-groups.js', () => ({
      getPlaygroundAgentForUser: () => null,
    }));
    const { handleLogoutAll } = await import('./me.js');
    const r = handleLogoutAll(sess('telegram:42', 'cookie-x'));
    expect(r.status).toBe(200);
    expect(revokedUser).toBe('telegram:42');
    expect((r.body as { revoked: number }).revoked).toBe(3);
  });

  it('handleLogoutAll falls back to single-session revoke when userId is null', async () => {
    let revokedCookie: string | undefined;
    vi.doMock('../auth-store.js', () => ({
      revokeSession: (cookie: string) => {
        revokedCookie = cookie;
      },
      revokeSessionsForUser: () => 0,
    }));
    vi.doMock('../../../db/agent-groups.js', () => ({
      getPlaygroundAgentForUser: () => null,
    }));
    const { handleLogoutAll } = await import('./me.js');
    const r = handleLogoutAll(sess(null, 'cookie-x'));
    expect(r.status).toBe(200);
    expect(revokedCookie).toBe('cookie-x');
  });
});
