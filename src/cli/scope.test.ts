/**
 * Tests for read scoping (fixes C6 — the enumeration primitive that armed
 * the credential-proxy and GWS-relay spoofs). `ncl` runs at host authority;
 * an agent caller reaches it from inside a container, so unscoped
 * `list`/`get` handed every tenant's group ids, user handles, and sessions
 * to any agent. `scopeRowsToCaller` restricts reads to the caller's own
 * agent group; `dispatch.ts` resolves it from container_configs.cli_scope.
 *
 * Beyond the pure-function unit tests, several tests below go through
 * `dispatch()` — the real request path — so they fail if someone removes the
 * scoping call from genericList/genericGet, not just if scopeRowsToCaller
 * itself regresses.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgentGroup } from '../db/agent-groups.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../db/container-configs.js';
import { closeDb, getDb, initTestDb, runMigrations } from '../db/index.js';
import { scopeRowsToCaller } from './crud.js';
import { dispatch } from './dispatch.js';
// Side-effect imports: registers the `groups-*` / `users-*` commands used by
// the dispatcher tests below.
import './resources/groups.js';
import './resources/users.js';

const NOW = '2026-07-09T00:00:00Z';

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
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
});
afterEach(() => closeDb());

const rows = [{ id: 'ag_alice' }, { id: 'ag_bob' }];

describe('scopeRowsToCaller', () => {
  it('returns every row for a host caller', () => {
    expect(scopeRowsToCaller(rows, { caller: 'host', agentGroupId: null }, 'id')).toHaveLength(2);
  });

  it('returns only the caller group row for an agent caller', () => {
    const out = scopeRowsToCaller(rows, { caller: 'agent', agentGroupId: 'ag_alice' }, 'id');
    expect(out).toEqual([{ id: 'ag_alice' }]);
  });

  it('returns nothing for an agent caller with no group', () => {
    expect(scopeRowsToCaller(rows, { caller: 'agent', agentGroupId: null }, 'id')).toEqual([]);
  });

  it('scopes by the named column when it is not "id"', () => {
    const wirings = [{ agent_group_id: 'ag_alice' }, { agent_group_id: 'ag_bob' }];
    const out = scopeRowsToCaller(wirings, { caller: 'agent', agentGroupId: 'ag_bob' }, 'agent_group_id');
    expect(out).toEqual([{ agent_group_id: 'ag_bob' }]);
  });

  it('returns nothing for an agent caller when scopeColumn is null (no agent-group column on the resource)', () => {
    const userRows = [{ id: 'tg:1' }, { id: 'tg:2' }];
    expect(scopeRowsToCaller(userRows, { caller: 'agent', agentGroupId: 'ag_alice' }, null)).toEqual([]);
  });

  it('bypasses scoping for an agent caller when cliScope is "all"', () => {
    const out = scopeRowsToCaller(rows, { caller: 'agent', agentGroupId: 'ag_alice', cliScope: 'all' }, 'id');
    expect(out).toEqual(rows);
  });
});

describe('dispatch() applies scoping on the real request path', () => {
  it("groups-list from an agent caller returns only that agent's own group", async () => {
    const resp = await dispatch(
      { id: 'r1', command: 'groups-list', args: {} },
      { caller: 'agent', sessionId: 's1', agentGroupId: 'ag_alice', messagingGroupId: 'mg1' },
    );
    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: Array<{ id: string }> }).data;
    expect(data.map((g) => g.id)).toEqual(['ag_alice']);
  });

  it("groups-config-get --id ag_bob from an agent in ag_alice does not return ag_bob's config", async () => {
    ensureContainerConfig('ag_alice');
    ensureContainerConfig('ag_bob');

    const resp = await dispatch(
      { id: 'r2', command: 'groups-config-get', args: { id: 'ag_bob' } },
      { caller: 'agent', sessionId: 's1', agentGroupId: 'ag_alice', messagingGroupId: 'mg1' },
    );
    expect(resp.ok).toBe(false);
    expect((resp as { ok: false; error: { message: string } }).error.message).toMatch(/No container config/);
  });

  it('a host caller sees every group (no regression)', async () => {
    const resp = await dispatch({ id: 'r3', command: 'groups-list', args: {} }, { caller: 'host' });
    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: Array<{ id: string }> }).data;
    expect(data.map((g) => g.id).sort()).toEqual(['ag_alice', 'ag_bob']);
  });

  it('users-list (scopeColumn: null) returns [] for an agent caller and all rows for a host caller', async () => {
    getDb()
      .prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'telegram', 'alice', ?)`)
      .run('tg:1', NOW);
    getDb()
      .prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'telegram', 'bob', ?)`)
      .run('tg:2', NOW);

    const agentResp = await dispatch(
      { id: 'r4', command: 'users-list', args: {} },
      { caller: 'agent', sessionId: 's1', agentGroupId: 'ag_alice', messagingGroupId: 'mg1' },
    );
    expect(agentResp.ok).toBe(true);
    expect((agentResp as { ok: true; data: unknown[] }).data).toEqual([]);

    const hostResp = await dispatch({ id: 'r5', command: 'users-list', args: {} }, { caller: 'host' });
    expect(hostResp.ok).toBe(true);
    expect((hostResp as { ok: true; data: unknown[] }).data).toHaveLength(2);
  });

  it('cli_scope = "all" bypasses scoping for an agent caller', async () => {
    ensureContainerConfig('ag_alice');
    updateContainerConfigScalars('ag_alice', { cli_scope: 'all' });

    const resp = await dispatch(
      { id: 'r6', command: 'groups-list', args: {} },
      { caller: 'agent', sessionId: 's1', agentGroupId: 'ag_alice', messagingGroupId: 'mg1' },
    );
    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: Array<{ id: string }> }).data;
    expect(data.map((g) => g.id).sort()).toEqual(['ag_alice', 'ag_bob']);
  });
});
