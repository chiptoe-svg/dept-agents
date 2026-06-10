import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('../../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../../config.js')>('../../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-default-participant-api',
    GROUPS_DIR: '/tmp/nanoclaw-test-default-participant-api/groups',
  };
});

import { initTestDb, closeDb, runMigrations, getDb } from '../../../db/index.js';
import { createAgentGroup } from '../../../db/agent-groups.js';
import { grantRole } from '../../../modules/permissions/db/user-roles.js';
import { createUser } from '../../../modules/permissions/db/users.js';
import { _resetScenariosForTest, registerScenario } from '../../../scenarios/registry.js';
import { slotExists } from '../../../default-participant-slot.js';

const TMP = '/tmp/nanoclaw-test-default-participant-api';
const GROUPS = path.join(TMP, 'groups');
const OWNER_ID = 'playground:owner';
const MEMBER_ID = 'playground:member';
const ADMIN_ID = 'playground:globaladmin';

function ownerSession() {
  return { cookieValue: 'owner-cookie', userId: OWNER_ID, createdAt: 0, lastActivityAt: 0 };
}

function nonOwnerSession() {
  return { cookieValue: 'member-cookie', userId: MEMBER_ID, createdAt: 0, lastActivityAt: 0 };
}

function globalAdminSession() {
  return { cookieValue: 'admin-cookie', userId: ADMIN_ID, createdAt: 0, lastActivityAt: 0 };
}

function anonSession() {
  return { cookieValue: 'anon-cookie', userId: null, createdAt: 0, lastActivityAt: 0 };
}

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(GROUPS, { recursive: true });
  initTestDb();
  runMigrations(getDb());
  _resetScenariosForTest();
  registerScenario({
    name: 'stub',
    roles: { user: { label: 'P', permission: 'member', persona: (n) => `persona for ${n}`, greeting: (n) => n } },
    roleForFolder: (f) => (f.startsWith('user_') ? 'user' : null),
    memberName: () => null,
    folderPrefix: { user: 'user_' },
  });
  // Create users and grant owner role
  createUser({ id: OWNER_ID, kind: 'playground', display_name: null, created_at: new Date().toISOString() });
  grantRole({
    user_id: OWNER_ID,
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: new Date().toISOString(),
  });
  // Create global admin user (admin but NOT owner)
  createUser({ id: ADMIN_ID, kind: 'playground', display_name: null, created_at: new Date().toISOString() });
  grantRole({
    user_id: ADMIN_ID,
    role: 'admin',
    agent_group_id: null,
    granted_by: null,
    granted_at: new Date().toISOString(),
  });
});

afterEach(() => {
  _resetScenariosForTest();
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('handleGetDefaultParticipant', () => {
  it('returns 403 for anonymous session', async () => {
    const { handleGetDefaultParticipant } = await import('./default-participant.js');
    const result = handleGetDefaultParticipant(anonSession());
    expect(result.status).toBe(403);
  });

  it('returns 403 for non-owner session', async () => {
    const { handleGetDefaultParticipant } = await import('./default-participant.js');
    const result = handleGetDefaultParticipant(nonOwnerSession());
    expect(result.status).toBe(403);
  });

  it('returns 200 with saved:false and correct templateFolder for owner initially', async () => {
    // Create a user-role group so participantCount > 0
    createAgentGroup({ id: 'ag_u1', name: 'U1', folder: 'user_01', agent_provider: 'pi', created_at: '2026-01-01' });
    const { handleGetDefaultParticipant } = await import('./default-participant.js');
    const result = handleGetDefaultParticipant(ownerSession());
    expect(result.status).toBe(200);
    const body = result.body as {
      saved: boolean;
      templateFolder: string;
      participantCount: number;
      savedAt: string | null;
    };
    expect(body.saved).toBe(false);
    expect(body.templateFolder).toBe('_default_participant');
    expect(body.participantCount).toBe(1);
    expect(body.savedAt).toBeNull();
  });
});

describe('handleSaveDefaultParticipant', () => {
  it('returns 403 for non-owner', async () => {
    const { handleSaveDefaultParticipant } = await import('./default-participant.js');
    const result = handleSaveDefaultParticipant(nonOwnerSession());
    expect(result.status).toBe(403);
  });

  it('returns 200 with ok:true and savedAt, slot exists afterward', async () => {
    const { handleSaveDefaultParticipant } = await import('./default-participant.js');
    const result = handleSaveDefaultParticipant(ownerSession());
    expect(result.status).toBe(200);
    const body = result.body as { ok: boolean; savedAt: string | null };
    expect(body.ok).toBe(true);
    expect(typeof body.savedAt).toBe('string');
    expect(slotExists()).toBe(true);
  });
});

describe('handleApplyDefaultToAll', () => {
  it('returns 403 for non-owner', async () => {
    const { handleApplyDefaultToAll } = await import('./default-participant.js');
    const result = handleApplyDefaultToAll(nonOwnerSession(), {});
    expect(result.status).toBe(403);
  });

  it('returns 400 without confirm:APPLY', async () => {
    const { handleApplyDefaultToAll } = await import('./default-participant.js');
    const result = handleApplyDefaultToAll(ownerSession(), {});
    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toMatch(/confirm/i);
  });

  it('returns 400 with wrong confirm value', async () => {
    const { handleApplyDefaultToAll } = await import('./default-participant.js');
    const result = handleApplyDefaultToAll(ownerSession(), { confirm: 'yes' });
    expect(result.status).toBe(400);
  });

  it('returns 400 when no default saved yet', async () => {
    const { handleApplyDefaultToAll } = await import('./default-participant.js');
    const result = handleApplyDefaultToAll(ownerSession(), { confirm: 'APPLY' });
    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toMatch(/no default/i);
  });

  it('returns 200 with affected count after save', async () => {
    // Create a user-role group so apply-all has something to touch
    createAgentGroup({ id: 'ag_u2', name: 'U2', folder: 'user_02', agent_provider: 'pi', created_at: '2026-01-01' });
    fs.mkdirSync(path.join(GROUPS, 'user_02'), { recursive: true });

    // First save the default
    const { handleSaveDefaultParticipant, handleApplyDefaultToAll } = await import('./default-participant.js');
    const saveResult = handleSaveDefaultParticipant(ownerSession());
    expect(saveResult.status).toBe(200);

    // Then apply to all
    const applyResult = handleApplyDefaultToAll(ownerSession(), { confirm: 'APPLY' });
    expect(applyResult.status).toBe(200);
    const body = applyResult.body as { ok: boolean; affected: number };
    expect(body.ok).toBe(true);
    expect(body.affected).toBe(1);
  });
});

describe('global admin is owner-only gated on destructive ops', () => {
  it('returns 403 for global admin on save', async () => {
    const { handleSaveDefaultParticipant } = await import('./default-participant.js');
    const result = handleSaveDefaultParticipant(globalAdminSession());
    expect(result.status).toBe(403);
  });

  it('returns 403 for global admin on apply-all', async () => {
    const { handleApplyDefaultToAll } = await import('./default-participant.js');
    const result = handleApplyDefaultToAll(globalAdminSession(), { confirm: 'APPLY' });
    expect(result.status).toBe(403);
  });

  it('returns 200 for global admin on GET (read is allowed)', async () => {
    const { handleGetDefaultParticipant } = await import('./default-participant.js');
    const result = handleGetDefaultParticipant(globalAdminSession());
    expect(result.status).toBe(200);
  });
});
