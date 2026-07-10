import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-authz',
    GROUPS_DIR: '/tmp/nanoclaw-test-authz/groups',
    PLAYGROUND_AUTH_BYPASS: false,
  };
});

import { initTestDb, closeDb, runMigrations, getDb } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createUser } from '../../modules/permissions/db/users.js';
import { addMember } from '../../modules/permissions/db/agent-group-members.js';
import { requireGroupAccess } from './require-group-access.js';

const TMP = '/tmp/nanoclaw-test-authz';
const GROUPS = path.join(TMP, 'groups');
const NOW = '2026-07-09T00:00:00Z';

function seed(): void {
  createUser({ id: 'playground:alice', kind: 'playground', display_name: 'Alice', created_at: NOW });
  createUser({ id: 'playground:bob', kind: 'playground', display_name: 'Bob', created_at: NOW });
  createAgentGroup({
    id: 'ag_alice',
    name: 'Alice',
    folder: 'user_alice',
    agent_provider: 'pi',
    created_at: NOW,
    metadata: '{}',
  });
  createAgentGroup({
    id: 'ag_bob',
    name: 'Bob',
    folder: 'user_bob',
    agent_provider: 'pi',
    created_at: NOW,
    metadata: '{}',
  });
  addMember({ user_id: 'playground:alice', agent_group_id: 'ag_alice', added_by: null, added_at: NOW });
  addMember({ user_id: 'playground:bob', agent_group_id: 'ag_bob', added_by: null, added_at: NOW });
  fs.mkdirSync(path.join(GROUPS, 'user_alice'), { recursive: true });
  fs.mkdirSync(path.join(GROUPS, 'user_bob'), { recursive: true });
}

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(GROUPS, { recursive: true });
  initTestDb();
  runMigrations(getDb());
  seed();
});

afterEach(() => {
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('requireGroupAccess', () => {
  it('allows a member on their own group', () => {
    expect(requireGroupAccess('user_alice', 'playground:alice')).toBeNull();
  });

  it('denies a member on another user group', () => {
    expect(requireGroupAccess('user_bob', 'playground:alice')).toBe('not_member');
  });

  it('denies an anonymous caller', () => {
    expect(requireGroupAccess('user_alice', null)).toBe('no_session');
  });

  it('fails closed on an unknown folder', () => {
    expect(requireGroupAccess('user_nonexistent', 'playground:alice')).toBe('unknown_group');
  });
});
