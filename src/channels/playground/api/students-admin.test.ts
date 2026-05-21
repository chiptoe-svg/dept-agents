import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../../../db/connection.js';
import { runMigrations } from '../../../db/migrations/index.js';
import { upsertRosterEntry } from '../../../db/classroom-roster.js';
import { grantRole } from '../../../modules/permissions/db/user-roles.js';
import { createUser } from '../../../modules/permissions/db/users.js';
import type { PlaygroundSession } from '../auth-store.js';
import { handleAddStudent } from './students-admin.js';

const OWNER = 'telegram:owner1';

function session(userId: string | null): PlaygroundSession {
  return { cookieValue: 'c', userId, createdAt: Date.now(), lastActivityAt: Date.now() };
}

function makeOwner(): void {
  const now = new Date().toISOString();
  createUser({ id: OWNER, kind: 'telegram', display_name: 'Owner', created_at: now });
  grantRole({ user_id: OWNER, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now });
}

describe('handleAddStudent — guard paths', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
  });
  afterEach(() => closeDb());

  it('rejects a non-owner session with 403', async () => {
    const r = await handleAddStudent(session('telegram:nobody'), { name: 'Jane', email: 'jane@x.edu' });
    expect(r.status).toBe(403);
  });

  it('rejects an unauthenticated session with 403', async () => {
    const r = await handleAddStudent(session(null), { name: 'Jane', email: 'jane@x.edu' });
    expect(r.status).toBe(403);
  });

  it('rejects a missing name with 400', async () => {
    makeOwner();
    const r = await handleAddStudent(session(OWNER), { name: '   ', email: 'jane@x.edu' });
    expect(r.status).toBe(400);
  });

  it('rejects an invalid email with 400', async () => {
    makeOwner();
    const r = await handleAddStudent(session(OWNER), { name: 'Jane', email: 'not-an-email' });
    expect(r.status).toBe(400);
  });

  it('rejects an email already on the roster with 409', async () => {
    makeOwner();
    upsertRosterEntry({ email: 'dupe@x.edu', user_id: 'class:student_03' });
    const r = await handleAddStudent(session(OWNER), { name: 'Jane', email: 'Dupe@X.edu' });
    expect(r.status).toBe(409);
  });
});
