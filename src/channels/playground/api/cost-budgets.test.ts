import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import { evaluateBudget, budgetForAgent } from './cost-budgets.js';

vi.mock('../../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../../config.js')>('../../../config.js');
  return {
    ...actual,
    PROJECT_ROOT: '/tmp/nanoclaw-test-cost-budgets',
    DATA_DIR: '/tmp/nanoclaw-test-cost-budgets/data',
  };
});

// Mock usage — no real session DBs in tests
vi.mock('./usage.js', () => ({
  aggregateAgentUsage: vi.fn().mockReturnValue({ thisMonth: { costUsd: 0 }, total: { costUsd: 0 } }),
}));

// Mock container-configs — no real DB row needed for these tests
vi.mock('../../../db/container-configs.js', () => ({
  getContainerConfig: vi.fn().mockReturnValue(undefined),
}));

import { initTestDb, closeDb, runMigrations, getDb } from '../../../db/index.js';
import { grantRole } from '../../../modules/permissions/db/user-roles.js';
import { createUser } from '../../../modules/permissions/db/users.js';
import { createAgentGroup } from '../../../db/agent-groups.js';
import { registerScenario, _resetScenariosForTest } from '../../../scenarios/registry.js';
import type { Scenario } from '../../../scenarios/types.js';

const TMP = '/tmp/nanoclaw-test-cost-budgets';
const OWNER_ID = 'playground:owner';
const MEMBER_ID = 'playground:member';

// Minimal scenario: user_ prefix = member, _default_ prefix = null (template)
const testScenario: Scenario = {
  name: 'test_scenario',
  roles: {
    owner: { label: 'Instructor', permission: 'global-admin', persona: () => '', greeting: () => '' },
    user: { label: 'Participant', permission: 'member', persona: () => '', greeting: () => '' },
  },
  roleForFolder: (folder) => {
    if (folder.startsWith('user_')) return 'user';
    if (folder.startsWith('instructor_')) return 'owner';
    return null;
  },
  memberName: (folder) => folder,
  folderPrefix: { owner: 'instructor_', user: 'user_' },
};

function ownerSession() {
  return { cookieValue: 'owner-cookie', userId: OWNER_ID, createdAt: 0, lastActivityAt: 0 };
}

function nonOwnerSession() {
  return { cookieValue: 'member-cookie', userId: MEMBER_ID, createdAt: 0, lastActivityAt: 0 };
}

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  initTestDb();
  runMigrations(getDb());
  createUser({ id: OWNER_ID, kind: 'playground', display_name: null, created_at: new Date().toISOString() });
  grantRole({
    user_id: OWNER_ID,
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: new Date().toISOString(),
  });
  createUser({ id: MEMBER_ID, kind: 'playground', display_name: null, created_at: new Date().toISOString() });
  _resetScenariosForTest();
  registerScenario(testScenario);
});

afterEach(() => {
  closeDb();
  _resetScenariosForTest();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('evaluateBudget', () => {
  it('none when no budget', () => {
    expect(evaluateBudget(5, null, 0.8)).toEqual({ status: 'none', costUsd: 5, budgetUsd: null, fraction: null });
  });
  it('ok below warn fraction', () => {
    expect(evaluateBudget(5, 100, 0.8).status).toBe('ok');
  });
  it('approaching at exactly warn fraction', () => {
    expect(evaluateBudget(80, 100, 0.8).status).toBe('approaching');
  });
  it('over at exactly the budget', () => {
    expect(evaluateBudget(100, 100, 0.8).status).toBe('over');
    expect(evaluateBudget(120, 100, 0.8).status).toBe('over');
  });
  it('fraction is cost/budget (null when budget 0 or null)', () => {
    expect(evaluateBudget(50, 100, 0.8).fraction).toBeCloseTo(0.5);
    expect(evaluateBudget(50, 0, 0.8).fraction).toBeNull();
  });
});

describe('budgetForAgent', () => {
  const cfg = { defaultMonthlyUsd: 20, warnFraction: 0.8, perAgent: { user_01: 50 } };
  it('per-agent override wins', () => expect(budgetForAgent('user_01', cfg)).toBe(50));
  it('falls back to default', () => expect(budgetForAgent('user_02', cfg)).toBe(20));
  it('null when no default + no override', () =>
    expect(budgetForAgent('x', { defaultMonthlyUsd: null, warnFraction: 0.8, perAgent: {} })).toBeNull());
});

describe('handleGetBudgets', () => {
  it('403 for non-owner', async () => {
    const { handleGetBudgets } = await import('./cost-budgets.js');
    expect(handleGetBudgets(nonOwnerSession()).status).toBe(403);
  });
  it('200 for owner; rows are members only (template excluded)', async () => {
    createAgentGroup({
      id: 'ag-u91',
      folder: 'user_91',
      name: 'P91',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    createAgentGroup({
      id: 'ag-tmpl',
      folder: '_default_participant',
      name: 'tmpl',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    const { handleGetBudgets } = await import('./cost-budgets.js');
    const r = handleGetBudgets(ownerSession());
    expect(r.status).toBe(200);
    const folders = (r.body as any).agents.map((a: any) => a.folder);
    expect(folders).toContain('user_91');
    expect(folders).not.toContain('_default_participant');
    const row = (r.body as any).agents.find((a: any) => a.folder === 'user_91');
    expect(typeof row.role).toBe('string');
    expect(typeof row.roleLabel).toBe('string');
    expect(typeof row.costUsdThisMonth).toBe('number');
    expect('budgetUsd' in row && 'status' in row).toBe(true);
  });
});

describe('handlePostBudgets', () => {
  it('403 for non-owner', async () => {
    const { handlePostBudgets } = await import('./cost-budgets.js');
    expect(handlePostBudgets(nonOwnerSession(), { defaultMonthlyUsd: 10 }).status).toBe(403);
  });
  it('400 on negative / bad warnFraction / negative perAgent', async () => {
    const { handlePostBudgets } = await import('./cost-budgets.js');
    expect(handlePostBudgets(ownerSession(), { defaultMonthlyUsd: -1 }).status).toBe(400);
    expect(handlePostBudgets(ownerSession(), { warnFraction: 1.5 }).status).toBe(400);
    expect(handlePostBudgets(ownerSession(), { warnFraction: 0 }).status).toBe(400);
    expect(handlePostBudgets(ownerSession(), { perAgent: { user_91: -5 } }).status).toBe(400);
    expect(handlePostBudgets(ownerSession(), { perAgent: [10, 20] } as any).status).toBe(400);
  });
  it('round-trips a valid write', async () => {
    const { handlePostBudgets, readCostBudgets } = await import('./cost-budgets.js');
    const r = handlePostBudgets(ownerSession(), {
      defaultMonthlyUsd: 25,
      warnFraction: 0.9,
      perAgent: { user_91: 50 },
    });
    expect(r.status).toBe(200);
    const cfg = readCostBudgets();
    expect(cfg.defaultMonthlyUsd).toBe(25);
    expect(cfg.perAgent.user_91).toBe(50);
  });
});
