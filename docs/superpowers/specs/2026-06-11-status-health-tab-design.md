# Owner Status / Health Tab — Design Spec

**Date:** 2026-06-11
**Status:** Approved (brainstorming) — pending implementation plan
**Author:** owner + Claude

## Goal

Give the owner an in-playground **Status / Health** surface: see gateway/host state and each agent's container health at a glance, and restart a stuck agent's container — without dropping to `ncl` + logs. This is the observability + ops half of the Hermes "System" page; config editing is deliberately out (it already lives in the agents/models/persona/skills tabs).

## Background (verified)

- **Tab gating** (`src/channels/playground/public/app.js`): `TABS = ['home','chat','persona','skills','models','agents','sources','retrieval','benchmarks']`; `mounters[name]` maps tab→mount fn; owner/ta see all `TABS`, students see only `activeClass.tabsVisibleToStudents`. So a new `status` tab **excluded from `tabsVisibleToStudents`** is automatically owner/ta-only. Tab buttons + `#tab-<name>` panels live in `index.html`.
- **Health signals (host has them, none surfaced):**
  - `container_state` table (per-session, `outbound.db`, row `id=1`): `status` + `status_changed` (read in `src/db/session-db.ts` ~line 254; written by `markContainerRunning`/`markContainerStopped` in `session-manager.ts:590/600`).
  - Heartbeat file mtime at `heartbeatPath(agentGroupId, sessionId)` — liveness.
  - `getActiveContainerCount()` / `isContainerRunning(sessionId)` (`container-runner.ts`) — this host process's in-memory truth.
  - `getAllAgentGroups()` (`db/agent-groups.ts`), `getSessionsByAgentGroup(id)` / `getActiveSessions()` (`db/sessions.ts`).
  - `ABSOLUTE_CEILING_MS` (30 min) + `CLAIM_STUCK_MS` (`host-sweep.ts`) — the stale thresholds the sweep itself uses.
  - `getPlaygroundStatus()` (`channels/playground/server.ts`) → `{ running, url }`.
- **Ops primitive:** `restartAgentGroupContainers(agentGroupId, reason)` (`container-restart.ts`) — kills + lets the next message re-spawn.
- **Owner-gating pattern:** `isOwner` / `isGlobalAdmin` → `isOwnerOrAdmin(userId)` (as in `api/web-search-config.ts`); handlers return `ApiResult<T>` and take a `PlaygroundSession`. Routes wired in `api-routes.ts`; the demo bypass session is always the owner (so live owner-gate can't be exercised under bypass — unit-test the gate).
- **Last activity:** newest `messages_out.timestamp` for the agent's sessions.

## Architecture

Three components, all owner-gated. No host/gateway restart from the UI (the playground runs **inside** the host process — restarting it would kill the page-serving server). No backup/doctor (YAGNI).

### Component 1 — Status API (read)

New `src/channels/playground/api/status.ts`, `handleGetStatus(session)` → owner-gated `GET /api/status`:

```
{
  host: { gatewayRunning: boolean, activeContainers: number, version: string },
  agents: [{
    folder: string, name: string, model: string|null, provider: string|null,
    health: 'running' | 'stale' | 'idle' | 'never',
    heartbeatAgeMs: number | null,     // null when no heartbeat file
    lastActivityAt: string | null,     // ISO, newest messages_out across the agent's sessions
    activeSessions: number
  }]
}
```

**Per-agent health roll-up** (an agent group may have several sessions — report the *worst* state + an `activeSessions` count):
- `running` — a session whose container `isContainerRunning(sessionId)` is true AND heartbeat mtime age < `ABSOLUTE_CEILING_MS`.
- `stale` — `container_state.status` is running (or `isContainerRunning`) BUT heartbeat age ≥ `ABSOLUTE_CEILING_MS` (or heartbeat file missing while marked running) — the sweep's "stuck" condition.
- `idle` — has sessions but no running container (normal between turns / stopped).
- `never` — no sessions / no container ever.

`version` from `package.json`. `gatewayRunning`/`activeContainers` from `getPlaygroundStatus()` + `getActiveContainerCount()`. Implementation verifies the exact `container_state` reader + `getPlaygroundStatus` field names against the source.

### Component 2 — Restart op (write)

Owner-gated `POST /api/status/restart` body `{ folder }` → resolve the agent group by folder, `restartAgentGroupContainers(group.id, 'owner-status-restart')`, return `{ ok: true, restarted: <count> }`. 404 on unknown folder, 403 for non-owner. Idempotent / safe when no container is running (the primitive is a no-op then).

### Component 3 — Status tab (UI)

- `src/channels/playground/public/tabs/status.js` exporting `mountStatus(el)`; register in `app.js` (`mounters.status = mountStatus`, add `'status'` to `TABS`); add the tab button + `#tab-status` panel to `index.html`; **do not** add `status` to any scenario's `tabsVisibleToStudents` (→ owner/ta-only).
- Renders: a **host summary** line (gateway up/down · N active containers · version) and a **table** of agents — name · model/provider · **health badge** (color per state, reuse the trace badge accent palette: running=green, stale=red, idle=grey, never=muted) · heartbeat age / last-activity (humanized) · a **Restart** button per row (POSTs `/api/status/restart`, disabled while in-flight, re-fetches on completion).
- **Auto-refresh** every 5s while the tab is visible (matching Hermes); stop polling when the tab is hidden. Escape all server strings; `textContent` for values.

## Data flow

```
Status tab (5s poll) → GET /api/status (owner-gated)
   → getAllAgentGroups + per-session container_state + heartbeat mtime + isContainerRunning + newest messages_out
   → { host, agents[] }
Restart button → POST /api/status/restart {folder} → restartAgentGroupContainers → re-fetch
```

## Testing

Host (`vitest`, `src/channels/playground/api/status.test.ts`):
- **Health classification:** given mocked `container_state` + heartbeat mtime + `isContainerRunning`, assert each of running / stale / idle / never (table-driven). Stale = running-but-heartbeat-past-ceiling.
- **Roll-up:** an agent with two sessions (one running, one stale) reports `stale` (worst) + `activeSessions: 2`.
- **Host summary** shape (gatewayRunning/activeContainers/version present).
- **`GET /api/status`** owner-gated: non-owner → 403.
- **`POST /api/status/restart`**: non-owner → 403; unknown folder → 404; valid → calls `restartAgentGroupContainers` (mocked) and returns the count.

Optional happy-dom render test for `status.js` (table rows from a mocked `/api/status`, restart button POSTs).

Build clean (`pnpm run build`) + full host suite green. The tab is static JS served from `src/…/public/` — deploys on a browser refresh; the API + restart are host-side (need a host restart to load new `dist/`).

## Boundaries (out of scope)

- Config editing (agents/models/persona/skills tabs already do it).
- Host/gateway restart from the UI (self-kill), backup/restore, doctor/health-audit runs.
- Logs viewer, cost analytics (separate gap items — cost governance is its own queued feature).
- Per-session drill-down (per-agent roll-up only).
- Cross-install / multi-host status (single host).

## Risks / notes

- **Per-agent vs per-session:** roll-up to the worst state keeps the table to one row per agent (right for a ~5-agent pilot); a future drill-down can add per-session detail without changing the API shape much (`activeSessions` is already exposed).
- **Heartbeat/host-process truth:** `isContainerRunning` reflects only THIS host process's in-memory map; after a host restart, orphaned containers may not be in the map. Cross-check with `container_state` + heartbeat mtime so a just-restarted host still classifies correctly (lean on heartbeat freshness, not only the in-memory map).
- **Deploy:** `status.js`/`index.html` deploy on browser refresh; `status.ts` + route wiring are host-side (`dist/`) → host restart. Not a container change (no image rebuild).
- **Owner-gate live-untestable under demo bypass** (every session is the owner) — covered by the unit test; note it.

## Suggested phasing (for the plan)

1. `status.ts` health-classification + host-summary (pure-ish, mockable) + `handleGetStatus` + unit tests.
2. `POST /api/status/restart` handler + owner-gate + tests; wire both routes in `api-routes.ts`.
3. `status.js` tab + `app.js`/`index.html` registration (owner-only) + auto-refresh + restart button; optional happy-dom test.
4. Build + full suite + (host restart to load the API) + brief live check; `state.md` entry.
