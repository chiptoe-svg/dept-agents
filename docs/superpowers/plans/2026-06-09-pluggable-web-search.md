# Pluggable Web Search (Brave + SearXNG, owner-selectable) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pi's `web_search` tool support multiple backends (Brave + SearXNG) selectable install-wide from an owner Home-tab card, default SearXNG (self-hosted), with OpenAI shown but greyed/deferred.

**Architecture:** The agent-runner `web_search` tool becomes a dispatcher over per-backend modules selected by `WEB_SEARCH_PROVIDER`. The owner's choice persists in `data/config/web-search.json`; the host forwards `WEB_SEARCH_PROVIDER` + the backend's config (`SEARXNG_URL`/`WEB_SEARCH_API_KEY`) into agent containers at spawn; switching respawns containers. SearXNG runs as a managed local Docker service. An owner-gated card + API expose the toggle with per-backend availability.

**Tech Stack:** Agent-runner = Bun (`bun:test`, `bun run typecheck`); host = Node + pnpm (`vitest`, `tsc`). Container changes require `./container/build.sh`. Spec: `docs/superpowers/specs/2026-06-09-pluggable-web-search-design.md`.

**Verified facts (use exactly):**
- `web-search.ts` today: Brave-only. `BRAVE_ENDPOINT='https://api.search.brave.com/res/v1/web/search'`, `X-Subscription-Token: process.env.WEB_SEARCH_API_KEY`, `?q=&count=`, parses `json.web.results[].{title,url,description}`, renders a numbered list via `formatResults`. Tool exported by `createWebSearchTool(): AgentTool`. Registered at `pi.ts:382`.
- Existing tests `web-search.test.ts` (bun:test) DO NOT set `WEB_SEARCH_PROVIDER` → so the dispatcher MUST default to Brave and Brave behavior MUST stay byte-identical (same URL, `X-Subscription-Token` header, numbered-list render) or those tests break.
- `src/container-runner.ts` `buildContainerArgs` line ~595 already forwards `WEB_SEARCH_API_KEY` (commit `65c01e8`); add the new forwards right after.
- Host helpers: `getAllAgentGroups()` (`src/db/agent-groups.ts`), `restartAgentGroupContainers(agentGroupId, reason, wakeMessage?)` (`src/container-restart.ts`).
- Owner gating: `isOwner`/`isGlobalAdmin` (`src/modules/permissions/db/user-roles.ts`); pattern `isOwnerOrAdmin` + `ApiResult` + `PlaygroundSession` in `src/channels/playground/api/enrollment.ts`; POST body via `readJsonBody` in `api-routes.ts`.
- Config-as-JSON precedent: `data/config/class-controls.json`. `DATA_DIR` from `src/config.ts`.
- SearXNG: `searxng/searxng` image; JSON needs `settings.yml` `search.formats: [html, json]` + `server.secret_key` + `server.limiter: false`; `GET /search?q=&format=json` → `{ results: [{title,url,content,engine}] }`. POC ran at `127.0.0.1:8888`.
- `~/.dev-ports.yaml` has a `searxng` entry (POC). `8888` is the SearXNG port (8080 is Caddy).

**Conventions:** Branch first (not `main`). Agent-runner tests: `cd container/agent-runner && bun test <file>`; typecheck: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`. Host: `pnpm exec vitest run <file>`, `pnpm run build`, `pnpm test`. Commit per task.

---

### Task 1: SearXNG managed service (formalize the POC)

**Files:**
- Create: `data/searxng/settings.yml` (gitignored), `data/searxng/settings.yml.example` (committed)
- Modify: `.gitignore`, `.env` (add `SEARXNG_URL`), `~/.dev-ports.yaml`

- [ ] **Step 1: Stop the POC container**

Run: `docker rm -f searxng-poc`
Expected: removes the throwaway POC container (ignore "No such container" if already gone).

- [ ] **Step 2: Write the managed settings**

Create `data/searxng/settings.yml` (generate a fresh secret): 
```bash
mkdir -p data/searxng
SECRET=$(openssl rand -hex 24)
cat > data/searxng/settings.yml <<EOF
use_default_settings: true
server:
  secret_key: "$SECRET"
  limiter: false
  image_proxy: false
search:
  formats:
    - html
    - json
EOF
```
Also write `data/searxng/settings.yml.example` (same content with `secret_key: "CHANGE_ME"`) for the repo.

- [ ] **Step 3: Gitignore the live settings (keep the example)**

Append to `.gitignore`:
```
data/searxng/settings.yml
```
(The `.example` stays tracked.)

- [ ] **Step 4: Run the managed container**

```bash
docker run -d --name searxng --restart unless-stopped \
  -p 127.0.0.1:8888:8080 \
  -v "$(pwd)/data/searxng/settings.yml:/etc/searxng/settings.yml:ro" \
  searxng/searxng
```

- [ ] **Step 5: Verify JSON API**

Run: `sleep 6; curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:8888/search?q=test&format=json"`
Expected: `200`.

- [ ] **Step 6: Add `SEARXNG_URL` to `.env`**

```bash
grep -q '^SEARXNG_URL=' .env || printf 'SEARXNG_URL=http://host.docker.internal:8888\n' >> .env
grep '^SEARXNG_URL=' .env
```
Expected: `SEARXNG_URL=http://host.docker.internal:8888` (containers reach the host's SearXNG via `host.docker.internal`).

- [ ] **Step 7: Update the dev-ports registry**

Edit the `searxng` entry in `~/.dev-ports.yaml`: change the notes from "POC/throwaway" to managed — container name `searxng`, `--restart unless-stopped`, settings at `~/projects/nanoclaw/data/searxng/settings.yml`, still `127.0.0.1:8888`.

- [ ] **Step 8: Commit**

```bash
git add .gitignore data/searxng/settings.yml.example
git commit -m "feat(searxng): managed self-hosted SearXNG service for web_search"
```
(`.env` and the live `settings.yml` are not committed.)

---

### Task 2: Host web-search config (`data/config/web-search.json`)

**Files:**
- Create: `src/web-search-config.ts`
- Test: `src/web-search-config.test.ts`

- [ ] **Step 1: Write the failing test** — `src/web-search-config.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const TMP = '/tmp/nanoclaw-test-websearch-config';
vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: TMP };
});

import { readWebSearchProvider, writeWebSearchProvider } from './web-search-config.js';

beforeEach(() => { fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(TMP, { recursive: true }); });
afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('web-search config', () => {
  it('defaults to searxng when no file exists', () => {
    expect(readWebSearchProvider()).toBe('searxng');
  });
  it('round-trips a written provider', () => {
    writeWebSearchProvider('brave', 'owner:test');
    expect(readWebSearchProvider()).toBe('brave');
    expect(fs.existsSync(path.join(TMP, 'config', 'web-search.json'))).toBe(true);
  });
  it('falls back to searxng on an unknown stored value', () => {
    fs.mkdirSync(path.join(TMP, 'config'), { recursive: true });
    fs.writeFileSync(path.join(TMP, 'config', 'web-search.json'), JSON.stringify({ provider: 'bogus' }));
    expect(readWebSearchProvider()).toBe('searxng');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run src/web-search-config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/web-search-config.ts`:

```typescript
/**
 * Install-wide web-search backend selection, persisted at
 * DATA_DIR/config/web-search.json. Read by the host (to forward
 * WEB_SEARCH_PROVIDER into agent containers) and written by the owner card.
 */
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';

export type WebSearchProvider = 'brave' | 'searxng';
const VALID: WebSearchProvider[] = ['brave', 'searxng'];
const DEFAULT: WebSearchProvider = 'searxng';

function configPath(): string {
  return path.join(DATA_DIR, 'config', 'web-search.json');
}

export function readWebSearchProvider(): WebSearchProvider {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as { provider?: string };
    return VALID.includes(raw.provider as WebSearchProvider) ? (raw.provider as WebSearchProvider) : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

export function writeWebSearchProvider(provider: WebSearchProvider, updatedBy: string): void {
  const dir = path.join(DATA_DIR, 'config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    configPath(),
    JSON.stringify({ provider, updatedAt: new Date().toISOString(), updatedBy }, null, 2),
  );
}
```

- [ ] **Step 4: Run + build + commit**

```bash
pnpm exec vitest run src/web-search-config.test.ts && pnpm run build
git add src/web-search-config.ts src/web-search-config.test.ts
git commit -m "feat(web-search): install-wide provider config (data/config/web-search.json)"
```
Expected: PASS, tsc 0.

---

### Task 3: Pluggable `web_search` tool (Brave + SearXNG backends)

**Files:**
- Create: `container/agent-runner/src/providers/pi-tools/web-search/types.ts`, `.../web-search/brave.ts`, `.../web-search/searxng.ts`, `.../web-search/searxng.test.ts`
- Modify: `container/agent-runner/src/providers/pi-tools/web-search.ts`
- Keep passing: `container/agent-runner/src/providers/pi-tools/web-search.test.ts` (unchanged)

- [ ] **Step 1: Create the shared types** — `web-search/types.ts`:

```typescript
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}
export type SearchBackend = (query: string, count: number) => Promise<SearchResult[]>;
```

- [ ] **Step 2: Extract the Brave backend** — `web-search/brave.ts` (behavior identical to today's, returns `SearchResult[]` or throws):

```typescript
import type { SearchResult } from './types.js';

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const TIMEOUT_MS = 10_000;

interface BraveResult { title?: string; url?: string; description?: string }
interface BraveResponse { web?: { results?: BraveResult[] } }

export async function braveSearch(query: string, count: number): Promise<SearchResult[]> {
  const url = `${BRAVE_ENDPOINT}?q=${encodeURIComponent(query)}&count=${count}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const apiKey = process.env.WEB_SEARCH_API_KEY ?? '';
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
    });
    if (!response.ok) {
      const hint =
        response.status === 401
          ? ' (WEB_SEARCH_API_KEY is missing or invalid. Set it in the host .env file.)'
          : '';
      throw new Error(`HTTP ${response.status} ${response.statusText}${hint}`);
    }
    const json = (await response.json()) as BraveResponse;
    const results = json.web?.results ?? [];
    return results.slice(0, count).map((r) => ({
      title: r.title?.trim() || '(no title)',
      url: r.url ?? '(no url)',
      snippet: r.description?.trim() ?? '',
    }));
  } finally {
    clearTimeout(timeout);
  }
}
```

- [ ] **Step 3: Write the failing SearXNG test** — `web-search/searxng.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { searxngSearch } from './searxng.js';

const REAL_FETCH = globalThis.fetch;
let fetchCalls: string[] = [];
function mockFetchOnce(response: Response): void {
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    fetchCalls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return response;
  }) as unknown as typeof fetch;
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => { fetchCalls = []; process.env.SEARXNG_URL = 'http://searxng.test:8888'; });
afterEach(() => { globalThis.fetch = REAL_FETCH; delete process.env.SEARXNG_URL; });

describe('searxngSearch', () => {
  it('hits SEARXNG_URL /search with format=json and maps fields', async () => {
    mockFetchOnce(jsonResponse({ results: [
      { title: 'Paris weather', url: 'https://w.com/paris', content: '73F partly cloudy', engine: 'google' },
    ] }));
    const out = await searxngSearch('weather paris', 5);
    expect(fetchCalls[0]).toContain('http://searxng.test:8888/search');
    expect(fetchCalls[0]).toContain('format=json');
    expect(fetchCalls[0]).toContain('q=weather%20paris');
    expect(out).toEqual([{ title: 'Paris weather', url: 'https://w.com/paris', snippet: '73F partly cloudy' }]);
  });
  it('respects count', async () => {
    mockFetchOnce(jsonResponse({ results: Array.from({ length: 10 }, (_, i) => ({ title: `t${i}`, url: `u${i}`, content: `c${i}` })) }));
    const out = await searxngSearch('q', 3);
    expect(out).toHaveLength(3);
  });
  it('throws when SEARXNG_URL is unset', async () => {
    delete process.env.SEARXNG_URL;
    await expect(searxngSearch('q', 5)).rejects.toThrow(/SEARXNG_URL/);
  });
  it('throws on non-200', async () => {
    mockFetchOnce(jsonResponse({}, 502));
    await expect(searxngSearch('q', 5)).rejects.toThrow(/502/);
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `cd container/agent-runner && bun test src/providers/pi-tools/web-search/searxng.test.ts`
Expected: FAIL — `searxng.js` not found.

- [ ] **Step 5: Implement the SearXNG backend** — `web-search/searxng.ts`:

```typescript
import type { SearchResult } from './types.js';

const TIMEOUT_MS = 10_000;

interface SearxngResult { title?: string; url?: string; content?: string }
interface SearxngResponse { results?: SearxngResult[] }

export async function searxngSearch(query: string, count: number): Promise<SearchResult[]> {
  const base = process.env.SEARXNG_URL;
  if (!base) {
    throw new Error('SEARXNG_URL is not set (SearXNG backend selected but no URL). Set it in the host .env file.');
  }
  const url = `${base.replace(/\/+$/, '')}/search?q=${encodeURIComponent(query)}&format=json`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText} from SearXNG (is ${base} reachable and JSON enabled?)`);
    }
    const json = (await response.json()) as SearxngResponse;
    const results = json.results ?? [];
    return results.slice(0, count).map((r) => ({
      title: r.title?.trim() || '(no title)',
      url: r.url ?? '(no url)',
      snippet: r.content?.trim() ?? '',
    }));
  } finally {
    clearTimeout(timeout);
  }
}
```

- [ ] **Step 6: Run to verify SearXNG test passes**

Run: `cd container/agent-runner && bun test src/providers/pi-tools/web-search/searxng.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Refactor `web-search.ts` into the dispatcher** — replace its body with:

```typescript
/**
 * web_search — pluggable Pi tool. Dispatches to a backend selected by the
 * WEB_SEARCH_PROVIDER env var (default 'brave'): 'searxng' → self-hosted
 * SearXNG (SEARXNG_URL), anything else → Brave (WEB_SEARCH_API_KEY). The
 * owner picks the backend install-wide; the host forwards WEB_SEARCH_PROVIDER
 * + the backend's config into the container. See the pluggable-web-search spec.
 */
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import type { SearchResult } from './web-search/types.js';
import { braveSearch } from './web-search/brave.js';
import { searxngSearch } from './web-search/searxng.js';

const DEFAULT_COUNT = 10;
const MAX_COUNT = 20;

interface SearchDetails { query: string; count: number; returned: number; provider: string }

function formatResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) return `No results for "${query}".`;
  const lines = [`Search results for "${query}":`, ''];
  results.forEach((r, i) => {
    lines.push(`${i + 1}. **${r.title}**`);
    lines.push(`   ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}

export function createWebSearchTool(): AgentTool {
  const tool: AgentTool = {
    name: 'web_search',
    label: 'web_search',
    description:
      'Search the web and return ranked results (title, URL, snippet) for a query. Use this to discover URLs you don\'t already know about. Once you have a specific URL, use fetch_url to read its content.',
    parameters: Type.Unsafe({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
        count: {
          type: 'number',
          description: `Maximum number of results to return (default ${DEFAULT_COUNT}, max ${MAX_COUNT}).`,
        },
      },
      required: ['query'],
    }),
    async execute(_toolCallId, rawParams): Promise<AgentToolResult<SearchDetails>> {
      const params = rawParams as { query: string; count?: number };
      const query = params.query;
      const count = Math.min(Math.max(1, params.count ?? DEFAULT_COUNT), MAX_COUNT);
      const provider = process.env.WEB_SEARCH_PROVIDER ?? 'brave';
      const backend = provider === 'searxng' ? searxngSearch : braveSearch;
      try {
        const results = await backend(query, count);
        return {
          content: [{ type: 'text', text: formatResults(query, results) }],
          details: { query, count, returned: results.length, provider },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `Web search failed: ${message}` }],
          details: { query, count, returned: 0, provider },
        };
      }
    },
  };
  return tool;
}
```

- [ ] **Step 8: Verify the EXISTING Brave test still passes (no env set → brave default)**

Run: `cd container/agent-runner && bun test src/providers/pi-tools/web-search.test.ts`
Expected: PASS — URL still hits `api.search.brave.com`, `X-Subscription-Token` still sent, render unchanged. If the error-surface test asserts exact text, confirm it still reads `Web search failed: HTTP 401 ...` (the throw→catch path produces the same text). Fix the wrapper if any assertion drifted; do NOT weaken the test.

- [ ] **Step 9: Typecheck + commit**

```bash
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
git add container/agent-runner/src/providers/pi-tools/
git commit -m "feat(web-search): pluggable backends (brave + searxng) via WEB_SEARCH_PROVIDER"
```
Expected: typecheck clean.

---

### Task 4: Forward `WEB_SEARCH_PROVIDER` + `SEARXNG_URL` to containers

**Files:**
- Modify: `src/container-runner.ts`
- Test: `src/container-runner.test.ts` (extend if it exists; else add a focused test — check first with `ls src/container-runner.test.ts`)

- [ ] **Step 1: Implement the forward** — in `src/container-runner.ts`, right after the existing `WEB_SEARCH_API_KEY` forward block (~line 595), add:

```typescript
  // Web-search backend selection. The owner picks it install-wide
  // (data/config/web-search.json); the pi web_search tool dispatches on it.
  // Forward the selected provider + the SearXNG URL (Brave key already
  // forwarded above) so the container's tool reaches the right backend.
  args.push('-e', `WEB_SEARCH_PROVIDER=${readWebSearchProvider()}`);
  if (process.env.SEARXNG_URL) {
    args.push('-e', `SEARXNG_URL=${process.env.SEARXNG_URL}`);
  }
```

Add the import at the top of `src/container-runner.ts`:
```typescript
import { readWebSearchProvider } from './web-search-config.js';
```

- [ ] **Step 2: Build + verify forward via a quick check**

Run: `pnpm run build`
Expected: tsc 0.

If `src/container-runner.test.ts` exists and exercises `buildContainerArgs`, add a test asserting the args include `WEB_SEARCH_PROVIDER=` and (with `SEARXNG_URL` set) `SEARXNG_URL=`. If no such test harness exists (buildContainerArgs may be hard to unit-test in isolation), skip the unit test and rely on the live verification in Task 7 — note this in the commit message. (Run `grep -n "buildContainerArgs" src/container-runner.test.ts 2>/dev/null` to decide.)

- [ ] **Step 3: Commit**

```bash
git add src/container-runner.ts src/container-runner.test.ts 2>/dev/null
git commit -m "feat(container): forward WEB_SEARCH_PROVIDER + SEARXNG_URL to agent containers"
```

---

### Task 5: Owner-gated API (`web-search-config`)

**Files:**
- Create: `src/channels/playground/api/web-search-config.ts`, `.../api/web-search-config.test.ts`
- Modify: `src/channels/playground/api-routes.ts`

- [ ] **Step 1: Write the failing test** — `src/channels/playground/api/web-search-config.test.ts`, mirroring the harness in `enrollment.test.ts` (config mock for DATA_DIR → tmp, in-memory DB, owner + non-owner sessions via `grantRole`). Cover:
  - non-owner GET/POST → 403.
  - owner GET → 200 with `backends` array containing ids `brave`,`searxng`,`openai`; `openai.available === false`; `active` is `'searxng'` by default.
  - owner POST `{provider:'openai'}` → 400 (not available).
  - owner POST `{provider:'brave'}` when `WEB_SEARCH_API_KEY` set → 200 `{ok:true, active:'brave'}` and `readWebSearchProvider()` returns `'brave'`.
  - owner POST `{provider:'nonsense'}` → 400.
  (Mock the SearXNG health probe by setting `SEARXNG_URL` to an unreachable host and asserting `searxng.available===false`, OR stub fetch; keep it deterministic — prefer asserting brave/openai availability which need no network.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run src/channels/playground/api/web-search-config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/channels/playground/api/web-search-config.ts`:

```typescript
import type { PlaygroundSession } from '../auth-store.js';
import type { ApiResult } from './enrollment.js';
import { isOwner, isGlobalAdmin } from '../../../modules/permissions/db/user-roles.js';
import { readWebSearchProvider, writeWebSearchProvider, type WebSearchProvider } from '../../../web-search-config.js';
import { getAllAgentGroups } from '../../../db/agent-groups.js';
import { restartAgentGroupContainers } from '../../../container-restart.js';

interface BackendStatus { id: string; label: string; available: boolean; note?: string }

function isOwnerOrAdmin(userId: string | null): boolean {
  if (!userId) return false;
  return isOwner(userId) || isGlobalAdmin(userId);
}

async function searxngReachable(): Promise<boolean> {
  const base = process.env.SEARXNG_URL;
  if (!base) return false;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    const r = await fetch(`${base.replace(/\/+$/, '')}/search?q=ping&format=json`, { signal: controller.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

export async function handleGetWebSearchConfig(session: PlaygroundSession): Promise<ApiResult<{ active: WebSearchProvider; backends: BackendStatus[] }>> {
  if (!isOwnerOrAdmin(session.userId)) return { status: 403, body: { error: 'owner role required' } };
  const backends: BackendStatus[] = [
    { id: 'brave', label: 'Brave', available: !!process.env.WEB_SEARCH_API_KEY, note: process.env.WEB_SEARCH_API_KEY ? undefined : 'No Brave API key set (WEB_SEARCH_API_KEY).' },
    { id: 'searxng', label: 'SearXNG (self-hosted)', available: await searxngReachable(), note: process.env.SEARXNG_URL ? undefined : 'SEARXNG_URL not set.' },
    { id: 'openai', label: 'OpenAI', available: false, note: 'Not yet available (requires OpenAI Responses-API integration).' },
  ];
  return { status: 200, body: { active: readWebSearchProvider(), backends } };
}

export function handlePostWebSearchConfig(session: PlaygroundSession, body: { provider?: unknown }): ApiResult<{ ok: true; active: WebSearchProvider }> {
  if (!isOwnerOrAdmin(session.userId)) return { status: 403, body: { error: 'owner role required' } };
  const provider = body.provider;
  if (provider !== 'brave' && provider !== 'searxng') {
    return { status: 400, body: { error: 'provider must be an available backend (brave | searxng)' } };
  }
  // Availability re-check: don't let the owner select a backend that can't run.
  if (provider === 'brave' && !process.env.WEB_SEARCH_API_KEY) {
    return { status: 400, body: { error: 'Brave is unavailable — no WEB_SEARCH_API_KEY set.' } };
  }
  if (provider === 'searxng' && !process.env.SEARXNG_URL) {
    return { status: 400, body: { error: 'SearXNG is unavailable — SEARXNG_URL not set.' } };
  }
  writeWebSearchProvider(provider, session.userId!);
  // Respawn every agent group's running container so the new backend env applies.
  for (const g of getAllAgentGroups()) {
    if (g.folder === '_default_participant') continue;
    restartAgentGroupContainers(g.id, 'web-search-backend-change');
  }
  return { status: 200, body: { ok: true, active: provider } };
}
```
(Match the exact `PlaygroundSession`/`ApiResult` imports used by sibling handlers — open `enrollment.ts` to confirm paths/shape, as in the default-participant API handler.)

- [ ] **Step 4: Wire routes** — in `src/channels/playground/api-routes.ts`, import the two handlers and add near the other `/api/...` matches:
```typescript
if (method === 'GET' && url.pathname === '/api/web-search-config') return handleGetWebSearchConfig(session);
if (method === 'POST' && url.pathname === '/api/web-search-config') return handlePostWebSearchConfig(session, await readJsonBody(req));
```
(Use the exact `readJsonBody` mechanism the sibling POSTs use in this file.)

- [ ] **Step 5: Run + build + full suite + commit**

```bash
pnpm exec vitest run src/channels/playground/api/web-search-config.test.ts && pnpm run build && pnpm test
git add src/channels/playground/api/web-search-config.ts src/channels/playground/api/web-search-config.test.ts src/channels/playground/api-routes.ts
git commit -m "feat(web-search): owner-gated config API (status/availability/set)"
```
Expected: PASS, tsc 0, full suite green.

---

### Task 6: Owner "Web Search" card

**Files:**
- Modify: the Home-tab frontend (find with `grep -rn "Default Participant Template\|renderDefaultParticipant" src/channels/playground/public`)

- [ ] **Step 1: Locate the pattern.** Read how the **Default Participant Template** card is rendered + owner-gated + how it calls its `/api/...` endpoints. Mirror those idioms (owner-only render, GET-on-load, `escapeHtml` on all server values, `textContent` for status, fetch with `credentials: 'same-origin'`).

- [ ] **Step 2: Add the card.** Owner-only "Web Search" card that on load `GET`s `/api/web-search-config` and renders the three backends as a radio group:
  - Each backend: label + radio; `disabled` when `!available`; show the `note` (greyed text) when present. **OpenAI** is always disabled with its note.
  - The `active` backend is pre-selected.
  - On selecting an enabled backend → `POST /api/web-search-config` with `{ provider: <id> }`; on `200` update the active state + show a note "Switched to <label>; agents will use it on their next message (containers respawned)."; on `400/403` show the error text.
  - All server-provided strings rendered via `escapeHtml`; status via `textContent`.
  - Hidden entirely for non-owner sessions (mirror the Default Participant Template gating).

- [ ] **Step 3: Build + commit**

```bash
node --check src/channels/playground/public/tabs/home.js   # or wherever the card lives
pnpm run build
git add src/channels/playground/public
git commit -m "feat(web-search): owner Web Search backend toggle card"
```
Expected: syntax OK, tsc 0.

---

### Task 7: Container rebuild + live verification + state.md

- [ ] **Step 1: Rebuild the agent image (cache-prune per CLAUDE.md)**

```bash
docker buildx prune -f 2>/dev/null || true
./container/build.sh
```
Expected: image `nanoclaw-agent-v2-581fefa4:latest` rebuilt with the new `web-search.ts`. (Confirm the build copied the new `web-search/` dir — the CLAUDE.md "Container Build Cache" note warns `--no-cache` alone leaves stale COPY; the prune handles it.)

- [ ] **Step 2: Set default + restart host**

```bash
# default is searxng (config absent) — confirm SEARXNG_URL is in .env (Task 1)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-581fefa4
sleep 6
```

- [ ] **Step 3: Live verify** (capture actual output; don't claim success without it):
  1. Owner page → **Web Search** card: Brave shows available iff key set; **SearXNG available**; **OpenAI greyed**.
  2. Select **SearXNG** → an agent asked "what is the weather in Paris right now" returns **current results via SearXNG** (trace shows `web_search` succeeding, `details.provider==='searxng'`, no 422).
  3. If a Brave key is set, flip to **Brave** → still works (`details.provider==='brave'`).
  4. Confirm `data/config/web-search.json` reflects the selection.

- [ ] **Step 4: Update `state.md`** — decision-log entry (pluggable web search shipped: Brave + SearXNG backends, owner toggle, SearXNG managed default, OpenAI deferred) + drain/annotate any related Open follow-up. Run `pnpm refresh-state`. (state.md is committed via the husky hook.)

---

## Self-Review

**Spec coverage:** pluggable backend dispatch (Task 3) ✓; Brave preserved as default so existing test passes (Task 3 Step 8) ✓; SearXNG backend + tests (Task 3) ✓; install-wide config (Task 2) ✓; container env forwarding `WEB_SEARCH_PROVIDER`+`SEARXNG_URL` (Task 4) ✓; SearXNG managed service (Task 1) ✓; owner card + API with per-backend availability + OpenAI greyed (Tasks 5,6) ✓; respawn-on-switch (Task 5 POST) ✓; container rebuild (Task 7) ✓; testing + live verify (Task 3,5,7) ✓; boundaries (no Tavily, no OpenAI backend, no per-agent) ✓.

**Placeholder scan:** Task 4 Step 2 and Task 6 reference "follow the existing pattern / decide via grep" — these are pointers to copy verified local idioms (the `buildContainerArgs` test harness may not exist; the card mirrors the Default Participant Template card), not unfinished logic. All backend/config/API code is complete and copy-pasteable.

**Type consistency:** `WebSearchProvider = 'brave'|'searxng'` defined in Task 2, used in Tasks 4 (forward) + 5 (API). `SearchResult = {title,url,snippet}` defined in Task 3 types.ts, produced by `braveSearch`/`searxngSearch`, consumed by `formatResults`. `WEB_SEARCH_PROVIDER` env name consistent across Task 3 (read) + Task 4 (write). `SEARXNG_URL` consistent across Task 1 (.env) + Task 3 (read) + Task 4 (forward) + Task 5 (probe). `readWebSearchProvider`/`writeWebSearchProvider` signatures consistent across Tasks 2/4/5.
