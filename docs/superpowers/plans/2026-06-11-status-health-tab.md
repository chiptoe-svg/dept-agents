# Owner Status / Health Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An owner-only "Status" tab showing gateway/host state + each agent's container health, with a per-agent restart button.

**Architecture:** A host-side status API (`api/status.ts`) aggregates `getAllAgentGroups` × `getSessionsByAgentGroup` + `sessions.container_status`/`last_active` + heartbeat-file mtime into a per-agent health roll-up; a restart endpoint wraps `restartAgentGroupContainers`. A new owner-gated `status` tab (static JS) renders a host summary + agent table with restart buttons and a 5s auto-refresh. Health classification is a pure function (unit-tested without files/host state).

**Tech Stack:** Node host (vitest), browser ES module tab (happy-dom optional), existing playground API/owner-gate patterns.

**Spec:** `docs/superpowers/specs/2026-06-11-status-health-tab-design.md`

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `src/channels/playground/api/status.ts` | Status read + restart handlers + pure health classifier | Create |
| `src/channels/playground/api/status.test.ts` | Tests | Create |
| `src/channels/playground/api-routes.ts` | Route wiring | Modify (add GET `/api/status`, POST `/api/status/restart`) |
| `src/channels/playground/public/tabs/status.js` | Status tab UI | Create |
| `src/channels/playground/public/app.js` | Tab registration | Modify (import `mountStatus`, add `'status'` to `TABS`, `mounters.status`) |
| `src/channels/playground/public/index.html` | Tab button + panel | Modify (add `<button data-tab="status">` + `<div id="tab-status">`) |

`status` is NOT added to any scenario's `tabsVisibleToStudents`, so owner/ta see it (they get all `TABS`) and students don't. No backend/DB/container change. Tab JS deploys on browser refresh; the API needs a host restart (loads new `dist/`).

---

## Task 1: Status API — health classifier + `GET /api/status`

**Files:**
- Create: `src/channels/playground/api/status.ts`
- Test: `src/channels/playground/api/status.test.ts`

Run tests: `pnpm exec vitest run src/channels/playground/api/status.test.ts`

- [ ] **Step 1: Write failing tests for the pure classifier**

Create `src/channels/playground/api/status.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { classifySessionHealth, rollupHealth, ABSENT_HEARTBEAT } from './status.js';

const CEIL = 30 * 60 * 1000;

describe('classifySessionHealth', () => {
  it('running container with a fresh heartbeat → running', () => {
    expect(classifySessionHealth('running', 1000, CEIL)).toBe('running');
  });
  it('running container with a stale/absent heartbeat → stale', () => {
    expect(classifySessionHealth('running', CEIL + 1, CEIL)).toBe('stale');
    expect(classifySessionHealth('running', ABSENT_HEARTBEAT, CEIL)).toBe('stale');
  });
  it('idle/stopped → idle', () => {
    expect(classifySessionHealth('idle', 1000, CEIL)).toBe('idle');
    expect(classifySessionHealth('stopped', ABSENT_HEARTBEAT, CEIL)).toBe('idle');
  });
});

describe('rollupHealth', () => {
  it('no sessions → never', () => {
    expect(rollupHealth([])).toBe('never');
  });
  it('reports the worst state (stale > running > idle)', () => {
    expect(rollupHealth(['idle', 'running', 'stale'])).toBe('stale');
    expect(rollupHealth(['idle', 'running'])).toBe('running');
    expect(rollupHealth(['idle', 'idle'])).toBe('idle');
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm exec vitest run src/channels/playground/api/status.test.ts`
Expected: FAIL — `./status.js` / its exports don't exist.

- [ ] **Step 3: Implement the pure classifier + `handleGetStatus`**

Create `src/channels/playground/api/status.ts`:

```ts
/**
 * Owner Status/Health API: per-agent container-health roll-up + host summary.
 * Health is derived from sessions.container_status + heartbeat-file mtime
 * (NOT the outbound.db container_state table — that's tool-in-flight info).
 */
import fs from 'fs';
import path from 'path';
import { isGlobalAdmin, isOwner } from '../../../modules/permissions/db/user-roles.js';
import { PROJECT_ROOT } from '../../../config.js';
import { ABSOLUTE_CEILING_MS } from '../../../host-sweep.js';
import { getActiveContainerCount } from '../../../container-runner.js';
import { getPlaygroundStatus } from '../server.js';
import { getAllAgentGroups, getAgentGroupByFolder } from '../../../db/agent-groups.js';
import { getSessionsByAgentGroup } from '../../../db/sessions.js';
import { getContainerConfig } from '../../../db/container-configs.js';
import { heartbeatPath } from '../../../session-manager.js';
import { restartAgentGroupContainers } from '../../../container-restart.js';
import type { PlaygroundSession } from '../auth-store.js';
import type { ApiResult } from './enrollment.js';

export type SessionHealth = 'running' | 'stale' | 'idle';
export type AgentHealth = SessionHealth | 'never';

/** Sentinel age for a missing heartbeat file (treated as past any ceiling). */
export const ABSENT_HEARTBEAT = Number.POSITIVE_INFINITY;

export function classifySessionHealth(
  containerStatus: string,
  heartbeatAgeMs: number,
  ceilingMs: number,
): SessionHealth {
  if (containerStatus === 'running') {
    return heartbeatAgeMs >= ceilingMs ? 'stale' : 'running';
  }
  return 'idle'; // 'idle' | 'stopped'
}

const HEALTH_ORDER: Record<AgentHealth, number> = { stale: 3, running: 2, idle: 1, never: 0 };

export function rollupHealth(sessionHealths: SessionHealth[]): AgentHealth {
  if (sessionHealths.length === 0) return 'never';
  return sessionHealths.reduce<AgentHealth>(
    (worst, h) => (HEALTH_ORDER[h] > HEALTH_ORDER[worst] ? h : worst),
    'idle',
  );
}

interface AgentStatus {
  folder: string;
  name: string;
  model: string | null;
  provider: string | null;
  health: AgentHealth;
  heartbeatAgeMs: number | null;
  lastActivityAt: string | null;
  activeSessions: number;
}

function heartbeatAgeMs(agentGroupId: string, sessionId: string, now: number): number {
  try {
    const m = fs.statSync(heartbeatPath(agentGroupId, sessionId)).mtimeMs;
    return now - m;
  } catch {
    return ABSENT_HEARTBEAT;
  }
}

function isOwnerOrAdmin(userId: string | null): boolean {
  if (!userId) return false;
  return isOwner(userId) || isGlobalAdmin(userId);
}

let cachedVersion: string | null = null;
function appVersion(): string {
  if (cachedVersion != null) return cachedVersion;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
    cachedVersion = typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion;
}

export function handleGetStatus(
  session: PlaygroundSession,
): ApiResult<{ host: { gatewayRunning: boolean; activeContainers: number; version: string }; agents: AgentStatus[] }> {
  if (!isOwnerOrAdmin(session.userId)) return { status: 403, body: { error: 'owner role required' } };
  const now = Date.now();
  const agents: AgentStatus[] = getAllAgentGroups().map((g) => {
    const sessions = getSessionsByAgentGroup(g.id);
    const healths = sessions.map((s) =>
      classifySessionHealth(s.container_status, heartbeatAgeMs(g.id, s.id, now), ABSOLUTE_CEILING_MS),
    );
    const runningAges = sessions
      .filter((s) => s.container_status === 'running')
      .map((s) => heartbeatAgeMs(g.id, s.id, now))
      .filter((a) => Number.isFinite(a));
    const cfg = getContainerConfig(g.id);
    const lastActivityAt = sessions
      .map((s) => s.last_active)
      .filter(Boolean)
      .sort()
      .pop() ?? null;
    return {
      folder: g.folder,
      name: g.name,
      model: cfg?.model ?? null,
      provider: cfg?.model_provider ?? null,
      health: rollupHealth(healths),
      heartbeatAgeMs: runningAges.length ? Math.min(...runningAges) : null,
      lastActivityAt,
      activeSessions: sessions.filter((s) => s.container_status === 'running' || s.container_status === 'idle').length,
    };
  });
  return {
    status: 200,
    body: {
      host: {
        gatewayRunning: getPlaygroundStatus().running,
        activeContainers: getActiveContainerCount(),
        version: appVersion(),
      },
      agents,
    },
  };
}
```

**Verify in impl:** `getContainerConfig(id)` field names (`model`, `model_provider`) and that `getAgentGroupByFolder` + `AgentGroup.name`/`.folder` exist (used here + Task 2). Adjust the `cfg?.model`/`model_provider` access to the real field names if they differ.

- [ ] **Step 4: Run, verify pass** (the classifier/rollup tests)

Run: `pnpm exec vitest run src/channels/playground/api/status.test.ts`
Expected: PASS.

- [ ] **Step 5: Add a `handleGetStatus` owner-gate test**

Append to `status.test.ts` (mirror `web-search-config.test.ts`'s DB harness — read it for the exact `initTestDb`/`grantRole`/`createUser` setup + the `DATA_DIR` mock). **Consolidate all `vitest` imports into ONE top-of-file line** (`import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';`) — do not add duplicate `import … from 'vitest'` statements across steps:

```ts
// (beforeEach/afterEach added to the single top-of-file vitest import)
import fs from 'fs';
import { initTestDb, closeDb, runMigrations, getDb } from '../../../db/index.js';
import { grantRole } from '../../../modules/permissions/db/user-roles.js';
import { createUser } from '../../../modules/permissions/db/users.js';

const OWNER_ID = 'playground:owner';
const MEMBER_ID = 'playground:member';
function ownerSession() { return { cookieValue: 'c', userId: OWNER_ID, createdAt: 0, lastActivityAt: 0 }; }
function nonOwnerSession() { return { cookieValue: 'c', userId: MEMBER_ID, createdAt: 0, lastActivityAt: 0 }; }

describe('handleGetStatus owner-gate', () => {
  beforeEach(() => {
    initTestDb();
    runMigrations(getDb());
    createUser({ id: OWNER_ID, kind: 'playground', display_name: null, created_at: new Date().toISOString() });
    grantRole({ user_id: OWNER_ID, role: 'owner', agent_group_id: null, granted_by: null, granted_at: new Date().toISOString() });
    createUser({ id: MEMBER_ID, kind: 'playground', display_name: null, created_at: new Date().toISOString() });
  });
  afterEach(() => closeDb());

  it('returns 403 for a non-owner', async () => {
    const { handleGetStatus } = await import('./status.js');
    expect(handleGetStatus(nonOwnerSession()).status).toBe(403);
  });
  it('returns 200 + host/agents shape for the owner', async () => {
    const { handleGetStatus } = await import('./status.js');
    const r = handleGetStatus(ownerSession());
    expect(r.status).toBe(200);
    const body = r.body as { host: { version: string; gatewayRunning: boolean; activeContainers: number }; agents: unknown[] };
    expect(typeof body.host.version).toBe('string');
    expect(Array.isArray(body.agents)).toBe(true);
  });
});
```

If `handleGetStatus` touches modules that need the `DATA_DIR` mock (e.g. session paths), add the same `vi.mock('../../../config.js', …)` shim `web-search-config.test.ts` uses. With no agent groups seeded, `agents` is `[]` — that's fine for the shape assertion.

- [ ] **Step 6: Run, verify pass; commit**

Run: `pnpm run build && pnpm exec vitest run src/channels/playground/api/status.test.ts`
Expected: build clean, all pass.

```bash
git add src/channels/playground/api/status.ts src/channels/playground/api/status.test.ts
git commit -m "feat(status): health-classifier + GET /api/status (owner-gated)"
```

---

## Task 2: Restart endpoint + route wiring

**Files:**
- Modify: `src/channels/playground/api/status.ts`
- Modify: `src/channels/playground/api-routes.ts`
- Test: `src/channels/playground/api/status.test.ts`

- [ ] **Step 1: Write failing tests for `handlePostStatusRestart`**

Append to `status.test.ts` (at top, mock container-restart like `web-search-config.test.ts` does):

```ts
import { vi } from 'vitest';
vi.mock('../../../container-restart.js', () => ({ restartAgentGroupContainers: vi.fn().mockReturnValue(2) }));

describe('handlePostStatusRestart', () => {
  // beforeEach/afterEach from the owner-gate block seed OWNER_ID/MEMBER_ID.
  it('403 for non-owner', async () => {
    const { handlePostStatusRestart } = await import('./status.js');
    expect(handlePostStatusRestart(nonOwnerSession(), { folder: 'x' }).status).toBe(403);
  });
  it('400 when folder missing', async () => {
    const { handlePostStatusRestart } = await import('./status.js');
    expect(handlePostStatusRestart(ownerSession(), {}).status).toBe(400);
  });
  it('404 for an unknown folder', async () => {
    const { handlePostStatusRestart } = await import('./status.js');
    expect(handlePostStatusRestart(ownerSession(), { folder: 'nope' }).status).toBe(404);
  });
});
```

(A 200-path test requires a seeded agent group; the 403/400/404 paths cover the handler logic. If you seed a group via `createAgentGroup`, add a 200 assertion that `restartAgentGroupContainers` was called — optional.)

- [ ] **Step 2: Run, verify fail** (`handlePostStatusRestart` not exported).

- [ ] **Step 3: Implement `handlePostStatusRestart`** in `status.ts`:

```ts
export function handlePostStatusRestart(
  session: PlaygroundSession,
  body: { folder?: unknown },
): ApiResult<{ ok: true; restarted: number }> {
  if (!isOwnerOrAdmin(session.userId)) return { status: 403, body: { error: 'owner role required' } };
  const folder = body.folder;
  if (typeof folder !== 'string' || !folder) return { status: 400, body: { error: 'folder required' } };
  const group = getAgentGroupByFolder(folder);
  if (!group) return { status: 404, body: { error: `Agent group not found: ${folder}` } };
  const restarted = restartAgentGroupContainers(group.id, 'owner-status-restart');
  return { status: 200, body: { ok: true, restarted } };
}
```

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Wire both routes in `api-routes.ts`**

Follow the existing `/api/web-search-config` wiring (find it for the import + `send`/`readJsonBody` style). Add the import:
```ts
import { handleGetStatus, handlePostStatusRestart } from './api/status.js';
```
And the routes (place near the other owner-gated `/api/*` routes; `session` + `send` + `readJsonBody` are already in scope there):
```ts
  if (method === 'GET' && url.pathname === '/api/status') {
    const r = handleGetStatus(session);
    return send(res, r.status, r.body);
  }
  if (method === 'POST' && url.pathname === '/api/status/restart') {
    const body = await readJsonBody(req);
    const r = handlePostStatusRestart(session, body);
    return send(res, r.status, r.body);
  }
```
(Match the exact `session` variable + `send`/`readJsonBody` signatures used by the neighbouring routes — read 2–3 nearby handlers first.)

- [ ] **Step 6: Build + test; commit**

Run: `pnpm run build && pnpm exec vitest run src/channels/playground/api/status.test.ts`
Expected: build clean, all pass.

```bash
git add src/channels/playground/api/status.ts src/channels/playground/api-routes.ts src/channels/playground/api/status.test.ts
git commit -m "feat(status): POST /api/status/restart + route wiring"
```

---

## Task 3: Status tab UI (owner-only) + auto-refresh + restart button

**Files:**
- Create: `src/channels/playground/public/tabs/status.js`
- Modify: `src/channels/playground/public/app.js`
- Modify: `src/channels/playground/public/index.html`

- [ ] **Step 1: Create the tab module** `src/channels/playground/public/tabs/status.js`

```js
/**
 * Owner-only Status tab: host summary + per-agent health table with restart.
 * Polls GET /api/status every 5s while the tab panel is visible.
 */
const POLL_MS = 5000;
const HEALTH_LABEL = { running: 'running', stale: 'stale', idle: 'idle', never: 'never' };

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}
function humanizeAge(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

async function loadStatus(el) {
  const tbody = el.querySelector('#status-rows');
  const hostLine = el.querySelector('#status-host');
  try {
    const res = await fetch('/api/status', { credentials: 'same-origin' });
    if (!res.ok) {
      hostLine.textContent = `Couldn't load status (${res.status}).`;
      return;
    }
    const data = await res.json();
    hostLine.textContent =
      `gateway: ${data.host.gatewayRunning ? 'up' : 'down'} · ` +
      `${data.host.activeContainers} active container(s) · v${data.host.version}`;
    tbody.innerHTML = '';
    for (const a of data.agents) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td>${esc(a.name)} <span class="muted">${esc(a.folder)}</span></td>` +
        `<td>${esc(a.provider || '')}${a.model ? ' / ' + esc(a.model) : ''}</td>` +
        `<td><span class="status-badge status-${esc(a.health)}">${esc(HEALTH_LABEL[a.health] || a.health)}</span></td>` +
        `<td>${a.health === 'running' ? humanizeAge(a.heartbeatAgeMs) : humanizeAge(a.lastActivityAt ? Date.now() - Date.parse(a.lastActivityAt) : null)}</td>` +
        `<td><button class="btn btn-ghost status-restart" data-folder="${esc(a.folder)}">Restart</button></td>`;
      tbody.appendChild(tr);
    }
  } catch (err) {
    hostLine.textContent = `Couldn't load status: ${esc(String(err))}`;
  }
}

export function mountStatus(el) {
  el.innerHTML =
    `<section class="card"><h2>Status &amp; Health</h2>` +
    `<p id="status-host" class="muted">loading…</p>` +
    `<table class="status-table"><thead><tr>` +
    `<th>Agent</th><th>Model</th><th>Health</th><th>Activity</th><th></th>` +
    `</tr></thead><tbody id="status-rows"></tbody></table></section>`;

  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('.status-restart');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = 'restarting…';
    try {
      await fetch('/api/status/restart', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: btn.dataset.folder }),
      });
    } finally {
      await loadStatus(el);
    }
  });

  // Single poll loop per mount; cleared + restarted on re-mount.
  if (el._statusPoll) clearInterval(el._statusPoll);
  loadStatus(el);
  el._statusPoll = setInterval(() => {
    if (el.offsetParent !== null) loadStatus(el); // only when the panel is visible
  }, POLL_MS);
}
```

Add minimal CSS to `src/channels/playground/public/style.css` (status badges reuse the trace accent palette):
```css
.status-table { width: 100%; border-collapse: collapse; }
.status-table th, .status-table td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #eee; }
.status-badge { padding: 1px 6px; border-radius: 3px; font-size: 11px; }
.status-running { background: #e3efe0; color: #3c6e2f; }
.status-stale   { background: #f6e0de; color: #a8332b; }
.status-idle    { background: #eee; color: #666; }
.status-never   { background: #f4f4f4; color: #999; }
```

- [ ] **Step 2: Register the tab in `app.js`**

Add the import (with the other tab imports):
```js
import { mountStatus } from './tabs/status.js';
```
Add `'status'` to the `TABS` array, and add `status: mountStatus` to the `mounters` map (find where `mounters` is defined — mirror the existing entries).

- [ ] **Step 3: Add the tab button + panel in `index.html`**

In `<nav id="tab-bar">`, after the `benchmarks` button:
```html
    <button data-tab="status" class="tab">Status</button>
```
And add the panel div alongside the other `#tab-<name>` panels (find an existing `<div id="tab-benchmarks" ...>` and mirror it):
```html
  <div id="tab-status" hidden></div>
```
(Do NOT add `status` to any scenario's `tabsVisibleToStudents` — leaving it out makes it owner/ta-only.)

- [ ] **Step 4: Manual verification (documented)**

This is static JS — `pnpm run build` (host) then a browser hard-refresh of the playground as the owner: the **Status** tab appears (and is absent for a student seat), shows the host line + agent rows with health badges, auto-refreshes every 5s, and the **Restart** button on an agent posts and re-loads. (No automated browser test required for Task 3; the API logic is covered in Tasks 1–2. An optional happy-dom test could assert `mountStatus` renders rows from a mocked `fetch`.)

- [ ] **Step 5: Build + commit**

Run: `pnpm run build`
Expected: clean (tsc doesn't typecheck the public JS, but confirm no host breakage).

```bash
git add src/channels/playground/public/tabs/status.js src/channels/playground/public/app.js src/channels/playground/public/index.html src/channels/playground/public/style.css
git commit -m "feat(status): owner-only Status tab (host summary + agent health table + restart)"
```

---

## Task 4: Full verification + state.md

- [ ] **Step 1: Full suites + build**

Run:
```bash
pnpm run build
pnpm test 2>&1 | tail -4
```
Expected: build clean; full host suite green (existing count + the new status tests). Report exact counts.

- [ ] **Step 2: Deploy + live check (gated on owner go-ahead at execution time)**

The API + routes are host-side → restart the host to load new `dist/`:
```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-581fefa4
```
Then as owner (browser): open the **Status** tab — host line shows gateway up + active-container count + version; agents listed with health badges; trigger a turn on one agent and watch it flip `idle → running`; click **Restart** on an agent and confirm it re-loads (and the agent re-spawns on its next message). Confirm the tab is **absent** for a `user_*` seat.

- [ ] **Step 3: `state.md` decision-log entry**

Add a newest-first entry: owner Status/Health tab shipped — `GET /api/status` (per-agent health roll-up: running/stale/idle/never from `sessions.container_status` + heartbeat age vs `ABSOLUTE_CEILING_MS`) + `POST /api/status/restart` (wraps `restartAgentGroupContainers`); owner-only tab via `TABS`-not-in-`tabsVisibleToStudents`; 5s auto-refresh; no host/gateway restart from UI (self-kill); config-editing stays in existing tabs. Note tab deploys on browser refresh, API on host restart.

- [ ] **Step 4: Commit**

```bash
git add state.md
git commit -m "docs(state): record owner Status/Health tab shipped"
```

---

## Notes / invariants

- **No host/gateway restart from the UI** — the playground runs in the host process; restarting it would kill the page-serving server. Only per-agent container restart.
- **Health from `sessions.container_status` + heartbeat mtime**, NOT the outbound.db `container_state` table (tool-in-flight only). Lean on heartbeat freshness so a just-restarted host (empty in-memory map) still classifies correctly.
- **Owner-gating** is unit-tested (the demo bypass session is always the owner, so the 403 path can't be exercised live).
- **DRY/YAGNI:** reuse `restartAgentGroupContainers`, `getPlaygroundStatus`, `getActiveContainerCount`, `ABSOLUTE_CEILING_MS`, the `isOwnerOrAdmin` pattern. No logs viewer / cost / config-editor / per-session drill-down (out of scope).
- **Deploy:** `status.js`/`index.html`/`style.css` → browser refresh; `status.ts` + `api-routes.ts` → host restart. No container image rebuild.
