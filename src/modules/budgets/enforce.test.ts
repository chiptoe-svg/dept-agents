import { beforeEach, describe, expect, it, vi } from 'vitest';

// NOTE: only one vi.mock() per module path is allowed per file — a second
// vi.mock() call for the same path silently overrides the first for the
// whole file (mocks are hoisted), which would break whichever describe
// block ran first. The two factories below are shared by both
// `assertWithinBudget` (folder + spend keyed by 'ag_over'/'user_over') and
// `assertGroupWithinBudget` (agent-group-id keyed by 'ag_known') — extended
// rather than duplicated. `readCostBudgets` / `aggregateAgentUsage` are
// `vi.fn()` so individual tests (corrupted-file case, caching case) can
// override / spy on them.
vi.mock('../../channels/playground/api/cost-budgets.js', () => ({
  readCostBudgets: vi.fn(() => ({ defaultMonthlyUsd: 10, perAgent: { user_free: null }, warnFraction: 0.8 })),
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
  aggregateAgentUsage: vi.fn((agentGroupId: string) => ({
    thisMonth: { costUsd: agentGroupId === 'ag_over' || agentGroupId === 'ag_known' ? 99 : 1 },
    total: { costUsd: 0 },
  })),
}));

vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: (id: string) => (id === 'ag_known' ? { id, folder: 'user_alice' } : undefined),
}));

import { readCostBudgets } from '../../channels/playground/api/cost-budgets.js';
import { aggregateAgentUsage } from '../../channels/playground/api/usage.js';
import { assertGroupWithinBudget, assertWithinBudget, _resetBudgetVerdictCacheForTest } from './enforce.js';

beforeEach(() => {
  _resetBudgetVerdictCacheForTest();
  vi.mocked(aggregateAgentUsage).mockClear();
});

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

// Fix p2-1 #1: a corrupted (exists-but-unparseable) budgets file must fail
// closed, distinct from a legitimately absent file (which returns
// defaultMonthlyUsd: null and allows spend). readCostBudgets signals this
// via the `corrupted` flag; assertWithinBudget must check it BEFORE calling
// budgetForAgent, otherwise a corrupted file with no perAgent override for
// this folder silently resolves to budgetUsd == null → { ok: true }, exactly
// the fail-open bug this fix closes.
describe('assertWithinBudget — corrupted budgets file', () => {
  it('fails closed when the config file exists but is unreadable/unparseable', () => {
    vi.mocked(readCostBudgets).mockReturnValueOnce({
      defaultMonthlyUsd: null,
      warnFraction: 0.8,
      perAgent: {},
      corrupted: true,
    });

    const r = assertWithinBudget('some_folder_with_no_override', 'ag_whatever');

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/corrupt/i);
  });
});

// Fix p2-1 #2: assertGroupWithinBudget memoizes its verdict per agentGroupId
// for 30s so a turn's many proxied calls collapse into one usage
// aggregation instead of one sync file-read + full-history scan per call on
// the host event loop.
describe('assertGroupWithinBudget — verdict memoization', () => {
  it('two consecutive calls for the same group hit aggregateAgentUsage once', () => {
    assertGroupWithinBudget('ag_known');
    assertGroupWithinBudget('ag_known');

    expect(aggregateAgentUsage).toHaveBeenCalledTimes(1);
  });

  it("a different group id gets its own cache entry, not the first group's", () => {
    assertGroupWithinBudget('ag_known');
    assertGroupWithinBudget('ag_missing'); // unknown group — never reaches aggregateAgentUsage

    expect(aggregateAgentUsage).toHaveBeenCalledTimes(1);
    expect(aggregateAgentUsage).toHaveBeenCalledWith('ag_known');
  });
});
