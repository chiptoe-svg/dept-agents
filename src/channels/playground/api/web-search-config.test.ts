import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';

vi.mock('../../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../../config.js')>('../../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-web-search-config-api',
  };
});

// Mock container-restart — we don't want real container ops in tests
vi.mock('../../../container-restart.js', () => ({
  restartAgentGroupContainers: vi.fn().mockReturnValue(0),
}));

import { initTestDb, closeDb, runMigrations, getDb } from '../../../db/index.js';
import { grantRole } from '../../../modules/permissions/db/user-roles.js';
import { createUser } from '../../../modules/permissions/db/users.js';
import { readWebSearchProvider } from '../../../web-search-config.js';

const TMP = '/tmp/nanoclaw-test-web-search-config-api';
const OWNER_ID = 'playground:owner';
const MEMBER_ID = 'playground:member';

function ownerSession() {
  return { cookieValue: 'owner-cookie', userId: OWNER_ID, createdAt: 0, lastActivityAt: 0 };
}

function nonOwnerSession() {
  return { cookieValue: 'member-cookie', userId: MEMBER_ID, createdAt: 0, lastActivityAt: 0 };
}

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  initTestDb();
  runMigrations(getDb());
  // Create users before granting roles (FK constraint)
  createUser({ id: OWNER_ID, kind: 'playground', display_name: null, created_at: new Date().toISOString() });
  grantRole({
    user_id: OWNER_ID,
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: new Date().toISOString(),
  });
  createUser({ id: MEMBER_ID, kind: 'playground', display_name: null, created_at: new Date().toISOString() });
});

afterEach(() => {
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
  // Restore env vars
  delete process.env.WEB_SEARCH_API_KEY;
  delete process.env.SEARXNG_URL;
});

describe('handleGetWebSearchConfig', () => {
  it('returns 403 for non-owner (member)', async () => {
    const { handleGetWebSearchConfig } = await import('./web-search-config.js');
    const result = await handleGetWebSearchConfig(nonOwnerSession());
    expect(result.status).toBe(403);
  });

  it('returns 200 for owner with correct shape', async () => {
    // Point SEARXNG_URL to something unreachable so probe returns false deterministically
    process.env.SEARXNG_URL = 'http://127.0.0.1:19999';
    const { handleGetWebSearchConfig } = await import('./web-search-config.js');
    const result = await handleGetWebSearchConfig(ownerSession());
    expect(result.status).toBe(200);
    const body = result.body as { active: string; backends: Array<{ id: string; available: boolean }> };
    expect(body.active).toBe('searxng'); // default when no config file
    const ids = body.backends.map((b) => b.id);
    expect(ids).toContain('brave');
    expect(ids).toContain('searxng');
    expect(ids).toContain('openai');
    // openai is never available in v1
    const openaiEntry = body.backends.find((b) => b.id === 'openai')!;
    expect(openaiEntry.available).toBe(false);
    // brave unavailable — no WEB_SEARCH_API_KEY set
    const braveEntry = body.backends.find((b) => b.id === 'brave')!;
    expect(braveEntry.available).toBe(false);
  });
});

describe('handlePostWebSearchConfig', () => {
  it('returns 403 for non-owner (member)', async () => {
    const { handlePostWebSearchConfig } = await import('./web-search-config.js');
    const result = handlePostWebSearchConfig(nonOwnerSession(), { provider: 'brave' });
    expect(result.status).toBe(403);
  });

  it('returns 400 for provider:openai (unavailable)', async () => {
    const { handlePostWebSearchConfig } = await import('./web-search-config.js');
    const result = handlePostWebSearchConfig(ownerSession(), { provider: 'openai' });
    expect(result.status).toBe(400);
  });

  it('returns 400 for provider:nonsense', async () => {
    const { handlePostWebSearchConfig } = await import('./web-search-config.js');
    const result = handlePostWebSearchConfig(ownerSession(), { provider: 'nonsense' });
    expect(result.status).toBe(400);
  });

  it('returns 400 for provider:brave without WEB_SEARCH_API_KEY', async () => {
    delete process.env.WEB_SEARCH_API_KEY;
    const { handlePostWebSearchConfig } = await import('./web-search-config.js');
    const result = handlePostWebSearchConfig(ownerSession(), { provider: 'brave' });
    expect(result.status).toBe(400);
  });

  it('returns 200 for provider:brave with WEB_SEARCH_API_KEY set', async () => {
    const prev = process.env.WEB_SEARCH_API_KEY;
    process.env.WEB_SEARCH_API_KEY = 'test-key-12345';
    try {
      const { handlePostWebSearchConfig } = await import('./web-search-config.js');
      const result = handlePostWebSearchConfig(ownerSession(), { provider: 'brave' });
      expect(result.status).toBe(200);
      const body = result.body as { ok: boolean; active: string };
      expect(body.ok).toBe(true);
      expect(body.active).toBe('brave');
      // Persisted
      expect(readWebSearchProvider()).toBe('brave');
    } finally {
      if (prev === undefined) delete process.env.WEB_SEARCH_API_KEY;
      else process.env.WEB_SEARCH_API_KEY = prev;
    }
  });
});
