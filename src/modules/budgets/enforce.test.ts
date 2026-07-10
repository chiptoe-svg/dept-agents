import { describe, expect, it, vi } from 'vitest';

// NOTE: only one vi.mock() per module path is allowed per file — a second
// vi.mock() call for the same path silently overrides the first for the
// whole file (mocks are hoisted), which would break whichever describe
// block ran first. The two factories below are shared by both
// `assertWithinBudget` (folder + spend keyed by 'ag_over'/'user_over') and
// `assertGroupWithinBudget` (agent-group-id keyed by 'ag_known') — extended
// rather than duplicated.
vi.mock('../../channels/playground/api/cost-budgets.js', () => ({
  readCostBudgets: () => ({ defaultMonthlyUsd: 10, perAgent: { user_free: null }, warnFraction: 0.8 }),
  budgetForAgent: (
    folder: string,
    cfg: { perAgent: Record<string, number | null>; defaultMonthlyUsd: number | null },
  ) => (folder in cfg.perAgent ? cfg.perAgent[folder] : cfg.defaultMonthlyUsd),
  evaluateBudget: (costUsd: number, budgetUsd: number | null) =>
    budgetUsd == null
      ? { status: 'none' as const, costUsd, budgetUsd, fraction: null }
      : {
          status: (costUsd >= budgetUsd ? 'over' : 'ok') as 'over' | 'ok',
          costUsd,
          budgetUsd,
          fraction: costUsd / budgetUsd,
        },
}));

vi.mock('../../channels/playground/api/usage.js', () => ({
  aggregateAgentUsage: (agentGroupId: string) => ({
    thisMonth: { costUsd: agentGroupId === 'ag_over' || agentGroupId === 'ag_known' ? 99 : 1 },
    total: { costUsd: 0 },
  }),
}));

vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: (id: string) => (id === 'ag_known' ? { id, folder: 'user_alice' } : undefined),
}));

import { assertGroupWithinBudget, assertWithinBudget } from './enforce.js';

describe('assertWithinBudget', () => {
  it('allows a group with no configured budget', () => {
    expect(assertWithinBudget('user_free', 'ag_free')).toEqual({ ok: true });
  });

  it('allows a group under its limit', () => {
    expect(assertWithinBudget('user_alice', 'ag_alice')).toEqual({ ok: true });
  });

  it('denies a group over its limit', () => {
    const r = assertWithinBudget('user_over', 'ag_over');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/budget/i);
  });
});

describe('assertGroupWithinBudget', () => {
  it('denies an over-budget group', () => {
    const r = assertGroupWithinBudget('ag_known');
    expect(r.ok).toBe(false);
  });

  it('fails closed for an unknown group id', () => {
    const r = assertGroupWithinBudget('ag_missing');
    expect(r.ok).toBe(false);
  });
});
