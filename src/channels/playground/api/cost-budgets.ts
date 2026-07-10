import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '../../../config.js';
import { isGlobalAdmin, isOwner } from '../../../modules/permissions/db/user-roles.js';
import { getAllAgentGroups } from '../../../db/agent-groups.js';
import { getContainerConfig } from '../../../db/container-configs.js';
import { roleForFolder, roleProfile, memberName } from '../../../scenarios/registry.js';
import { aggregateAgentUsage } from './usage.js';
import { log } from '../../../log.js';
import type { PlaygroundSession } from '../auth-store.js';
import type { ApiResult } from './me.js';

export interface CostBudgets {
  defaultMonthlyUsd: number | null;
  warnFraction: number;
  perAgent: Record<string, number>;
  /**
   * True only when `config/cost-budgets.json` EXISTS but couldn't be read or
   * parsed — a corrupted control, distinct from a legitimately absent file
   * (no budget configured). Never persisted: callers that round-trip this
   * object into `writeCostBudgets` must not carry it forward (see
   * `handlePostBudgets`, which strips it before writing).
   */
  corrupted?: boolean;
}
export type BudgetStatus = 'none' | 'ok' | 'approaching' | 'over';

const CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'cost-budgets.json');
const DEFAULT_WARN = 0.8;

/**
 * Reads and validates `config/cost-budgets.json`, distinguishing two failure
 * shapes that `assertWithinBudget` must treat very differently:
 *   - file absent:  legitimate "no budget configured" — return the
 *                    null-budget default (spend enforcement is a no-op).
 *   - file present but unreadable/unparseable: a corrupted control. Callers
 *                    must fail closed rather than silently disabling every
 *                    cap — see the `corrupted` flag on the return value.
 */
export function readCostBudgets(): CostBudgets {
  if (!fs.existsSync(CONFIG_PATH)) {
    log.warn('cost-budgets: config file not found — no monthly budget is enforced', { path: CONFIG_PATH });
    return { defaultMonthlyUsd: null, warnFraction: DEFAULT_WARN, perAgent: {} };
  }
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
  } catch (err) {
    log.error('cost-budgets: config file exists but is unreadable/unparseable — failing closed on spend', {
      path: CONFIG_PATH,
      err,
    });
    return { defaultMonthlyUsd: null, warnFraction: DEFAULT_WARN, perAgent: {}, corrupted: true };
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

function isOwnerOrAdmin(userId: string | null): boolean {
  if (!userId) return false;
  return isOwner(userId) || isGlobalAdmin(userId);
}

export interface BudgetAgentRow {
  folder: string;
  name: string;
  role: string;
  roleLabel: string;
  model: string | null;
  provider: string | null;
  costUsdThisMonth: number;
  budgetUsd: number | null;
  status: BudgetStatus;
  fraction: number | null;
}

export function handleGetBudgets(
  session: PlaygroundSession,
): ApiResult<{ defaultMonthlyUsd: number | null; warnFraction: number; agents: BudgetAgentRow[] }> {
  if (!isOwnerOrAdmin(session.userId)) return { status: 403, body: { error: 'owner or admin required' } };
  const cfg = readCostBudgets();
  const agents: BudgetAgentRow[] = [];
  for (const g of getAllAgentGroups()) {
    const role = roleForFolder(g.folder);
    if (role == null) continue;
    const ev = evaluateBudget(
      aggregateAgentUsage(g.id).thisMonth.costUsd,
      budgetForAgent(g.folder, cfg),
      cfg.warnFraction,
    );
    const cc = getContainerConfig(g.id);
    agents.push({
      folder: g.folder,
      name: memberName(g.folder) ?? g.name,
      role,
      roleLabel: roleProfile(role)?.label ?? role,
      model: cc?.model ?? null,
      provider: cc?.model_provider ?? null,
      costUsdThisMonth: ev.costUsd,
      budgetUsd: ev.budgetUsd,
      status: ev.status,
      fraction: ev.fraction,
    });
  }
  return { status: 200, body: { defaultMonthlyUsd: cfg.defaultMonthlyUsd, warnFraction: cfg.warnFraction, agents } };
}

export function handlePostBudgets(
  session: PlaygroundSession,
  body: { defaultMonthlyUsd?: unknown; warnFraction?: unknown; perAgent?: unknown },
): ApiResult<CostBudgets> {
  if (!isOwnerOrAdmin(session.userId)) return { status: 403, body: { error: 'owner or admin required' } };
  const next: CostBudgets = { ...readCostBudgets() };
  // Never persist the corrupted marker — a POST from the Budgets tab is
  // exactly how an operator repairs a corrupted file; the write below
  // produces a clean, valid config regardless of what came before it.
  delete next.corrupted;
  if ('defaultMonthlyUsd' in body) {
    const v = body.defaultMonthlyUsd;
    if (v !== null && (typeof v !== 'number' || v < 0))
      return { status: 400, body: { error: 'defaultMonthlyUsd must be ≥ 0 or null' } };
    next.defaultMonthlyUsd = v as number | null;
  }
  if ('warnFraction' in body) {
    const v = body.warnFraction;
    if (typeof v !== 'number' || v <= 0 || v > 1)
      return { status: 400, body: { error: 'warnFraction must be in (0, 1]' } };
    next.warnFraction = v;
  }
  if ('perAgent' in body) {
    const pa = body.perAgent;
    if (pa == null || typeof pa !== 'object' || Array.isArray(pa))
      return { status: 400, body: { error: 'perAgent must be an object' } };
    const out: Record<string, number> = { ...next.perAgent };
    for (const [folder, v] of Object.entries(pa as Record<string, unknown>)) {
      if (v === null) {
        delete out[folder];
        continue;
      }
      if (typeof v !== 'number' || v < 0)
        return { status: 400, body: { error: `perAgent.${folder} must be ≥ 0 or null` } };
      out[folder] = v;
    }
    next.perAgent = out;
  }
  writeCostBudgets(next);
  return { status: 200, body: next };
}
