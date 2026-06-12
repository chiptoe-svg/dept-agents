# Cost Governance + Scenario-Aware Status Roster Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-agent monthly budgets (alert-only) with ok/approaching/over status on the Status tab, which becomes the scenario-aware fleet roster (members via `getAllAgentGroups` + the scenario contract), retiring the classroom roster card from Home.

**Architecture:** New `cost-budgets.ts` (config + pure `evaluateBudget`) + a scenario-aware `GET/POST /api/budgets` (members-only, cost via `aggregateAgentUsage`, role via the contract). The shipped `/api/status` (health) is untouched; the Status tab merges `/api/budgets` (30s) into the health table (5s) by `folder`, adds Role + Spend/Budget columns + a budget editor + the relocated "Add a participant" form; Home drops the classroom roster/add-student cards.

**Tech Stack:** Node host (vitest) for the API; browser ES modules for the tabs (manual verification).

**Spec:** `docs/superpowers/specs/2026-06-11-cost-governance-design.md`

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `src/channels/playground/api/cost-budgets.ts` | budget config + evaluator + GET/POST handlers | Create |
| `src/channels/playground/api/cost-budgets.test.ts` | tests | Create |
| `src/channels/playground/api-routes.ts` | route wiring | Modify (GET/POST `/api/budgets`) |
| `src/channels/playground/public/tabs/status.js` | Role + Spend/Budget cols, editor, add-participant | Modify |
| `src/channels/playground/public/tabs/home.js` | remove classroom roster + add-student cards | Modify |
| `src/channels/playground/public/style.css` | budget badge classes | Modify |

`config/cost-budgets.json` is created at first write (gitignored like other `config/*.json` runtime files — verify `.gitignore` already covers `config/` runtime json; if not, do NOT commit a real one).

---

## Task 1: Budget config + evaluator

**Files:** Create `src/channels/playground/api/cost-budgets.ts` + `cost-budgets.test.ts`.
Run: `pnpm exec vitest run src/channels/playground/api/cost-budgets.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/channels/playground/api/cost-budgets.test.ts`:
```ts
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
```

- [ ] **Step 2: Run → FAIL** (module/exports missing).

- [ ] **Step 3: Implement the config + evaluator** in `cost-budgets.ts`:
```ts
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
      perAgent: raw.perAgent && typeof raw.perAgent === 'object' ? raw.perAgent : {},
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
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit**
```bash
git add src/channels/playground/api/cost-budgets.ts src/channels/playground/api/cost-budgets.test.ts
git commit -m "feat(cost): budget config + evaluator (pure, tested)"
```

---

## Task 2: Scenario-aware `GET/POST /api/budgets` + route wiring

**Files:** Modify `cost-budgets.ts`, `api-routes.ts`; Test `cost-budgets.test.ts`.

- [ ] **Step 1: Write failing tests** — append to `cost-budgets.test.ts` (mirror the DB harness from `web-search-config.test.ts` / `status.test.ts`: `initTestDb`/`runMigrations`/`createUser`/`grantRole`; one top-of-file vitest import). Seed an OWNER + a MEMBER user; for the 200 path seed an agent group whose folder maps to a member role under the active scenario (use a `user_NN` folder — `classroom`/`industryai_seminar` both map `user_NN` → role `user`; verify with `roleForFolder`):
```ts
describe('handleGetBudgets', () => {
  it('403 for non-owner', async () => {
    const { handleGetBudgets } = await import('./cost-budgets.js');
    expect(handleGetBudgets(nonOwnerSession()).status).toBe(403);
  });
  it('200 for owner; rows exclude non-members (roleForFolder null)', async () => {
    // seed one member agent group (folder user_91) + one non-member (folder _default_participant)
    const { createAgentGroup } = await import('../../../db/agent-groups.js');
    createAgentGroup({ id: 'ag-u91', folder: 'user_91', name: 'P91', /* …required scalar fields… */ } as any);
    createAgentGroup({ id: 'ag-tmpl', folder: '_default_participant', name: 'tmpl' } as any);
    const { handleGetBudgets } = await import('./cost-budgets.js');
    const r = handleGetBudgets(ownerSession());
    expect(r.status).toBe(200);
    const folders = (r.body as any).agents.map((a: any) => a.folder);
    expect(folders).toContain('user_91');
    expect(folders).not.toContain('_default_participant'); // roleForFolder === null → excluded
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
  it('400 on negative budget / bad warnFraction', async () => {
    const { handlePostBudgets } = await import('./cost-budgets.js');
    expect(handlePostBudgets(ownerSession(), { defaultMonthlyUsd: -1 }).status).toBe(400);
    expect(handlePostBudgets(ownerSession(), { warnFraction: 1.5 }).status).toBe(400);
    expect(handlePostBudgets(ownerSession(), { perAgent: { user_91: -5 } }).status).toBe(400);
  });
  it('round-trips a valid write', async () => {
    const { handlePostBudgets, readCostBudgets } = await import('./cost-budgets.js');
    const r = handlePostBudgets(ownerSession(), { defaultMonthlyUsd: 25, warnFraction: 0.9, perAgent: { user_91: 50 } });
    expect(r.status).toBe(200);
    const cfg = readCostBudgets();
    expect(cfg.defaultMonthlyUsd).toBe(25);
    expect(cfg.perAgent.user_91).toBe(50);
  });
});
```
**Mock the config path** so `writeCostBudgets` doesn't touch the real `config/cost-budgets.json`: add `vi.mock('../../../config.js', …)` overriding `PROJECT_ROOT` to a tmp dir (mirror `web-search-config.test.ts`'s `DATA_DIR` shim), OR clean up `config/cost-budgets.json` in `afterEach`. Verify `createAgentGroup`'s exact required fields in `src/db/agent-groups.ts` and fill them.

- [ ] **Step 2: Run → FAIL** (handlers not exported).

- [ ] **Step 3: Implement the handlers** in `cost-budgets.ts` (add imports: `isGlobalAdmin`/`isOwner` from `../../../modules/permissions/db/user-roles.js`, `getAllAgentGroups` from `../../../db/agent-groups.js`, `getContainerConfig` from `../../../db/container-configs.js`, `roleForFolder`/`roleProfile`/`memberName` from `../../../scenarios/registry.js`, `aggregateAgentUsage` from `./usage.js`, `PlaygroundSession` from `../auth-store.js`, `ApiResult` from `./enrollment.js`):
```ts
function isOwnerOrAdmin(userId: string | null): boolean {
  if (!userId) return false;
  return isOwner(userId) || isGlobalAdmin(userId);
}

export interface BudgetAgentRow {
  folder: string; name: string; role: string; roleLabel: string;
  model: string | null; provider: string | null;
  costUsdThisMonth: number; budgetUsd: number | null; status: BudgetStatus; fraction: number | null;
}

export function handleGetBudgets(
  session: PlaygroundSession,
): ApiResult<{ defaultMonthlyUsd: number | null; warnFraction: number; agents: BudgetAgentRow[] }> {
  if (!isOwnerOrAdmin(session.userId)) return { status: 403, body: { error: 'owner or admin required' } };
  const cfg = readCostBudgets();
  const agents: BudgetAgentRow[] = [];
  for (const g of getAllAgentGroups()) {
    const role = roleForFolder(g.folder);
    if (role == null) continue; // exclude template / non-members
    const cost = aggregateAgentUsage(g.id).thisMonth.costUsd;
    const ev = evaluateBudget(cost, budgetForAgent(g.folder, cfg), cfg.warnFraction);
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
  if ('defaultMonthlyUsd' in body) {
    const v = body.defaultMonthlyUsd;
    if (v !== null && (typeof v !== 'number' || v < 0)) return { status: 400, body: { error: 'defaultMonthlyUsd must be ≥ 0 or null' } };
    next.defaultMonthlyUsd = v as number | null;
  }
  if ('warnFraction' in body) {
    const v = body.warnFraction;
    if (typeof v !== 'number' || v <= 0 || v > 1) return { status: 400, body: { error: 'warnFraction must be in (0, 1]' } };
    next.warnFraction = v;
  }
  if ('perAgent' in body) {
    const pa = body.perAgent;
    if (pa == null || typeof pa !== 'object') return { status: 400, body: { error: 'perAgent must be an object' } };
    const out: Record<string, number> = { ...next.perAgent };
    for (const [folder, v] of Object.entries(pa as Record<string, unknown>)) {
      if (v === null) { delete out[folder]; continue; }
      if (typeof v !== 'number' || v < 0) return { status: 400, body: { error: `perAgent.${folder} must be ≥ 0 or null` } };
      out[folder] = v;
    }
    next.perAgent = out;
  }
  writeCostBudgets(next);
  return { status: 200, body: next };
}
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Wire routes** in `api-routes.ts` (mirror the `/api/status` wiring added earlier — same `session`/`send`/`readJsonBody` style):
```ts
import { handleGetBudgets, handlePostBudgets } from './api/cost-budgets.js';
```
```ts
  if (method === 'GET' && url.pathname === '/api/budgets') {
    const r = handleGetBudgets(session);
    return send(res, r.status, r.body);
  }
  if (method === 'POST' && url.pathname === '/api/budgets') {
    const body = await readJsonBody(req);
    const r = handlePostBudgets(session, body);
    return send(res, r.status, r.body);
  }
```

- [ ] **Step 6:** `pnpm run build && pnpm exec vitest run src/channels/playground/api/cost-budgets.test.ts` → clean + pass. Commit:
```bash
git add src/channels/playground/api/cost-budgets.ts src/channels/playground/api-routes.ts src/channels/playground/api/cost-budgets.test.ts
git commit -m "feat(cost): scenario-aware GET/POST /api/budgets (members + cost + budget)"
```

---

## Task 3: Status tab — Role + Spend/Budget columns + editor + Add-participant

**Files:** Modify `public/tabs/status.js`, `public/style.css`. (Manual verification — no unit test.)

- [ ] **Step 1: Add a budgets fetch + merge-by-folder.** In `status.js`, add a module-level `let budgetsByFolder = {}` and a `loadBudgets(el)` that fetches `/api/budgets`, stores `data.agents` keyed by `folder` into `budgetsByFolder`, stashes `data.defaultMonthlyUsd`/`data.warnFraction` for the editor, and re-renders. In `loadStatus`'s row builder, **filter to rows present in `budgetsByFolder`** (members only → drops the template) and enrich each row with the budget data:
```js
  for (const a of data.agents) {
    const b = budgetsByFolder[a.folder];
    if (!b) continue; // not a scenario member (e.g. the _default_participant template) → skip
    const activity = a.health === 'running'
      ? humanizeAge(a.heartbeatAgeMs)
      : humanizeAge(a.lastActivityAt ? Date.now() - Date.parse(a.lastActivityAt) : null);
    const spend = b.budgetUsd != null
      ? `$${b.costUsdThisMonth.toFixed(2)} / $${b.budgetUsd.toFixed(2)}`
      : `$${b.costUsdThisMonth.toFixed(2)}`;
    const badge = b.status === 'none' ? '' :
      `<span class="status-budget status-budget-${esc(b.status)}">${esc(b.status)}</span>`;
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${esc(b.roleLabel)}</td>` +
      `<td>${esc(b.name)} <span class="muted">${esc(a.folder)}</span></td>` +
      `<td>${esc(a.provider || '')}${a.model ? ' / ' + esc(a.model) : ''}</td>` +
      `<td><span class="status-badge status-${esc(a.health)}">${esc(a.health)}</span></td>` +
      `<td>${esc(activity)}</td>` +
      `<td>${esc(spend)} ${badge}</td>` +
      `<td><button class="btn btn-ghost status-restart" data-folder="${esc(a.folder)}">Restart</button></td>`;
    tbody.appendChild(tr);
  }
```
Update the `<thead>` in `mountStatus` to `Role · Agent · Model · Health · Activity · Spend / Budget · (restart)`. Call `loadBudgets(el)` once in `mountStatus` and on a **30s** interval (separate from the 5s health interval; both guarded by `el.offsetParent !== null`; both cleared on the existing re-mount guard).

- [ ] **Step 2: Budget editor.** Add a small owner form above the table (default $ + warn % inputs + a Save button) that POSTs `/api/budgets` `{ defaultMonthlyUsd, warnFraction }` then `loadBudgets(el)`. Per-agent overrides: a tiny inline input per row (or a "set budget" prompt) that POSTs `{ perAgent: { [folder]: value } }`. Keep it minimal — default + per-agent is enough. Surface POST failures on a status line (like the restart handler).

- [ ] **Step 3: Relocate "Add a participant".** Move `renderAddStudentCard` from `home.js` into `status.js` (rename to `renderAddParticipant`), rendering its form into a section on the Status tab; it POSTs the existing `/api/admin/students` endpoint (unchanged — routes through scenario-aware `provisionMember`). After a successful add, call `loadStatus(el)` + `loadBudgets(el)` to refresh the roster.

- [ ] **Step 4: CSS** — add to `style.css`, scoped like the existing Status rules:
```css
.status-table .status-budget { padding: 1px 6px; border-radius: 3px; font-size: 11px; margin-left: 4px; }
.status-table .status-budget-ok { background: #e3efe0; color: #3c6e2f; }
.status-table .status-budget-approaching { background: #fff3cd; color: #856404; }
.status-table .status-budget-over { background: #f6e0de; color: #a8332b; }
```

- [ ] **Step 5:** `pnpm run build` → clean (host unaffected). Commit:
```bash
git add src/channels/playground/public/tabs/status.js src/channels/playground/public/style.css
git commit -m "feat(status): scenario roster + spend/budget columns + budget editor + add-participant"
```

---

## Task 4: Home cleanup — remove the classroom roster + add-student cards

**Files:** Modify `public/tabs/home.js`.

- [ ] **Step 1: Remove the two cards from the layout.** Delete the `studentsRosterCard` + `addStudentCard` const declarations (home.js ~56–73) and their `${studentsRosterCard}` / `${addStudentCard}` insertions in the template (~94–96).

- [ ] **Step 2: Remove the render calls** (home.js ~183–184): `renderStudentsRosterCard(...)` and `renderAddStudentCard(...)`.

- [ ] **Step 3: Delete the now-dead helpers** in `home.js`: `renderStudentsRosterCard`, `renderStudentDetail` (only used by the roster), and `renderAddStudentCard` (relocated to `status.js` in Task 3 — delete the Home copy). KEEP `renderUsageCard` + its call (the per-user own-agent usage card stays). After deleting, grep `home.js` for any remaining reference to the removed functions/ids (`students-roster-body`, `add-student-body`, `renderStudentDetail`) and remove stragglers.

- [ ] **Step 4:** `pnpm run build` → clean. Manually confirm (or reason) Home still renders: Profile, Class controls, Default Participant, Web Search, own-usage card, Settings, Telegram — and no longer the roster/add-student. Commit:
```bash
git add src/channels/playground/public/tabs/home.js
git commit -m "refactor(home): drop classroom roster + add-student cards (superseded by scenario-aware Status roster)"
```

---

## Task 5: Full verification + deploy + state.md

- [ ] **Step 1:** `pnpm run build && pnpm test 2>&1 | tail -4` → build clean, full host suite green (existing + new cost-budgets tests). Report counts.

- [ ] **Step 2 (gated on owner go-ahead at execution):** restart host to load the API:
```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-581fefa4
```
Live-check as owner (browser, after hard-refresh): Status tab shows the **roster incl. seminar participants** (John/Jane/Richard as Participants, InstructorBot as Organizer/Owner; the template excluded) with Role + Health + Spend/Budget; set a default budget + a per-agent budget and confirm the badge flips ok/approaching/over; Add-a-participant works; Home no longer shows the classroom roster/add-student but still shows the own-usage card + config cards. Also `curl -s "http://127.0.0.1:3002/api/budgets?seat=owner_01"` → 200 with member rows.

- [ ] **Step 3: `state.md`** decision-log entry: cost governance (alert-only) shipped — `GET/POST /api/budgets` (scenario-aware over `getAllAgentGroups` + the contract; per-agent monthly budget vs `aggregateAgentUsage.thisMonth.costUsd` → ok/approaching/over); Status tab is now the scenario-aware fleet roster (incl. seminar participants) with Role + Spend/Budget + restart + budget editor + Add-participant; classroom roster/add-student removed from Home (superseded; classroom `/api/usage/_/students` endpoint kept); no enforcement/notifications (alert-only, badge-only). Note the Home-card removal applies to all scenarios (classroom installs get the roster on Status instead).

- [ ] **Step 4: Commit** `state.md`.

---

## Notes / invariants

- **Scenario-agnostic rows:** the roster is `getAllAgentGroups` ∩ `roleForFolder !== null` — works in every scenario, includes the seminar's members, excludes the `_default_participant` template. NOT `class-config`-based.
- **`/api/status` untouched** — cost/role come from `/api/budgets`; the tab merges by folder. Two cadences (health 5s, budgets 30s).
- **Alert-only** — no credential-proxy enforcement, no notifications (out of scope).
- **DRY:** reuse `aggregateAgentUsage` (don't recompute cost), the scenario registry, the `isOwnerOrAdmin` + `ApiResult` + config-json patterns.
- **Own-usage card stays on Home** (students' only cost view). Classroom `/api/usage/_/students` endpoint stays (classroom installs).
- **Deploy:** `cost-budgets.ts` + routes → host restart; tab JS → browser refresh. No container rebuild.
