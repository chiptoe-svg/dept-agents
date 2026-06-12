# Cost Governance (alert-only) + Scenario-Aware Status Roster — Design Spec

**Date:** 2026-06-11
**Status:** Approved (brainstorming) — pending implementation plan
**Author:** owner + Claude

## Goal

Give the owner per-agent **monthly budgets with at-a-glance ok/approaching/over status** (alert-only — no blocking), surfaced on the Status tab. In the process, make the Status tab the **scenario-aware fleet roster** (driven by `getAllAgentGroups` + the scenario contract, so it lists the seminar's actual members — Organizer/Participants — not the empty classroom `class-config` roster), and retire the now-redundant classroom roster card from Home.

## Background (verified)

- **Cost calc exists & is reusable:** `aggregateAgentUsage(agentGroupId)` (`api/usage.ts`) → `{ thisMonth, total }` each with `costUsd` (calendar-month `thisMonth`, model-catalog pricing, Anthropic/OpenAI cache accounting handled). Per-agent monthly cost is one call.
- **The classroom roster is class-config-coupled and EMPTY here:** `handleGetStudentsUsage` (`/api/usage/_/students`) reads `readClassConfig()` (classroom `students[]`/`tas[]`). This install runs `ACTIVE_SCENARIO=industryai_seminar` and has **no `config/class-config.json`** → the Home "Students roster" card shows "No student agents yet". The real members live in `agent_groups` (`owner_01`/`user_01..03`/`_default_participant`).
- **Scenario contract gives scenario-agnostic roster labeling** (`src/scenarios/registry.ts`): `roleForFolder(folder)` → `CanonicalRole | null` (null = not a member, e.g. the `_default_participant` template), `roleProfile(role).label` (e.g. "Participant"/"Organizer" in the seminar), `memberName(folder)`. So iterating `getAllAgentGroups()` + `roleForFolder` filters to members and labels them per scenario.
- **Status tab already exists** (shipped 2026-06-11): owner-only, polls `GET /api/status` (host summary + per-agent health from `getAllAgentGroups`) every 5s, with a per-agent Restart button. `/api/status` lists ALL groups incl. the template.
- **Owner-config-json precedent:** `class-controls.json` / `web-search.json` (read/write under `config/`). Owner-gate: `isOwner`/`isGlobalAdmin` → `isOwnerOrAdmin`; handlers return `ApiResult<T>`.
- **Provisioning is scenario-aware:** `provisionMember({ role, … })` + `nextFolderForRole(role)` (`class-student-provision.ts`) → `user_NN` for the seminar. The classroom add-student card posts to `/api/admin/students`.
- **Home cards** (`home.js`, owner-gated): classControls, defaultParticipant, webSearch, **studentsRoster** (class-config), **addStudent**; plus per-user Profile/Settings/Telegram/own-usage.

## Architecture

Two backend pieces + a Status-tab evolution + a Home cleanup. `/api/status` (shipped, health) is left UNCHANGED; cost/budget/role come from a new endpoint, merged client-side by `folder`.

### Component 1 — Budget config + evaluator

`src/channels/playground/api/cost-budgets.ts`:
- `config/cost-budgets.json` = `{ defaultMonthlyUsd: number | null, warnFraction: number, perAgent: { [folder]: number } }` (default `warnFraction` 0.8; `defaultMonthlyUsd` null = no default budget). `readCostBudgets()` / `writeCostBudgets()` (the `class-controls.json` pattern, under `config/`).
- `budgetForAgent(folder, cfg)` → `perAgent[folder] ?? defaultMonthlyUsd ?? null`.
- Pure `evaluateBudget(costUsd, budgetUsd, warnFraction)` → `{ status: 'none' | 'ok' | 'approaching' | 'over', costUsd, budgetUsd: number | null, fraction: number | null }`. `none` when `budgetUsd == null`; `over` when `costUsd >= budgetUsd`; `approaching` when `costUsd >= budgetUsd * warnFraction`; else `ok`. `fraction = budgetUsd ? costUsd / budgetUsd : null`.

### Component 2 — Scenario-aware budgets/roster API

Owner-gated, in `src/channels/playground/api/cost-budgets.ts` (or a sibling). **Scenario-agnostic — uses `getAllAgentGroups` + the contract, NOT `class-config`.**

- `GET /api/budgets` → `{ defaultMonthlyUsd, warnFraction, agents: [{ folder, name, role, roleLabel, model, provider, costUsdThisMonth, budgetUsd, status, fraction }] }`.
  - Rows = `getAllAgentGroups()` filtered to **members** (`roleForFolder(folder) !== null` — excludes the `_default_participant` template). `role` = `roleForFolder(folder)`; `roleLabel` = `roleProfile(role)?.label ?? role`; `name` = `memberName(folder) ?? group.name`. `model`/`provider` from `getContainerConfig(group.id)`.
  - `costUsdThisMonth` = `aggregateAgentUsage(group.id).thisMonth.costUsd`. `budgetUsd`/`status`/`fraction` from `budgetForAgent` + `evaluateBudget`.
  - Cost aggregation scans session DBs, so this endpoint is polled by the tab at a **slower cadence (~30s)** than the 5s health poll — separate from `/api/status` precisely to keep the scan off the fast loop.
- `POST /api/budgets` (owner) body `{ defaultMonthlyUsd?, warnFraction?, perAgent? }` → validate (numbers ≥ 0, or null to clear; `warnFraction` in (0,1]) → `writeCostBudgets`. Returns the new config. Rejects invalid with 400; non-owner 403.

### Component 3 — Status tab becomes the scenario-aware fleet roster

`public/tabs/status.js`:
- Add a **Role** column and a **Spend-this-month / Budget** column (with an `ok`/`approaching`/`over` badge; `—` when `status==='none'`). The table now reads as a roster: **Role · Agent · Model · Health · Activity · Spend/Budget · Restart**.
- **Row source:** render the member rows from `GET /api/budgets` (members only → the template drops out); merge the **health badge + activity** from the existing `GET /api/status` poll by `folder` (health `—` if a budget row has no status match). Host summary line stays from `/api/status`. Two polls: health 5s (existing), budgets 30s (new); both keep the visibility guard.
- **Budget editor** (owner): install-wide default $ + warn % + per-agent overrides; POSTs `/api/budgets` and refreshes.
- **"Add a participant"** form moved here (from `home.js`'s add-student card) — posts to the existing provisioning endpoint (`/api/admin/students`, which routes through scenario-aware `provisionMember`). Reuse the existing `renderAddStudentCard` logic, relocated.
- Badge CSS reuses the `.status-table`-scoped pattern from the shipped Status tab (`.status-budget-ok/approaching/over`).

### Component 4 — Home cleanup

`public/tabs/home.js`:
- **Remove** the classroom `studentsRosterCard` + `addStudentCard` (and their `renderStudentsRosterCard`/`renderAddStudentCard`/`renderStudentDetail` helpers — relocate add-participant to `status.js`; the class-config roster view is superseded by the scenario-aware Status roster).
- **Keep**: Profile, Settings/logout, Telegram, the per-user **own-agent usage card** (the only cost view a student gets — students never see the owner-only Status tab), and the class-wide config cards (Class controls, Default Participant Template, Web Search).
- The classroom `/api/usage/_/students` endpoint is **left in place** (still used by classroom-scenario installs); only the Home card consuming it is removed.

## Data flow

```
Status tab: poll /api/status (health, 5s) + /api/budgets (roster+cost+budget, 30s) → merge by folder → one roster table
Budget editor → POST /api/budgets {defaultMonthlyUsd, warnFraction, perAgent} → config/cost-budgets.json → refetch
Add participant → POST /api/admin/students → provisionMember (scenario-aware user_NN) → refetch
/api/budgets rows = getAllAgentGroups ∩ (roleForFolder !== null), labeled via roleProfile/memberName, costed via aggregateAgentUsage, judged via evaluateBudget
```

## Testing

Host (`vitest`, `src/channels/playground/api/cost-budgets.test.ts`):
- `evaluateBudget` boundaries: `none` (null budget), `ok`, `approaching` (exact `budget*warnFraction`), `over` (exact `budget` → over). `fraction` math.
- `budgetForAgent`: per-agent override → default → null.
- `GET /api/budgets`: owner-gate (non-owner → 403); rows are **members only** (a non-member/template folder excluded via `roleForFolder===null`); each row has `role`/`roleLabel`/`costUsdThisMonth`/`budgetUsd`/`status`. (Seed an agent group whose folder maps to a member role under the active scenario; mock/seed budgets config.)
- `POST /api/budgets`: owner-gate; rejects negative / out-of-range `warnFraction` (400); round-trips a valid write.

Status tab + Home changes = manual (browser): Status shows the roster incl. seminar participants with role + spend/budget badges; the budget editor persists; Add-participant works; Home no longer shows the classroom roster/add-student but keeps own-usage + config.

Build clean (`pnpm run build`) + full host suite green. Tab JS deploys on browser refresh; the API needs a host restart.

## Boundaries (out of scope)

- **No enforcement/blocking** — alert-only (the credential-proxy `userCredsHook` block path is the declined "enforce" option).
- **No notifications** — UI badge only (no owner DM on threshold cross).
- **No per-day / rolling-window budgets** — calendar-month only (reuses `aggregateAgentUsage.thisMonth`).
- **No historical cost charts** — that's analytics, separate from governance.
- The classroom `/api/usage/_/students` endpoint + the per-user own-usage card are unchanged.
- No `/api/status` shape change (cost/role come from `/api/budgets`).

## Risks / notes

- **Cost-scan cadence:** `/api/budgets` scans session DBs per agent; the 30s tab cadence bounds it. If it ever feels heavy at scale, add a short server-side cache — not needed for a ~5-agent pilot.
- **Scenario-coupling:** rows are members per the ACTIVE scenario's `roleForFolder`. In the classroom scenario this lists student agent groups too — so the Status roster supersedes the classroom Home roster generally (its Home card removal applies to all scenarios; classroom installs get the roster on Status instead). Flag in the `state.md` entry.
- **Own-usage card stays** on Home so students retain a cost view (they don't see Status).
- **Add-participant relocation:** the provisioning endpoint + logic are unchanged; only the card's location moves Home→Status. Verify `provisionMember` is what `/api/admin/students` calls (it is, post the default-participant work).
- **Deploy:** `cost-budgets.ts` + routes are host-side (`dist/`) → host restart; `status.js`/`home.js` are static → browser refresh.

## Suggested phasing (for the plan)

1. `cost-budgets.ts`: config read/write + `budgetForAgent` + `evaluateBudget` + unit tests.
2. `GET /api/budgets` (scenario-aware, members-only, cost+budget) + `POST /api/budgets` + route wiring + owner-gate/validation tests.
3. Status tab: Role + Spend/Budget columns (merge `/api/budgets` by folder, 30s) + budget editor + relocate "Add a participant".
4. Home cleanup: remove the classroom roster + add-student cards (+ dead helpers); keep own-usage + config.
5. Build + full suite + host restart + live check (roster shows seminar participants with budgets) + `state.md`.
