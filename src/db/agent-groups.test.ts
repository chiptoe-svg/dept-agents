import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, PLAYGROUND_AUTH_BYPASS: false };
});

import { initTestDb, closeDb, runMigrations, getDb } from './index.js';
import { createAgentGroup, getPlaygroundAgentForUser } from './agent-groups.js';
import { createUser } from '../modules/permissions/db/users.js';
import { addMember } from '../modules/permissions/db/agent-group-members.js';

const NOW = '2026-07-10T00:00:00Z';
beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
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
    created_at: '2026-07-10T00:00:01Z',
    metadata: '{}',
  });
  addMember({ user_id: 'playground:alice', agent_group_id: 'ag_alice', added_by: null, added_at: NOW });
});
afterEach(() => closeDb());

describe('getPlaygroundAgentForUser (bypass off)', () => {
  it('returns the user’s own group', () => {
    expect(getPlaygroundAgentForUser('playground:alice')?.id).toBe('ag_alice');
  });
  it('returns null for a signed-in user with no membership (no first-group leak)', () => {
    // bob is a real user but a member of nothing → must NOT get ag_alice
    expect(getPlaygroundAgentForUser('playground:bob')).toBeNull();
  });
  it('returns null for an anonymous caller when bypass is off', () => {
    expect(getPlaygroundAgentForUser(null)).toBeNull();
  });
});
