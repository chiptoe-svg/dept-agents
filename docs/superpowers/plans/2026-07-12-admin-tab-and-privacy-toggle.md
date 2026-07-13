# Owner Admin Tab + Member Cloud↔Private Toggle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An owner-only Admin tab (add users + magic links, active-user list with cost, rotate/deactivate, dept model defaults, backstop health) and a member-facing Cloud↔Private privacy toggle in MyAgent, both reading one shared dept model config.

**Architecture:** A new `app_config` key/value table in the central DB holds the department default-cloud and private model settings. Owner-gated `/api/admin/*` endpoints wrap existing `provisionUser` / token / usage functions; a member-self `/api/me/privacy-mode` endpoint flips the caller's own agent group between its cloud provider (stashed in `agent_groups.metadata`) and the dept private (on-box) model. UI is vanilla-JS tabs following the existing `tabs/*.js` `el()` pattern.

**Tech Stack:** Node/pnpm host, TypeScript, `better-sqlite3` (central DB), vitest (host tests), vanilla-JS playground tabs.

## Global Constraints

- **Owner gate:** every `/api/admin/*` endpoint starts with `if (!session.userId || !isOwner(session.userId)) return <403 { error: 'owner role required' }>` (from `src/channels/playground/api/me-session` helpers; mirror `api-routes.ts` `/api/admin/students/:folder`). `isOwner` is imported where that block already imports it.
- **Member-self only:** `/api/me/privacy-mode` resolves the caller's own agent group from the session and NEVER reads a target folder/user from the request body.
- **Effective-value invariant:** `container_configs.model_provider` / `model` always hold the currently-active routing values so the credential proxy is unaffected. `privateMode` is *derived*: `model_provider === private_provider`.
- **Dept config keys (seed values from the A1 benchmark):**
  - `default_cloud_model` = `qwen3.6-35b-a3b-fp8`, `default_cloud_provider` = `clemson`
  - `private_model` = `Qwen3.6-35B-A3B-UD-MLX-4bit`, `private_provider` = `local`
- **Magic links are bearer credentials:** shown in-UI for copy, never logged.
- **No email, no per-user admin model override, no auto-failover** (spec "Out of scope").
- Host build/test: `pnpm run build` clean and `pnpm test` green before a task is done. Note: bare `tsc`/`pnpm run build` is scoped to `src/**` and covers all files here (this feature is entirely under `src/`).
- Commit messages end (after a blank line) with:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01WXUAU8TQduy8SMSVWoNYvn
  ```

---

## File Structure

- **Create `src/db/migrations/NNNN-app-config.ts`** — migration creating `app_config` + seeding the four dept keys.
- **Create `src/db/app-config.ts`** — `getAppConfig(key)`, `setAppConfig(key, value)`, and typed `getDeptModelConfig()` / `setDeptModelConfig()`.
- **Modify `src/provisioning/provision-user.ts`** — read `default_cloud_*` from app-config instead of the hardcoded model.
- **Create `src/channels/playground/api/admin.ts`** — owner-gated handlers: add-user, list-users, rotate-link, deactivate, model-defaults GET/PUT, backstop-health.
- **Modify `src/channels/playground/api-routes.ts`** — wire the `/api/admin/*` routes (next to the existing `/api/admin/students/` block).
- **Create `src/channels/playground/api/privacy-mode.ts`** — member-self toggle handler (stash/restore).
- **Modify `src/channels/playground/api-routes.ts`** (or the `/api/me/*` block) — wire `POST /api/me/privacy-mode`.
- **Create `src/channels/playground/public/tabs/admin.js`** — the Admin tab UI.
- **Modify `src/channels/playground/public/tab-gating.js`** — owner-only `admin` tab.
- **Modify `src/channels/playground/public/app.js`** — mount `admin`.
- **Modify `src/channels/playground/public/index.html`** — add the `admin` tab button + `tab-admin` container.
- **Modify `src/channels/playground/public/tabs/member-chat.js`** — replace the "Running on" chip with the Cloud↔Private toggle.

---

### Task 1: `app_config` store + migration

**Files:**
- Create: `src/db/app-config.ts`, `src/db/migrations/<next-number>-app-config.ts`
- Test: `src/db/app-config.test.ts`
- Reference: an existing migration under `src/db/migrations/` for the exact registration shape + how the migration index picks it up; number this migration one higher than the current highest.

**Interfaces:**
- Produces:
  - `getAppConfig(key: string): string | undefined`
  - `setAppConfig(key: string, value: string): void`
  - `type DeptModelConfig = { defaultCloud: { model: string; provider: string }; private: { model: string; provider: string } }`
  - `getDeptModelConfig(): DeptModelConfig` (reads the four keys; throws if any missing)
  - `setDeptModelConfig(cfg: DeptModelConfig): void`

- [ ] **Step 1: Write the migration**

Find the current highest-numbered migration in `src/db/migrations/` and create the next one, following that file's exact export/registration shape. It must:
```sql
CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```
then seed (idempotent `INSERT OR IGNORE`) the four keys with the Global-Constraints values (`default_cloud_model`=`qwen3.6-35b-a3b-fp8`, `default_cloud_provider`=`clemson`, `private_model`=`Qwen3.6-35B-A3B-UD-MLX-4bit`, `private_provider`=`local`), each with `updated_at` = the migration's timestamp string.

- [ ] **Step 2: Write the failing test** (`src/db/app-config.test.ts`)

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { initDb } from './connection.js';
import { runMigrations } from './migrations/index.js';
import { getAppConfig, setAppConfig, getDeptModelConfig, setDeptModelConfig } from './app-config.js';

beforeEach(() => {
  const db = initDb(':memory:');
  runMigrations(db);
});

describe('app-config', () => {
  it('seeds the dept model defaults', () => {
    const cfg = getDeptModelConfig();
    expect(cfg.defaultCloud).toEqual({ model: 'qwen3.6-35b-a3b-fp8', provider: 'clemson' });
    expect(cfg.private).toEqual({ model: 'Qwen3.6-35B-A3B-UD-MLX-4bit', provider: 'local' });
  });
  it('round-trips set/get', () => {
    setAppConfig('default_cloud_model', 'glm-5.1-fp8');
    expect(getAppConfig('default_cloud_model')).toBe('glm-5.1-fp8');
  });
  it('setDeptModelConfig writes all four keys', () => {
    setDeptModelConfig({ defaultCloud: { model: 'a', provider: 'clemson' }, private: { model: 'b', provider: 'local' } });
    const cfg = getDeptModelConfig();
    expect(cfg.defaultCloud.model).toBe('a');
    expect(cfg.private.model).toBe('b');
  });
});
```
Confirm the exact `initDb`/`runMigrations` import paths + signatures against an existing db test (e.g. a `*.test.ts` under `src/db/`) before finalizing.

- [ ] **Step 3: Run test to verify it fails** — `pnpm exec vitest run src/db/app-config.test.ts` → FAIL (module not found).

- [ ] **Step 4: Implement `src/db/app-config.ts`**

```ts
import { getDb } from './connection.js';

export function getAppConfig(key: string): string | undefined {
  const row = getDb().prepare('SELECT value FROM app_config WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setAppConfig(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?) ' +
             'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(key, value, new Date().toISOString());
}

export type DeptModelConfig = {
  defaultCloud: { model: string; provider: string };
  private: { model: string; provider: string };
};

export function getDeptModelConfig(): DeptModelConfig {
  const req = (k: string): string => {
    const v = getAppConfig(k);
    if (v == null) throw new Error(`app_config missing key: ${k}`);
    return v;
  };
  return {
    defaultCloud: { model: req('default_cloud_model'), provider: req('default_cloud_provider') },
    private: { model: req('private_model'), provider: req('private_provider') },
  };
}

export function setDeptModelConfig(cfg: DeptModelConfig): void {
  setAppConfig('default_cloud_model', cfg.defaultCloud.model);
  setAppConfig('default_cloud_provider', cfg.defaultCloud.provider);
  setAppConfig('private_model', cfg.private.model);
  setAppConfig('private_provider', cfg.private.provider);
}
```
Match the actual `getDb` import path/signature to the codebase.

- [ ] **Step 5: Run test to verify it passes** — `pnpm exec vitest run src/db/app-config.test.ts` → PASS (3/3).

- [ ] **Step 6: Build + commit** — `pnpm run build` clean.
```bash
git add src/db/app-config.ts src/db/app-config.test.ts src/db/migrations/
git commit -m "feat(db): app_config store + dept model defaults"
```

---

### Task 2: provisionUser reads the dept default-cloud model

**Files:**
- Modify: `src/provisioning/provision-user.ts:121-124` (the `updateContainerConfigScalars` call currently hardcoding `qwen3.6-35b-a3b-fp8`/`clemson`)
- Test: `src/provisioning/provision-user.test.ts` (add a case; check whether a test file exists first — if not, create it)

**Interfaces:**
- Consumes: `getDeptModelConfig()` (Task 1).

- [ ] **Step 1: Write the failing test**

Add a test that provisions a user and asserts its container config uses the dept default-cloud model, and that changing the dept default changes what a newly-provisioned user gets:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { initDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { setDeptModelConfig } from '../db/app-config.js';
import { getContainerConfig } from '../db/container-configs.js';
import { provisionUser } from './provision-user.js';

beforeEach(() => { const db = initDb(':memory:'); runMigrations(db); });

it('provisions on the dept default-cloud model', () => {
  setDeptModelConfig({ defaultCloud: { model: 'glm-5.1-fp8', provider: 'clemson' }, private: { model: 'x', provider: 'local' } });
  const r = provisionUser({ displayName: 'T', email: 't@clemson.edu' });
  const cc = getContainerConfig(r.agentGroupId)!;
  expect(cc.model).toBe('glm-5.1-fp8');
  expect(cc.model_provider).toBe('clemson');
});
```
Verify `provisionUser`'s exact input field names (`displayName`/`email`) against `ProvisionUserInput` and adapt; if provisioning needs filesystem scaffolding that fails under `:memory:`/test, mirror how existing provisioning tests stub it.

- [ ] **Step 2: Run it to confirm it fails** — the current hardcoded `qwen3.6-35b-a3b-fp8` makes the `glm-5.1-fp8` assertion fail.

- [ ] **Step 3: Change the hardcode to read config**

Replace the literal model/provider at `provision-user.ts:121-124` with values from `getDeptModelConfig().defaultCloud`:
```ts
import { getDeptModelConfig } from '../db/app-config.js';
// …
const dept = getDeptModelConfig();
updateContainerConfigScalars(agentGroupId, {
  provider: 'pi',
  model: dept.defaultCloud.model,
  model_provider: dept.defaultCloud.provider,
});
```
Keep the surrounding transaction/order exactly as-is; only the model/provider source changes.

- [ ] **Step 4: Run test to verify it passes.**

- [ ] **Step 5: Build + commit** — `pnpm run build` clean.
```bash
git add src/provisioning/provision-user.ts src/provisioning/provision-user.test.ts
git commit -m "feat(provisioning): new users get the dept default-cloud model from app_config"
```

---

### Task 3: Admin API handlers

**Files:**
- Create: `src/channels/playground/api/admin.ts`
- Modify: `src/channels/playground/api-routes.ts` (wire routes by the existing `/api/admin/students/` block)
- Test: `src/channels/playground/api/admin.test.ts`

**Interfaces:**
- Consumes: `provisionUser` (returns `{ userId, agentGroupId, folder, loginUrl }`); `rotateClassLoginToken(userId): string`; `revokeAllForUser(userId): number` (revokes tokens + sessions — this IS "deactivate"); `aggregateAgentUsage(agentGroupId): { thisMonth: { costUsd: number }, total }`; `getDeptModelConfig`/`setDeptModelConfig` (Task 1); `isOwner(userId): boolean`; the model catalog from `src/model-catalog.ts`.
- Produces the handlers below, each `(session, …) => { status, body }` matching the existing handler style in this directory (inspect a sibling like `api/default-participant.ts` for the exact `session`/return shape and the `handleX` naming).

- [ ] **Step 1: Confirm the handler contract**

Read `src/channels/playground/api/default-participant.ts` (and how `api-routes.ts` calls its handlers with `session` + `send(res, status, body)`) so the new handlers match that exact shape (sync vs async, the session type, how the owner check is done). Use that contract verbatim below.

- [ ] **Step 2: Write failing tests** (`admin.test.ts`)

Cover: owner gate (non-owner → 403 on each handler), add-user returns a `loginUrl`, model-defaults `PUT` then `GET` round-trips, list-users returns the expected fields, deactivate calls `revokeAllForUser`. Example core:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { initDb } from '../../../db/connection.js';
import { runMigrations } from '../../../db/migrations/index.js';
import { handleAddUser, handleListUsers, handleGetModelDefaults, handlePutModelDefaults, handleDeactivateUser } from './admin.js';

const owner = { userId: 'playground:owner_01' };
const nonOwner = { userId: 'playground:someone' };
beforeEach(() => { const db = initDb(':memory:'); runMigrations(db); /* grant owner role to owner.userId — mirror an existing test's role seed */ });

it('rejects non-owners', () => {
  expect(handleAddUser(nonOwner, { displayName: 'X', email: 'x@clemson.edu' }).status).toBe(403);
  expect(handleGetModelDefaults(nonOwner).status).toBe(403);
});
it('add-user returns a login url', () => {
  const r = handleAddUser(owner, { displayName: 'Jane', email: 'jane@clemson.edu' });
  expect(r.status).toBe(200);
  expect(String(r.body.loginUrl)).toContain('/?token=');
});
it('model-defaults round-trip', () => {
  handlePutModelDefaults(owner, { defaultCloud: { model: 'glm-5.1-fp8', provider: 'clemson' }, private: { model: 'Qwen3.6-35B-A3B-UD-MLX-4bit', provider: 'local' } });
  expect(handleGetModelDefaults(owner).body.defaultCloud.model).toBe('glm-5.1-fp8');
});
```
Seed the owner role the same way existing owner-gated tests do (find one that uses `isOwner`).

- [ ] **Step 3: Run tests to confirm they fail.**

- [ ] **Step 4: Implement `admin.ts`**

Each handler: owner check first (`if (!session.userId || !isOwner(session.userId)) return { status: 403, body: { error: 'owner role required' } };`), then:
- `handleAddUser(session, { displayName, email })`: validate `email` ends `@clemson.edu` (else 400); `const r = provisionUser({ displayName, email });` → `{ status: 200, body: { userId: r.userId, folder: r.folder, loginUrl: r.loginUrl } }`.
- `handleListUsers(session)`: enumerate provisioned users the way `api/usage.ts` does; for each build `{ name, email, folder, provider: cc.model_provider, model: cc.model, privateMode: cc.model_provider === getDeptModelConfig().private.provider && cc.model === getDeptModelConfig().private.model, lastActive, session, costMtd: aggregateAgentUsage(agentGroupId).thisMonth.costUsd }`. Reuse `usage.ts`'s enumeration/lastActive logic; do not re-derive it.
- `handleRotateLink(session, userId)`: `const token = rotateClassLoginToken(userId);` → return the full URL (build it the way `provisionUser` does: `${publicPlaygroundBaseUrl()}/?token=${token}`).
- `handleDeactivateUser(session, userId)`: `revokeAllForUser(userId);` → `{ status: 200, body: { ok: true } }`.
- `handleGetModelDefaults(session)`: `{ status: 200, body: getDeptModelConfig() }`.
- `handlePutModelDefaults(session, cfg)`: validate shape; `setDeptModelConfig(cfg);` → `{ ok: true }`.
- `handleBackstopHealth(session)`: `{ keyPresent, spendMtd }` — key presence from the same env read the credential proxy uses (`OPENAI_API_KEY` via the host's env-read helper); `spendMtd` = sum of `aggregateAgentUsage(...).thisMonth.costUsd` across users on the backstop, or the total the usage module already computes. If validity can't be cheaply checked, return `keyPresent` only (do NOT make a paid probe call).

- [ ] **Step 5: Run tests to verify they pass.**

- [ ] **Step 6: Wire routes in `api-routes.ts`**

Next to `/api/admin/students/`, add (owner check is inside each handler, but keep the same `send(res, r.status, r.body)` dispatch):
- `POST /api/admin/users` → `handleAddUser(session, await readJsonBody(req))`
- `GET /api/admin/users` → `handleListUsers(session)`
- `POST /api/admin/users/:folder/rotate-link` → resolve `userId` from `:folder`, `handleRotateLink`
- `POST /api/admin/users/:folder/deactivate` → `handleDeactivateUser`
- `GET|PUT /api/admin/model-defaults` → `handleGetModelDefaults` / `handlePutModelDefaults(session, await readJsonBody(req))`
- `GET /api/admin/backstop-health` → `handleBackstopHealth`

Map `:folder` → `userId` via the existing folder→group→user resolution (see how `usage.ts`/`/api/admin/students/:folder` resolves it).

- [ ] **Step 7: Build + full test + commit**
```bash
git add src/channels/playground/api/admin.ts src/channels/playground/api/admin.test.ts src/channels/playground/api-routes.ts
git commit -m "feat(admin): owner-gated user + model-defaults + backstop endpoints"
```

---

### Task 4: Admin tab UI

**Files:**
- Create: `src/channels/playground/public/tabs/admin.js`
- Modify: `src/channels/playground/public/tab-gating.js`, `public/app.js`, `public/index.html`
- Test: `src/channels/playground/public/tabs/admin.test.ts` (pure render helpers only)

**Interfaces:**
- Consumes the Task 3 endpoints. Produces `mountAdmin(el)` + pure render helpers (`renderUserRow(user)`, `renderModelDefaults(cfg, catalog)`) tested in isolation (mirror how `member-home.js`/`member-chat.js` split pure `render*` from `mount*`).

- [ ] **Step 1: Tab gating (owner-only)**

In `tab-gating.js`, add `'admin'` to `TABS` and to the owner tab sets so it appears for owners only (present in `tabsForRole(role)` and `navTabsForRole(role)` when `hasFullAccess(role)`, absent from `MEMBER_TABS`/`MEMBER_NAV_TABS`). Add a unit test asserting `navTabsForRole('owner')` includes `'admin'` and `navTabsForRole('member')` does not.

- [ ] **Step 2: index.html + app.js wiring**

Add a `<button data-tab="admin">Admin</button>` to the nav and a `<div id="tab-admin" hidden>` container in `index.html`. In `app.js`, import `mountAdmin` and add `admin: mountAdmin` to `mounters`.

- [ ] **Step 3: Write failing tests for the pure render helpers**

```ts
import { describe, it, expect } from 'vitest';
import { renderUserRow, renderModelDefaults } from './admin.js';
it('renders a user row with cost + private badge', () => {
  const html = renderUserRow({ name: 'Jane', email: 'jane@clemson.edu', folder: 'u1', provider: 'local', model: 'Qwen3.6-35B-A3B-UD-MLX-4bit', privateMode: true, lastActive: '2026-07-12', session: 'idle', costMtd: 0 }).outerHTML;
  expect(html).toContain('Jane');
  expect(html).toContain('Private');
});
```
(Use the `el()` helper the other tabs use; assert via `.textContent`/`.outerHTML`. XSS-safe: text via `textContent`, never `innerHTML` with user data — follow `member-home.js`.)

- [ ] **Step 4: Implement `admin.js`**

Four panels built with `el()`: Add-user form (POST `/api/admin/users`, render `loginUrl` + Copy/Rotate), Active-users table (GET `/api/admin/users` → `renderUserRow` per row, with Rotate/Deactivate actions), Model-defaults (GET/PUT `/api/admin/model-defaults`, selectors populated from the catalog endpoint the models tab uses), Backstop-health (GET `/api/admin/backstop-health`). Deactivate shows a confirm dialog before POSTing. Follow the fetch/render/error patterns in `tabs/models.js` and `tabs/member-home.js`.

- [ ] **Step 5: Run render tests to pass; manual note** — the panels' live behavior is controller-verified in the browser during execution; the unit tests cover the pure helpers + gating.

- [ ] **Step 6: Build + commit**
```bash
git add src/channels/playground/public/tabs/admin.js src/channels/playground/public/tabs/admin.test.ts src/channels/playground/public/tab-gating.js src/channels/playground/public/app.js src/channels/playground/public/index.html
git commit -m "feat(admin): owner-only Admin tab UI"
```

---

### Task 5: Member Cloud↔Private toggle endpoint

**Files:**
- Create: `src/channels/playground/api/privacy-mode.ts`
- Modify: `src/channels/playground/api-routes.ts` (wire `POST /api/me/privacy-mode`)
- Test: `src/channels/playground/api/privacy-mode.test.ts`

**Interfaces:**
- Consumes: `getDeptModelConfig()` (Task 1); `getContainerConfig`/`updateContainerConfigScalars` (`src/db/container-configs.ts`); `getAgentGroup`/an agent-group metadata read+write (`agent_groups.metadata` column — inspect `src/db/agent-groups.ts` for the exact metadata getter/setter, add a minimal `setAgentGroupMetadata` if none exists); the caller→agent-group resolution the other `/api/me/*` handlers use.
- Produces: `handlePrivacyMode(session, { private: boolean }): { status, body }`.

- [ ] **Step 1: Write failing tests**

```ts
// ON stashes the current cloud (provider,model) and sets the private pair;
// OFF restores it; OFF with no stash falls back to dept default; the handler
// ignores any body-supplied folder and only touches the caller's own group.
```
Concretely: seed a group on `{clemson, qwen3.6-35b-a3b-fp8}`; call `handlePrivacyMode(session, { private: true })`; assert `container_configs` now `{local, Qwen3.6-35B-A3B-UD-MLX-4bit}` and `agent_groups.metadata.cloudChoice === {provider:'clemson', model:'qwen3.6-35b-a3b-fp8'}`. Then `{ private: false }` → back to `{clemson, qwen3.6-35b-a3b-fp8}`. Separately: no stash + `{private:false}` → dept `defaultCloud`. Separately: body `{ private:true, folder:'other' }` still only mutates the caller's group.

- [ ] **Step 2: Run to confirm fail.**

- [ ] **Step 3: Implement `privacy-mode.ts`**

```ts
export function handlePrivacyMode(session, body) {
  const agentGroupId = resolveCallerAgentGroupId(session); // same resolution other /api/me/* handlers use
  if (!agentGroupId) return { status: 401, body: { error: 'not signed in' } };
  const dept = getDeptModelConfig();
  const cc = getContainerConfig(agentGroupId);
  if (!cc) return { status: 409, body: { error: 'no container config' } };
  const goingPrivate = body?.private === true;
  if (goingPrivate) {
    // stash current cloud choice unless already private
    if (!(cc.model_provider === dept.private.provider && cc.model === dept.private.model)) {
      setAgentGroupMetadata(agentGroupId, { ...getAgentGroupMetadata(agentGroupId), cloudChoice: { provider: cc.model_provider, model: cc.model } });
    }
    updateContainerConfigScalars(agentGroupId, { model_provider: dept.private.provider, model: dept.private.model });
  } else {
    const stash = getAgentGroupMetadata(agentGroupId)?.cloudChoice;
    const restore = stash ?? { provider: dept.defaultCloud.provider, model: dept.defaultCloud.model };
    updateContainerConfigScalars(agentGroupId, { model_provider: restore.provider, model: restore.model });
  }
  recycleContainerForGroup(agentGroupId); // best-effort: stop the container via the runtime CLI (A1 pattern) so next turn re-materializes; catch+ignore failure
  return { status: 200, body: { private: goingPrivate } };
}
```
Adapt `getAgentGroupMetadata`/`setAgentGroupMetadata` to the real agent-groups API (metadata is stored as JSON text in `agent_groups.metadata`). `recycleContainerForGroup` stops the group's container by name via the runtime CLI (reuse the approach proven in the A1 bench harness); if the runtime is unavailable, swallow the error — the DB write stands and the next turn picks it up.

- [ ] **Step 4: Run tests to pass.**

- [ ] **Step 5: Wire the route** — `POST /api/me/privacy-mode` → `handlePrivacyMode(session, await readJsonBody(req))` in the `/api/me/*` area. Member-self; no owner gate.

- [ ] **Step 6: Build + commit**
```bash
git add src/channels/playground/api/privacy-mode.ts src/channels/playground/api/privacy-mode.test.ts src/channels/playground/api-routes.ts
git commit -m "feat(member): /api/me/privacy-mode Cloud↔Private toggle"
```

---

### Task 6: MyAgent toggle UI (replace the "Running on" chip)

**Files:**
- Modify: `src/channels/playground/public/tabs/member-chat.js` (`modelLabel` + the chip at `:136-137`, `:271`)
- Test: `src/channels/playground/public/tabs/member-chat.test.ts` (add cases; check the file exists)

**Interfaces:**
- Consumes: `POST /api/me/privacy-mode`; the existing `/api/me/agent` response (`modelProvider`).

- [ ] **Step 1: Write the failing test for the mode label**

Add a pure helper `privacyLabel({ modelProvider, privateProvider })` and test it: when `modelProvider === privateProvider` → `'Private — on-box, stays local'`; else `'Cloud — Clemson (free)'` for `clemson`, `'Cloud — your ChatGPT'` for `openai-codex`. (Keep the existing `modelLabel` if other code uses it; add the new helper alongside.)

- [ ] **Step 2: Run to confirm fail.**

- [ ] **Step 3: Replace the chip with a toggle**

Swap the read-only `Running on:` chip (member-chat.js `:136-137`) for an interactive control: current mode text (via `privacyLabel`) + a toggle button. On click, `POST /api/me/privacy-mode { private: <!currentlyPrivate> }`, show a brief "switching…" state, then update the label from the response. Determine current mode from the `/api/me/agent` `modelProvider` vs the private provider (fetch the private provider once from a small read — reuse `/api/me/agent` if it exposes it, else default the label to what `modelProvider` implies). Keep it XSS-safe (`el()` + `textContent`).

- [ ] **Step 4: Run tests to pass.**

- [ ] **Step 5: Build + commit**
```bash
git add src/channels/playground/public/tabs/member-chat.js src/channels/playground/public/tabs/member-chat.test.ts
git commit -m "feat(member): Cloud↔Private toggle in MyAgent (replaces Running-on chip)"
```

---

## Self-Review

**1. Spec coverage:**
- Shared dept model config (`app_config`) → Task 1; `provisionUser` reads it → Task 2.
- Admin: add-user + magic link, list w/ cost, rotate, deactivate, model-defaults, backstop health → Task 3 (endpoints) + Task 4 (UI). No per-user override (absent by construction).
- Member Cloud↔Private toggle, stash/restore, effective-value invariant, member-self authz → Task 5 (endpoint) + Task 6 (UI, replaces "Running on").
- Owner gate on all `/api/admin/*`; member-self on toggle → Global Constraints + Tasks 3/5.
- Out-of-scope items (email, per-user override, auto-failover, unknown-sender) → not present in any task.

**2. Placeholder scan:** No TBD/TODO. Points where the implementer must match an existing contract (handler shape in Task 3 Step 1, agent-group metadata API in Task 5, migration registration in Task 1) are explicit "read X, use its exact shape" instructions with the concrete file named — verification steps, not placeholders.

**3. Type consistency:** `getDeptModelConfig`/`setDeptModelConfig`/`DeptModelConfig` defined in Task 1 and consumed unchanged in Tasks 2/3/5; the four `app_config` keys are identical across Task 1 (seed), Task 2 (read), Task 5 (read); `provisionUser` return fields (`userId`/`agentGroupId`/`folder`/`loginUrl`) match Task 3's usage; `revokeAllForUser`/`rotateClassLoginToken`/`aggregateAgentUsage` names match the grounded source; `privateMode` derivation (`model_provider === private_provider`) is identical in Task 3 (list) and Task 5 (stash guard).
