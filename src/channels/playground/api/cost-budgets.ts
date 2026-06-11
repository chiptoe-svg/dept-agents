import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '../../../config.js';

export interface CostBudgets {
  defaultMonthlyUsd: number | null;
  warnFraction: number;
  perAgent: Record<string, number>;
}
export type BudgetStatus = 'none' | 'ok' | 'approaching' | 'over';

const CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'cost-budgets.json');
const DEFAULT_WARN = 0.8;

export function readCostBudgets(): CostBudgets {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return {
      defaultMonthlyUsd: typeof raw.defaultMonthlyUsd === 'number' ? raw.defaultMonthlyUsd : null,
      warnFraction:
        typeof raw.warnFraction === 'number' && raw.warnFraction > 0 && raw.warnFraction <= 1
          ? raw.warnFraction
          : DEFAULT_WARN,
      perAgent: raw.perAgent && typeof raw.perAgent === 'object' && !Array.isArray(raw.perAgent) ? raw.perAgent : {},
    };
  } catch {
    return { defaultMonthlyUsd: null, warnFraction: DEFAULT_WARN, perAgent: {} };
  }
}

export function writeCostBudgets(cfg: CostBudgets): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

export function budgetForAgent(folder: string, cfg: CostBudgets): number | null {
  if (typeof cfg.perAgent[folder] === 'number') return cfg.perAgent[folder];
  return cfg.defaultMonthlyUsd;
}

export function evaluateBudget(
  costUsd: number,
  budgetUsd: number | null,
  warnFraction: number,
): { status: BudgetStatus; costUsd: number; budgetUsd: number | null; fraction: number | null } {
  if (budgetUsd == null) return { status: 'none', costUsd, budgetUsd: null, fraction: null };
  const fraction = budgetUsd > 0 ? costUsd / budgetUsd : null;
  let status: BudgetStatus = 'ok';
  if (costUsd >= budgetUsd) status = 'over';
  else if (costUsd >= budgetUsd * warnFraction) status = 'approaching';
  return { status, costUsd, budgetUsd, fraction };
}
