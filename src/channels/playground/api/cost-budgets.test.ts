import { describe, it, expect } from 'vitest';
import { evaluateBudget, budgetForAgent } from './cost-budgets.js';

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
