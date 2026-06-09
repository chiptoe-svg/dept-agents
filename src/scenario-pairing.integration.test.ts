import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from './db/index.js';
import { runPairConsumers, type PairContext } from './channels/pair-consumer-registry.js';
import './scenario-pairing.js'; // generic consumer (registered at import)
import './scenarios/industryai_seminar/scenario.js'; // registers the REAL seminar scenario

function ctx(folder: string, agentGroupId: string): PairContext {
  return { agentGroupId, pairedUserId: 'tg:7', consumedEmail: null, targetFolder: folder, channel: 'telegram' };
}

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
  createAgentGroup({ id: 'ag_u3', name: 'Dana', folder: 'user_03', agent_provider: 'pi', created_at: '2026-01-01' });
});

afterEach(() => {
  closeDb();
});

describe('industryai_seminar pairing (real scenario)', () => {
  it('a participant (user_NN) is greeted as a Participant with no admin grant', async () => {
    const [r] = await runPairConsumers(ctx('user_03', 'ag_u3'));
    expect(r.confirmation).toContain('Welcome to the seminar');
    expect(r.suppressDefaultConfirmation).toBe(true);
    const roles = getDb().prepare('SELECT * FROM user_roles WHERE user_id = ?').all('tg:7');
    expect(roles).toEqual([]); // participant = member, no admin
  });

  it('uses the agent-group name in the greeting (memberName via the contract)', async () => {
    const [r] = await runPairConsumers(ctx('user_03', 'ag_u3'));
    expect(r.confirmation).toContain('Dana');
  });
});
