import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from './db/index.js';
import { runPairConsumers, type PairContext } from './channels/pair-consumer-registry.js';
import { _resetScenariosForTest, registerScenario } from './scenarios/registry.js';
import type { Scenario } from './scenarios/types.js';
import './scenario-pairing.js'; // registers the generic consumer as a side effect

// A four-role stub: owner→global-admin, assistant→scoped-admin, user→member.
function stubScenario(): Scenario {
  return {
    name: 'stub',
    roles: {
      owner: { label: 'Boss', permission: 'global-admin', persona: (n) => `p ${n}`, greeting: (n) => `hi boss ${n}` },
      assistant: {
        label: 'Lead',
        permission: 'scoped-admin',
        persona: (n) => `p ${n}`,
        greeting: (n) => `hi lead ${n}`,
      },
      user: { label: 'Member', permission: 'member', persona: (n) => `p ${n}`, greeting: (n) => `hi ${n}` },
    },
    roleForFolder: (f) =>
      f.startsWith('boss_') ? 'owner' : f.startsWith('lead_') ? 'assistant' : f.startsWith('member_') ? 'user' : null,
    memberName: (f) => `Name(${f})`,
  };
}

function ctx(folder: string, agentGroupId: string): PairContext {
  return { agentGroupId, pairedUserId: 'tg:42', consumedEmail: 'x@y.edu', targetFolder: folder, channel: 'telegram' };
}

function rolesFor(userId: string): { role: string; agent_group_id: string | null }[] {
  return getDb().prepare('SELECT role, agent_group_id FROM user_roles WHERE user_id = ?').all(userId) as {
    role: string;
    agent_group_id: string | null;
  }[];
}

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
  // The paired user must exist before grantRole (FK user_roles.user_id → users).
  // In production the pairing flow records the user before consumers run.
  getDb()
    .prepare("INSERT INTO users (id, kind, display_name, created_at) VALUES ('tg:42', 'telegram', NULL, '2026-01-01')")
    .run();
  _resetScenariosForTest();
  registerScenario(stubScenario());
  createAgentGroup({ id: 'ag_boss', name: 'B', folder: 'boss_01', agent_provider: 'pi', created_at: '2026-01-01' });
  createAgentGroup({ id: 'ag_lead', name: 'L', folder: 'lead_01', agent_provider: 'pi', created_at: '2026-01-01' });
  createAgentGroup({ id: 'ag_m1', name: 'M1', folder: 'member_01', agent_provider: 'pi', created_at: '2026-01-01' });
  createAgentGroup({ id: 'ag_m2', name: 'M2', folder: 'member_02', agent_provider: 'pi', created_at: '2026-01-01' });
});

afterEach(() => {
  // The generic consumer is registered once via the module-load import above
  // and reused across tests; only the DB is per-test state.
  closeDb();
});

describe('scenario pair consumer', () => {
  it('returns {} for a non-member folder', async () => {
    const [r] = await runPairConsumers(ctx('dm-with-someone', 'ag_x'));
    expect(r).toEqual({});
  });

  it('owner → global admin + greeting from the contract', async () => {
    const [r] = await runPairConsumers(ctx('boss_01', 'ag_boss'));
    expect(r.confirmation).toBe('hi boss Name(boss_01)');
    expect(r.suppressDefaultConfirmation).toBe(true);
    expect(rolesFor('tg:42')).toEqual([{ role: 'admin', agent_group_id: null }]);
  });

  it('assistant → scoped admin over every other user/assistant group', async () => {
    await runPairConsumers(ctx('lead_01', 'ag_lead'));
    const granted = rolesFor('tg:42')
      .map((g) => g.agent_group_id)
      .sort();
    expect(granted).toEqual(['ag_m1', 'ag_m2']);
  });

  it('user → no role grant, greeting only', async () => {
    const [r] = await runPairConsumers(ctx('member_01', 'ag_m1'));
    expect(r.confirmation).toBe('hi Name(member_01)');
    expect(rolesFor('tg:42')).toEqual([]);
  });
});
