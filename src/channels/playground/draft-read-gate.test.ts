import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { addMember } from '../../modules/permissions/db/agent-group-members.js';
import { grantRole } from '../../modules/permissions/db/user-roles.js';
import { createUser } from '../../modules/permissions/db/users.js';
import { canReadDraft } from './draft-read-gate.js';

function now(): string {
  return new Date().toISOString();
}

function mkGroup(id: string, folder: string): void {
  createAgentGroup({
    id,
    name: folder,
    folder,
    agent_provider: 'codex',
    created_at: now(),
  });
}

describe('canReadDraft', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
  });
  afterEach(() => closeDb());

  it('lets a member read their own agent group', () => {
    mkGroup('ag_1', 'student_01');
    createUser({ id: 'class:student_01', kind: 'class', display_name: 's1', created_at: now() });
    addMember({ user_id: 'class:student_01', agent_group_id: 'ag_1', added_by: null, added_at: now() });
    expect(canReadDraft('student_01', 'class:student_01')).toBe(true);
  });

  it('denies a user reading a different agent group they are not in', () => {
    mkGroup('ag_1', 'student_01');
    mkGroup('ag_2', 'student_02');
    createUser({ id: 'class:student_01', kind: 'class', display_name: 's1', created_at: now() });
    addMember({ user_id: 'class:student_01', agent_group_id: 'ag_1', added_by: null, added_at: now() });
    expect(canReadDraft('student_02', 'class:student_01')).toBe(false);
  });

  it('lets an owner read any agent group', () => {
    mkGroup('ag_2', 'student_02');
    createUser({ id: 'tg:instructor', kind: 'telegram', display_name: 'inst', created_at: now() });
    grantRole({
      user_id: 'tg:instructor',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });
    expect(canReadDraft('student_02', 'tg:instructor')).toBe(true);
  });

  it('allows a folder with no agent group — nothing on disk to protect', () => {
    expect(canReadDraft('draft_nonexistent', 'class:student_01')).toBe(true);
  });

  it('denies an anonymous (no userId) session when the group exists', () => {
    mkGroup('ag_1', 'student_01');
    expect(canReadDraft('student_01', null)).toBe(false);
    expect(canReadDraft('student_01', undefined)).toBe(false);
  });

  it('denies a known user with no membership and no role', () => {
    mkGroup('ag_1', 'student_01');
    createUser({ id: 'class:outsider', kind: 'class', display_name: 'out', created_at: now() });
    expect(canReadDraft('student_01', 'class:outsider')).toBe(false);
  });
});
