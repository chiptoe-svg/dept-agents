import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// This file mocks PLAYGROUND_AUTH_BYPASS: true (module-scope, whole file) —
// the opposite of agent-groups.test.ts's `false`. It exists specifically to
// pin the no-leak invariant under the CURRENT production bypass setting: a
// signed-in user with no `agent_group_members` row must get `null`, never
// the "first group in the DB" fallback, even when bypass is on. Bypass only
// changes the ANONYMOUS-caller path; it must never affect the signed-in
// no-membership path. See agent-groups.ts's getPlaygroundAgentForUser doc
// comment for the invariant this test protects.
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, PLAYGROUND_AUTH_BYPASS: true };
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
  // ag_alice is created first (earliest created_at) so it's what the old
  // "first group in the DB" fallback would have returned for bob.
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

describe('getPlaygroundAgentForUser (bypass ON — current production config)', () => {
  it('returns the user’s own group', () => {
    expect(getPlaygroundAgentForUser('playground:alice')?.id).toBe('ag_alice');
  });
  it('returns null for a signed-in user with no membership, even with bypass on (no first-group leak)', () => {
    // bob is a real signed-in user but a member of nothing. Bypass must not
    // resurrect the "first group in the DB" fallback for a signed-in caller —
    // that fallback only applies to the anonymous (userId === null) path.
    expect(getPlaygroundAgentForUser('playground:bob')).toBeNull();
  });
});
