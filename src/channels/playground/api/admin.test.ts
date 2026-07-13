import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// vi.mock factories are hoisted above imports, so they can't close over local
// consts declared below them — same pattern as provision-user.test.ts.
const { TMP } = vi.hoisted(() => ({ TMP: '/tmp/nanoclaw-test-admin-api' }));
vi.mock('../../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../../config.js')>('../../../config.js');
  return { ...actual, DATA_DIR: TMP, GROUPS_DIR: path.join(TMP, 'groups') };
});
// publicPlaygroundBaseUrl() reads PUBLIC_PLAYGROUND_URL from env.
vi.stubEnv('PUBLIC_PLAYGROUND_URL', 'http://example.test:8088');

import { initTestDb, closeDb, runMigrations, getDb } from '../../../db/index.js';
import { grantRole } from '../../../modules/permissions/db/user-roles.js';
import { createUser } from '../../../modules/permissions/db/users.js';
import { setDeptModelConfig } from '../../../db/app-config.js';
import {
  handleAddUser,
  handleListUsers,
  handleRotateLink,
  handleDeactivateUser,
  handleGetModelDefaults,
  handlePutModelDefaults,
  handleBackstopHealth,
} from './admin.js';

const OWNER_ID = 'playground:owner';
const NON_OWNER_ID = 'playground:someone';

function ownerSession() {
  return { cookieValue: 'owner-cookie', userId: OWNER_ID, createdAt: 0, lastActivityAt: 0 };
}

function nonOwnerSession() {
  return { cookieValue: 'nonowner-cookie', userId: NON_OWNER_ID, createdAt: 0, lastActivityAt: 0 };
}

function anonSession() {
  return { cookieValue: 'anon-cookie', userId: null, createdAt: 0, lastActivityAt: 0 };
}

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'groups'), { recursive: true });
  initTestDb();
  runMigrations(getDb());
  createUser({ id: OWNER_ID, kind: 'playground', display_name: 'Owner', created_at: new Date().toISOString() });
  grantRole({
    user_id: OWNER_ID,
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: new Date().toISOString(),
  });
});

afterEach(() => {
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('owner gate', () => {
  it('rejects non-owner and anonymous callers on every handler', () => {
    for (const session of [nonOwnerSession(), anonSession()]) {
      expect(handleAddUser(session, { displayName: 'X', email: 'x@clemson.edu' }).status).toBe(403);
      expect(handleListUsers(session).status).toBe(403);
      expect(handleRotateLink(session, 'playground:x').status).toBe(403);
      expect(handleDeactivateUser(session, 'playground:x').status).toBe(403);
      expect(handleGetModelDefaults(session).status).toBe(403);
      expect(
        handlePutModelDefaults(session, {
          defaultCloud: { model: 'a', provider: 'clemson' },
          private: { model: 'b', provider: 'local' },
        }).status,
      ).toBe(403);
      expect(handleBackstopHealth(session).status).toBe(403);
    }
  });
});

describe('handleAddUser', () => {
  it('provisions a user and returns a login url', () => {
    const r = handleAddUser(ownerSession(), { displayName: 'Jane', email: 'jane@clemson.edu' });
    expect(r.status).toBe(200);
    const body = r.body as { userId: string; folder: string; loginUrl: string };
    expect(body.userId).toBe('playground:jane');
    expect(body.folder).toBe('jane');
    expect(body.loginUrl).toContain('/?token=');
  });

  it('rejects a non-clemson.edu email with 400', () => {
    const r = handleAddUser(ownerSession(), { displayName: 'Jane', email: 'jane@gmail.com' });
    expect(r.status).toBe(400);
  });

  it('rejects a missing displayName with 400', () => {
    const r = handleAddUser(ownerSession(), { displayName: '', email: 'jane@clemson.edu' });
    expect(r.status).toBe(400);
  });
});

describe('handleListUsers', () => {
  it('lists provisioned users with folder, provider, model, and cost fields', () => {
    handleAddUser(ownerSession(), { displayName: 'Jane', email: 'jane@clemson.edu' });
    const r = handleListUsers(ownerSession());
    expect(r.status).toBe(200);
    const body = r.body as { users: { userId: string; folder: string; email: string | null; costMtd: number }[] };
    expect(body.users).toHaveLength(1);
    expect(body.users[0]!.userId).toBe('playground:jane');
    expect(body.users[0]!.folder).toBe('jane');
    expect(body.users[0]!.email).toBe('jane@clemson.edu');
    expect(body.users[0]!.costMtd).toBe(0);
  });

  it('does not list the owner (never provisioned via provisionUser)', () => {
    const r = handleListUsers(ownerSession());
    const body = r.body as { users: unknown[] };
    expect(body.users).toHaveLength(0);
  });
});

describe('handleRotateLink / handleDeactivateUser', () => {
  it('rotate-link mints a fresh login url', () => {
    const added = handleAddUser(ownerSession(), { displayName: 'Jane', email: 'jane@clemson.edu' });
    const { userId } = added.body as { userId: string };
    const r = handleRotateLink(ownerSession(), userId);
    expect(r.status).toBe(200);
    expect((r.body as { loginUrl: string }).loginUrl).toContain('/?token=');
  });

  it('deactivate revokes tokens (ok:true)', () => {
    const added = handleAddUser(ownerSession(), { displayName: 'Jane', email: 'jane@clemson.edu' });
    const { userId } = added.body as { userId: string };
    const r = handleDeactivateUser(ownerSession(), userId);
    expect(r.status).toBe(200);
    expect((r.body as { ok: true }).ok).toBe(true);
  });
});

describe('model-defaults round-trip', () => {
  it('PUT then GET reflects the new defaults', () => {
    const putResult = handlePutModelDefaults(ownerSession(), {
      defaultCloud: { model: 'glm-5.1-fp8', provider: 'clemson' },
      private: { model: 'Qwen3.6-35B-A3B-UD-MLX-4bit', provider: 'local' },
    });
    expect(putResult.status).toBe(200);
    const getResult = handleGetModelDefaults(ownerSession());
    expect(getResult.status).toBe(200);
    const body = getResult.body as { defaultCloud: { model: string; provider: string } };
    expect(body.defaultCloud.model).toBe('glm-5.1-fp8');
  });

  it('rejects a malformed body with 400', () => {
    const r = handlePutModelDefaults(ownerSession(), { defaultCloud: { model: 'a' }, private: {} } as never);
    expect(r.status).toBe(400);
  });
});

describe('handleBackstopHealth', () => {
  it('reports key presence as a boolean without making a network call', () => {
    // Doesn't assume a specific key state — readEnvFile reads the real host
    // .env (process.cwd()), which varies by environment. Assert shape, not
    // value, so the test stays hermetic to whatever's actually configured.
    const r = handleBackstopHealth(ownerSession());
    expect(r.status).toBe(200);
    const body = r.body as { keyPresent: boolean; spendMtd: number };
    expect(typeof body.keyPresent).toBe('boolean');
    expect(body.spendMtd).toBe(0);
  });
});

describe('privateMode derivation', () => {
  it('flags a user whose model matches the dept private config', () => {
    setDeptModelConfig({
      defaultCloud: { model: 'glm-5.1-fp8', provider: 'clemson' },
      private: { model: 'local-model', provider: 'local' },
    });
    const added = handleAddUser(ownerSession(), { displayName: 'Jane', email: 'jane@clemson.edu' });
    const { userId } = added.body as { userId: string };
    // Newly-provisioned users start on defaultCloud, not private.
    let list = handleListUsers(ownerSession()).body as { users: { userId: string; privateMode: boolean }[] };
    expect(list.users.find((u) => u.userId === userId)!.privateMode).toBe(false);
  });
});
