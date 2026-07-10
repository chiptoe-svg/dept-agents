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
import { getAgentGroup } from '../../db/agent-groups.js';
import { TtlMap } from '../../channels/playground/ttl-map.js';

export type BudgetVerdict = { ok: true } | { ok: false; reason: string };

export function assertWithinBudget(folder: string, agentGroupId: string): BudgetVerdict {
  const cfg = readCostBudgets();
  // A corrupted budgets file (exists but unreadable/unparseable) is a
  // broken control, not "no budget configured" — fail closed rather than
  // silently letting every group spend without a cap. See
  // `readCostBudgets`'s absent-vs-corrupt distinction.
  if (cfg.corrupted) {
    return { ok: false, reason: 'Cost budget configuration is corrupted; refusing spend until it is fixed.' };
  }
  const budgetUsd = budgetForAgent(folder, cfg);
  if (budgetUsd == null) return { ok: true };

  const spentUsd = aggregateAgentUsage(agentGroupId).thisMonth.costUsd;
  const verdict = evaluateBudget(spentUsd, budgetUsd, cfg.warnFraction);
  if (verdict.status === 'over') {
    return { ok: false, reason: `Monthly budget exceeded ($${spentUsd.toFixed(2)} of $${budgetUsd.toFixed(2)}).` };
  }
  return { ok: true };
}

// Every proxied LLM call runs through assertGroupWithinBudget, and a single
// agent turn makes many calls. Without a memo, each one pays a sync
// readCostBudgets() file read plus aggregateAgentUsage()'s readdir + full
// messages_out scan across every session DB for the group — on the
// single-threaded host process that also runs routing and delivery. 30s
// collapses a turn's calls into one aggregation while still catching a
// blown budget promptly.
const BUDGET_VERDICT_TTL_MS = 30_000;
const verdictCache = new TtlMap<string, BudgetVerdict>(BUDGET_VERDICT_TTL_MS);

/**
 * Budget check for callers identified only by agent-group id — i.e. the
 * credential proxy, which is the one chokepoint every LLM call crosses.
 *
 * Fails CLOSED on an unknown group: a request we cannot attribute must not
 * spend the department's key.
 *
 * Verdicts are memoized per agentGroupId for BUDGET_VERDICT_TTL_MS.
 */
export function assertGroupWithinBudget(agentGroupId: string): BudgetVerdict {
  const cached = verdictCache.peek(agentGroupId);
  if (cached !== undefined) return cached;

  const group = getAgentGroup(agentGroupId);
  const verdict: BudgetVerdict = group
    ? assertWithinBudget(group.folder, group.id)
    : { ok: false, reason: 'Unknown agent group.' };
  verdictCache.set(agentGroupId, verdict);
  return verdict;
}

/** Test-only: clear the verdict memo so tests don't leak state across cases. */
export function _resetBudgetVerdictCacheForTest(): void {
  verdictCache.clear();
}
