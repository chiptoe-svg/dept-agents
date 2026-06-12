# Pluggable Web Search (Brave + SearXNG, owner-selectable) — Design Spec

**Date:** 2026-06-09
**Status:** Approved (brainstorming) — pending implementation plan
**Author:** owner + Claude

## Goal

Make the agents' `web_search` tool support **multiple backends** selectable **install-wide by the owner** from a Home-tab toggle, instead of being hardcoded to Brave. v1 ships **Brave** and **SearXNG** as functional backends with **SearXNG** (self-hosted, free, private — FERPA-fit) as the default; **OpenAI** appears in the toggle but **greyed/deferred** (its hosted-search path is pi-ai R&D). The toggle greys any backend that isn't available on the box.

## Decisions (settled during brainstorming)

- **v1 functional backends: Brave + SearXNG.** OpenAI shown but greyed ("needs Responses-API work"); Tavily not included (YAGNI).
- **Default backend: SearXNG**, formalized as a managed self-hosted service.
- **Install-wide single selection** (not per-agent).
- **SearXNG scoped to this install** (not yet a shared-machine service).

## Background (current state, verified)

- `container/agent-runner/src/providers/pi-tools/web-search.ts` — the `web_search` pi tool, **hardcoded to Brave**: `BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'`, sends `X-Subscription-Token: process.env.WEB_SEARCH_API_KEY`, params `q` + `count`, parses Brave's JSON into the tool result. Registered into every agent at `pi.ts:382` via `createWebSearchTool()`. Has a unit test `web-search.test.ts`.
- `src/container-runner.ts` `buildContainerArgs` (~line 587) forwards a fixed env set; **already forwards `WEB_SEARCH_API_KEY`** (added 2026-06-09, commit `65c01e8`) when set on the host. Does NOT yet forward `WEB_SEARCH_PROVIDER` or `SEARXNG_URL`.
- The agent-runner runs from the built image `nanoclaw-agent-v2-581fefa4:latest`; **changes to `web-search.ts` require a `./container/build.sh` rebuild** (CLAUDE.md "Container Build Cache" — `--no-cache` alone is insufficient; prune the builder).
- Owner-config-as-JSON precedent: `src/channels/playground/api/class-controls.ts` reads/writes `data/config/class-controls.json`.
- Owner gating: `isOwner`/`isGlobalAdmin` (`src/modules/permissions/db/user-roles.ts`), wrapped `isOwnerOrAdmin` (`api/enrollment.ts`).
- Owner card precedent: the "Default Participant Template" card (`src/channels/playground/public/tabs/home.js`, owner-gated, GET-on-load + action buttons).
- SearXNG: Docker `searxng/searxng`, internal port 8080. JSON is **off by default** — `settings.yml` needs `search: { formats: [html, json] }` + a `server.secret_key`; set `server.limiter: false` for API access. API: `GET /search?q=<q>&format=json` → `{ results: [{ title, url, content, engine }], ... }` (verified live in the POC, port `127.0.0.1:8888`).
- POC container `searxng-poc` is running on `127.0.0.1:8888` (registered in `~/.dev-ports.yaml` as throwaway).

## Architecture

### Component 1 — Pluggable backend in the agent-runner

Refactor `web-search.ts` into a dispatcher + per-backend modules:

```
container/agent-runner/src/providers/pi-tools/
  web-search.ts            # the pi tool wrapper + dispatch on WEB_SEARCH_PROVIDER
  web-search/brave.ts      # today's Brave logic (endpoint, X-Subscription-Token, parse)
  web-search/searxng.ts    # SEARXNG_URL/search?format=json, map results
  web-search/types.ts      # shared SearchResult + backend interface
```

- Backend interface: `(query: string, count: number) => Promise<SearchResult[]>` where `SearchResult = { title: string; url: string; snippet: string }`. Each backend builds its request, calls `fetch`, and maps its provider-specific JSON to `SearchResult[]`. Errors throw with a backend-specific message (Brave's existing 401/HTTP-status hints preserved; SearXNG's "is SEARXNG_URL set/reachable" hint).
- Dispatch in `web-search.ts`: `const provider = process.env.WEB_SEARCH_PROVIDER ?? 'brave';` → `searxng` uses `web-search/searxng.ts` (reads `SEARXNG_URL`), anything else uses `web-search/brave.ts` (reads `WEB_SEARCH_API_KEY`). The tool's name (`web_search`), description, parameters, and result-formatting (the `AgentToolResult<SearchDetails>` wrapping) stay unchanged so pi and the trace UI are unaffected.
- **OpenAI**: no backend module in v1. If `WEB_SEARCH_PROVIDER === 'openai'` is ever set, the tool returns a clear "OpenAI web search not yet available" result (defensive; the owner card prevents selecting it).
- **SearXNG mapping:** `results[].{ title, url, content }` → `{ title, url, snippet: content }`, take the first `count` results.

### Component 2 — Host config + container env propagation

- **Config file:** `data/config/web-search.json` = `{ "provider": "searxng" | "brave", "updatedAt": string, "updatedBy": string }`. New host module `src/web-search-config.ts`: `readWebSearchProvider(): 'brave' | 'searxng'` (defaults to `'searxng'` when the file is absent/malformed) and `writeWebSearchProvider(provider, updatedBy)`.
- **`.env`:** `SEARXNG_URL=http://host.docker.internal:8888` (the managed SearXNG, reachable from containers). `WEB_SEARCH_API_KEY` continues to hold the Brave key (when Brave is used).
- **`buildContainerArgs` (`src/container-runner.ts`):** after the existing `WEB_SEARCH_API_KEY` forward, add:
  - `WEB_SEARCH_PROVIDER=<readWebSearchProvider()>` (always).
  - `SEARXNG_URL=<process.env.SEARXNG_URL>` when set (so the SearXNG backend can reach it).
- **Switching backends** rewrites the config and **respawns agent containers** (env is set at spawn) — same model as a model switch. The owner endpoint triggers the respawn (Component 4).

### Component 3 — SearXNG as a managed service

Promote the POC to managed:
- `settings.yml` moved to `data/searxng/settings.yml` (in-repo, gitignored): `use_default_settings: true`, `server.secret_key` (generated once), `server.limiter: false`, `search.formats: [html, json]`.
- Run `docker run -d --name searxng --restart unless-stopped -p 127.0.0.1:8888:8080 -v <repo>/data/searxng/settings.yml:/etc/searxng/settings.yml:ro searxng/searxng` (survives reboots). Remove the `searxng-poc` container.
- `~/.dev-ports.yaml`: update the `searxng` entry from "POC/throwaway" to managed (container `searxng`, 127.0.0.1:8888, `--restart unless-stopped`).
- Bound to `127.0.0.1` (not network-facing); containers reach it via `host.docker.internal:8888`.

### Component 4 — Owner toggle card + API

New owner-gated handlers (`src/channels/playground/api/web-search-config.ts`), gated with `isOwnerOrAdmin`, wired in `api-routes.ts`:

- `GET /api/web-search-config` → `{ active: 'brave'|'searxng', backends: [{ id, label, available, note? }] }` where availability is computed server-side:
  - **brave**: `available = !!process.env.WEB_SEARCH_API_KEY`.
  - **searxng**: `available =` a short health probe to `${SEARXNG_URL}/search?q=ping&format=json` returns HTTP 200 within a 3s timeout.
  - **openai**: `available = false`, `note = "Not yet available (requires OpenAI Responses-API integration)."`
- `POST /api/web-search-config` (body `{ provider }`) → owner-only; reject if `provider` isn't an available backend; `writeWebSearchProvider(provider, session.userId)`; then for every agent group (via `getAllAgentGroups()`, skipping the `_default_participant` template) call `restartAgentGroupContainers(group.id, 'web-search-backend-change')` so any running container respawns with the new env (a no-op for groups with no running container); return `{ ok: true, active }`.

New owner-only **"Web Search"** card on the Home tab (`home.js`, mirroring the Default Participant Template card): radio list of Brave / SearXNG / OpenAI, greyed when `!available` (OpenAI always greyed in v1 with its note), the active one checked. Selecting one POSTs and refreshes. Hidden for non-owner sessions.

### Component 5 — Container image rebuild

After the agent-runner change (Component 1) lands and tests pass, `./container/build.sh` (prune the buildkit builder first per CLAUDE.md), then restart the host so new agent spawns use the rebuilt image. Gate on the full host test suite + the agent-runner `bun test`.

## Data flow

```
Owner Home → Web Search card → POST /api/web-search-config {provider}
   → data/config/web-search.json   → restartAgentGroupContainers
        │
   buildContainerArgs reads provider → -e WEB_SEARCH_PROVIDER + (SEARXNG_URL | WEB_SEARCH_API_KEY)
        │
   container: web_search tool → dispatch(WEB_SEARCH_PROVIDER) → brave.ts | searxng.ts → results
```

## Boundaries (out of scope)
- OpenAI-native search (greyed; deferred follow-up — pi-ai hosted-tool R&D).
- Tavily backend.
- Per-agent backend selection.
- Making SearXNG a shared multi-install service.
- Routing SearXNG through the credential-proxy (it's keyless + localhost; direct `host.docker.internal` is fine).

## Testing / success criteria

Agent-runner (`bun test`, `container/agent-runner/`):
- Dispatcher selects backend by `WEB_SEARCH_PROVIDER` (default brave).
- Brave backend: existing test still passes (logic unchanged, just relocated).
- SearXNG backend: given a mocked `/search?format=json` response, maps `results[].{title,url,content}` → `SearchResult[]` correctly, honors `count`, and errors clearly when `SEARXNG_URL` is unset/unreachable.

Host (`vitest`):
- `readWebSearchProvider` defaults to `searxng` when the file is absent; round-trips after `writeWebSearchProvider`.
- `GET /api/web-search-config` availability: brave reflects `WEB_SEARCH_API_KEY`; openai always unavailable; (searxng probe mocked).
- `POST` rejects an unavailable provider, writes config + requests respawn on an available one, and is owner-gated (non-owner → 403).
- `buildContainerArgs` includes `WEB_SEARCH_PROVIDER` and (for searxng) `SEARXNG_URL`.

Build clean (`pnpm run build` + agent-runner `bun run typecheck`) + full suites green. Container image rebuilds.

Live (this install): SearXNG managed + default; flip the card to SearXNG; an agent answers "weather in Paris" with current results sourced via SearXNG (trace shows the `web_search` call succeeding, no 422). Flip to Brave (with key) → still works. OpenAI greyed.

## Risks / notes
- **Container rebuild** is required and has the documented cache-prune gotcha — the riskiest step; gate on tests + verify a fresh agent actually uses the new tool.
- **Respawn on toggle**: switching backend kills running agent containers (like a model switch). Acceptable; note it in the card.
- **SearXNG reliability**: public engines can rate-limit; `--restart unless-stopped` + the health probe (greys the toggle if down) handle the common failures. If SearXNG is down and selected, `web_search` errors clearly rather than hanging.
- **Secret hygiene**: Brave key sits in the container env (pre-existing, accepted). SearXNG is keyless. `SEARXNG_URL`/`WEB_SEARCH_PROVIDER` are non-secret.

## Suggested phasing (for the plan)
1. SearXNG managed service (formalize POC) + `.env SEARXNG_URL` + dev-ports update.
2. `src/web-search-config.ts` (read/write `data/config/web-search.json`) + tests.
3. Pluggable `web-search.ts` (brave + searxng modules + dispatch) + agent-runner tests.
4. `buildContainerArgs` forwarding (`WEB_SEARCH_PROVIDER`, `SEARXNG_URL`).
5. Owner-gated API (`web-search-config.ts`) + routing + tests.
6. Owner "Web Search" card.
7. Container rebuild + live verification.
