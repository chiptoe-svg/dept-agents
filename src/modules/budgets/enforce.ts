/**
 * The enforcement call site that cost budgets never had.
 *
 * `readCostBudgets` / `budgetForAgent` / `evaluateBudget` existed and were
 * rendered in the UI, but nothing ever *stopped* a turn — a configured cap
 * enforced nothing. This is that check. Budgets are keyed by folder; spend
 * is aggregated by agent group id, so both are needed.
 */
import { readCostBudgets, budgetForAgent, evaluateBudget } from '../../channels/playground/api/cost-budgets.js';
import { aggregateAgentUsage } from '../../channels/playground/api/usage.js';

export type BudgetVerdict = { ok: true } | { ok: false; reason: string };

export function assertWithinBudget(folder: string, agentGroupId: string): BudgetVerdict {
  const cfg = readCostBudgets();
  const budgetUsd = budgetForAgent(folder, cfg);
  if (budgetUsd == null) return { ok: true };

  const spentUsd = aggregateAgentUsage(agentGroupId).thisMonth.costUsd;
  const verdict = evaluateBudget(spentUsd, budgetUsd, cfg.warnFraction);
  if (verdict.status === 'over') {
    return { ok: false, reason: `Monthly budget exceeded ($${spentUsd.toFixed(2)} of $${budgetUsd.toFixed(2)}).` };
  }
  return { ok: true };
}
