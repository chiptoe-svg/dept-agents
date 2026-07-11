import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initTestDb, closeDb, runMigrations, getDb } from '../db/index.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { createUser } from '../modules/permissions/db/users.js';
import { addMember } from '../modules/permissions/db/agent-group-members.js';
import { userIdForAgentGroup } from './agent-group-user.js';

const NOW = '2026-07-10T00:00:00Z';
beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
  createUser({ id: 'playground:alice', kind: 'playground', display_name: 'Alice', created_at: NOW });
  createAgentGroup({
    id: 'ag_alice',
    name: 'Alice',
    folder: 'user_alice',
    agent_provider: 'pi',
    created_at: NOW,
    metadata: '{}',
  });
  addMember({ user_id: 'playground:alice', agent_group_id: 'ag_alice', added_by: null, added_at: NOW });
  createAgentGroup({
    id: 'ag_empty',
    name: 'Empty',
    folder: 'user_empty',
    agent_provider: 'pi',
    created_at: NOW,
    metadata: '{}',
  });
});
afterEach(() => closeDb());

describe('userIdForAgentGroup', () => {
  it('returns the group’s member', () => {
    expect(userIdForAgentGroup('ag_alice')).toBe('playground:alice');
  });
  it('returns null for a group with no member', () => {
    expect(userIdForAgentGroup('ag_empty')).toBeNull();
  });
  it('returns null for an unknown group', () => {
    expect(userIdForAgentGroup('ag_nope')).toBeNull();
  });
});
