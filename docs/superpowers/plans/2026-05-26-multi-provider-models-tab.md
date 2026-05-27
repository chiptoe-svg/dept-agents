# Multi-Provider Models Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the playground Models tab + per-student credential system to cleanly cover Anthropic, OpenAI-codex, OpenAI Platform (new), and OMLX (local), with each upstream provider as a single self-contained TypeScript module so future Google/OpenRouter additions are one-file changes.

**Architecture:** Each provider is a `*-spec.ts` module under `src/providers/` that owns its auth methods, catalog entries, and proxy route. `auth-registry.ts` is extended to carry `catalogModels`, optional `reachability` probe, and a new `'none'` credentialFileShape. `model-catalog.ts` shrinks to a concat of each spec module's catalogModels. A new `GET /api/me/models-tab-state` endpoint runs the greying rule server-side and returns a `{state, source, actionLabel, catalogModels}` triple per provider; the frontend renders it verbatim with no client-side policy logic.

**Tech Stack:** TypeScript (host, Node 22) · vitest · vanilla JS (playground frontend) · happy-dom (frontend unit tests) · better-sqlite3 · existing per-student credential storage (already shipped on trunk).

**Spec:** `docs/superpowers/specs/2026-05-26-multi-provider-models-tab-design.md` — refer back for "why" and acceptance criteria.

---

## File structure

**Created:**
```
src/providers/openai-platform-spec.ts              # new: API-key-only provider + gpt-4o family catalog
src/providers/openai-platform-spec.test.ts
src/providers/omlx-spec.ts                          # new: none-auth provider + reachability + Qwen3.6 catalog
src/providers/omlx-spec.test.ts
src/channels/playground/api/models-tab-state.ts     # new: greying-rule + endpoint handler
src/channels/playground/api/models-tab-state.test.ts
src/channels/playground/public/components/cred-dialog.js  # new: shared dialog extracted from home.js
```

**Modified:**
```
src/providers/auth-registry.ts                      # extend ProviderAuthSpec: catalogModels, reachability, 'none' shape
src/providers/claude-spec.ts                        # add catalogModels (move 2 entries from model-catalog.ts)
src/providers/codex-spec.ts                         # add catalogModels (move 5 entries from model-catalog.ts)
src/model-catalog.ts                                # BUILTIN_ENTRIES = concat from spec modules
src/credential-proxy.ts                             # OMLX_API_KEY default 'local' -> 'godfrey'; /openai-platform/* route
src/channels/playground/api-routes.ts               # register /api/me/models-tab-state
src/channels/playground/public/tabs/models.js       # v2 layout; per-provider sections; greyed/hidden states; inline manage link
src/channels/playground/public/tabs/home.js         # call into the extracted shared cred-dialog component
src/channels/playground/api/class-controls.ts       # default-controls entries for the 2 new providers
.env.example                                        # if exists: document OPENAI_PLATFORM_API_KEY + OMLX_API_KEY default
```

**Working branch:** `multi-provider-models-tab` off `main` (HEAD `c34711a`).

**Conventions:**
- **Plan before executing.** This plan IS the plan. Update it as phases land; tick checkboxes off.
- **Use codegraph first** for any structural lookup (codegraph_search, codegraph_callers, codegraph_context) per global CLAUDE.md.
- **Run `pnpm run build` yourself before committing each task** — vitest tolerates TS errors that tsc rejects (memory `feedback-verify-build-yourself`).
- **Commit per task** with `mptab-N:` prefix. Trailer: `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`.
- **Do NOT stage** `config/playground-seats.json` (install-local) or `.codegraph/` (index dir).
- **Security hook** blocks `Write` of files containing the literal three-character sequence `d-b-.-e-x-e-c-(` — use Bash `cat >` for those files.

---

## Task 1: Extend `ProviderAuthSpec` with `catalogModels`, `reachability`, and `'none'` shape

**Files:**
- Modify: `src/providers/auth-registry.ts`
- Create: `src/providers/auth-registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/providers/auth-registry.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { registerProvider, getProviderSpec, resetRegistryForTests } from './auth-registry.js';
import type { ProviderAuthSpec } from './auth-registry.js';

beforeEach(() => resetRegistryForTests());

describe('ProviderAuthSpec extensions', () => {
  it('accepts a spec with catalogModels and returns them via getProviderSpec', () => {
    const spec: ProviderAuthSpec = {
      id: 'test-provider',
      displayName: 'Test Provider',
      proxyRoutePrefix: '/test/',
      credentialFileShape: 'api-key',
      apiKey: { placeholder: 'tk-…' },
      catalogModels: [
        {
          id: 'test-model-1',
          modelProvider: 'test-provider',
          displayName: 'Test Model 1',
          origin: 'cloud',
          costPer1kInUsd: 0.01,
          costPer1kOutUsd: 0.03,
        },
      ],
    };
    registerProvider(spec);
    const fetched = getProviderSpec('test-provider');
    expect(fetched).not.toBeNull();
    expect(fetched!.catalogModels).toHaveLength(1);
    expect(fetched!.catalogModels![0].id).toBe('test-model-1');
  });

  it('accepts a spec with credentialFileShape="none" (no oauth, no apiKey)', () => {
    const spec: ProviderAuthSpec = {
      id: 'local-test',
      displayName: 'Local Test',
      proxyRoutePrefix: '/local-test/',
      credentialFileShape: 'none',
      catalogModels: [],
    };
    registerProvider(spec);
    expect(getProviderSpec('local-test')).not.toBeNull();
  });

  it('accepts a spec with a reachability probe', async () => {
    const spec: ProviderAuthSpec = {
      id: 'local-with-probe',
      displayName: 'Local With Probe',
      proxyRoutePrefix: '/local-test/',
      credentialFileShape: 'none',
      catalogModels: [],
      reachability: async () => true,
    };
    registerProvider(spec);
    const fetched = getProviderSpec('local-with-probe');
    expect(fetched!.reachability).toBeDefined();
    expect(await fetched!.reachability!()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --run src/providers/auth-registry.test.ts`
Expected: FAIL — `catalogModels`/`reachability` not in the type; `'none'` not assignable to `credentialFileShape`.

- [ ] **Step 3: Extend the type in `src/providers/auth-registry.ts`**

Add the import near the top:

```typescript
import type { ModelEntry } from '../model-catalog.js';
```

Replace `credentialFileShape` union with `'oauth-token' | 'api-key' | 'mixed' | 'none'`. Append to the `ProviderAuthSpec` type:

```typescript
  /** Catalog entries this provider owns. model-catalog.ts concatenates
   *  these across all registered specs to form BUILTIN_ENTRIES. */
  catalogModels?: ModelEntry[];
  /** Optional liveness probe. OMLX uses it. When defined, models-tab-state
   *  caches the result for 30 seconds. */
  reachability?: () => Promise<boolean>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --run src/providers/auth-registry.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Verify build + full suite**

Run: `pnpm run build && pnpm test --run 2>&1 | tail -5`
Expected: clean; 1008+ tests pass.

- [ ] **Step 6: Commit**

```
git add src/providers/auth-registry.ts src/providers/auth-registry.test.ts
git commit -m "feat(provider): extend ProviderAuthSpec with catalogModels + reachability + 'none' shape (mptab-1)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: Move Anthropic catalog entries into `claude-spec.ts`

**Files:**
- Modify: `src/providers/claude-spec.ts`
- Modify: `src/model-catalog.ts` (remove the 2 Anthropic entries from BUILTIN_ENTRIES)
- Create: `src/providers/claude-spec.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/providers/claude-spec.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { getProviderSpec } from './auth-registry.js';
import './claude-spec.js'; // side-effect import to register

describe('claude-spec owns Anthropic catalog entries', () => {
  it('registers catalogModels with claude-haiku-4-5 and claude-sonnet-4-6', () => {
    const spec = getProviderSpec('claude');
    expect(spec).not.toBeNull();
    expect(spec!.catalogModels).toBeDefined();
    const ids = spec!.catalogModels!.map((m) => m.id);
    expect(ids).toContain('claude-haiku-4-5');
    expect(ids).toContain('claude-sonnet-4-6');
  });

  it('catalog entries use modelProvider="anthropic" (Phase D rename)', () => {
    const spec = getProviderSpec('claude');
    for (const entry of spec!.catalogModels!) {
      expect(entry.modelProvider).toBe('anthropic');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --run src/providers/claude-spec.test.ts`
Expected: FAIL — `spec.catalogModels` undefined.

- [ ] **Step 3: Move entries into `claude-spec.ts`**

Read the current 2 Anthropic entries from `src/model-catalog.ts` (BUILTIN_ENTRIES). In `src/providers/claude-spec.ts`, add at top:

```typescript
import type { ModelEntry } from '../model-catalog.js';
```

Inside the existing `registerProvider({...})` call, after the `apiKey: {...}` field, add:

```typescript
  catalogModels: [
    {
      id: 'claude-haiku-4-5',
      modelProvider: 'anthropic',
      displayName: 'claude-haiku-4-5',
      origin: 'cloud',
      costPer1kInUsd: 0.001,
      costPer1kOutUsd: 0.005,
      costPer1kCachedInUsd: 0.0001,
      costPer1kTokensUsd: 0.0008,
      avgLatencySec: 0.9,
      paramCount: 'not disclosed',
      modalities: ['text', 'image'],
      chips: ['⚡ fast', '$ cheap', '☁ Anthropic'],
      bestFor: 'Short answers, classification, structured output.',
    },
    {
      id: 'claude-sonnet-4-6',
      modelProvider: 'anthropic',
      displayName: 'claude-sonnet-4-6',
      origin: 'cloud',
      costPer1kInUsd: 0.003,
      costPer1kOutUsd: 0.015,
      costPer1kCachedInUsd: 0.0003,
      costPer1kTokensUsd: 0.012,
      avgLatencySec: 2.1,
      paramCount: 'not disclosed',
      modalities: ['text', 'image'],
      chips: ['🐢 slower', '$$ pricier', '☁ Anthropic'],
      bestFor: 'Reasoning, long outputs.',
      default: true,
    },
  ] satisfies ModelEntry[],
```

- [ ] **Step 4: Remove the 2 Anthropic entries from `src/model-catalog.ts` BUILTIN_ENTRIES**

Delete the two literal blocks. The 5 codex entries + 1 local entry stay for now.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test --run src/providers/claude-spec.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 6: Verify build + full suite**

Run: `pnpm run build && pnpm test --run 2>&1 | tail -5`
Expected: clean; test count stable.

- [ ] **Step 7: Commit**

```
git add src/providers/claude-spec.ts src/providers/claude-spec.test.ts src/model-catalog.ts
git commit -m "refactor(provider): claude-spec owns Anthropic catalog entries (mptab-2)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: Move codex catalog entries into `codex-spec.ts`

**Files:**
- Modify: `src/providers/codex-spec.ts`
- Modify: `src/model-catalog.ts` (remove the 5 codex entries)
- Create: `src/providers/codex-spec.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/providers/codex-spec.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { getProviderSpec } from './auth-registry.js';
import './codex-spec.js';

describe('codex-spec owns OpenAI-codex catalog entries', () => {
  it('registers all 5 codex models with modelProvider="openai-codex"', () => {
    const spec = getProviderSpec('codex');
    expect(spec).not.toBeNull();
    const ids = spec!.catalogModels!.map((m) => m.id).sort();
    expect(ids).toEqual(['gpt-5.2', 'gpt-5.3-codex', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.5']);
    for (const entry of spec!.catalogModels!) {
      expect(entry.modelProvider).toBe('openai-codex');
    }
  });

  it('preserves the gpt-5.5 default:true flag', () => {
    const spec = getProviderSpec('codex');
    const gpt55 = spec!.catalogModels!.find((m) => m.id === 'gpt-5.5');
    expect(gpt55?.default).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --run src/providers/codex-spec.test.ts`
Expected: FAIL — `spec.catalogModels` undefined.

- [ ] **Step 3: Move 5 codex entries from `model-catalog.ts` into `codex-spec.ts`**

In `codex-spec.ts` add import + a `catalogModels: [...] satisfies ModelEntry[]` field. The 5 entries currently live in `model-catalog.ts` under the comment block starting with `// Codex model entries — IDs + descriptions + pricing pulled verbatim`. Copy them verbatim. Then delete them from `model-catalog.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --run src/providers/codex-spec.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Verify build + full suite**

Run: `pnpm run build && pnpm test --run 2>&1 | tail -5`
Expected: clean.

- [ ] **Step 6: Commit**

```
git add src/providers/codex-spec.ts src/providers/codex-spec.test.ts src/model-catalog.ts
git commit -m "refactor(provider): codex-spec owns OpenAI-codex catalog entries (mptab-3)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: Assemble `BUILTIN_ENTRIES` from registered specs

**Files:**
- Modify: `src/model-catalog.ts`
- Create: `src/model-catalog.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/model-catalog.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { getBuiltinEntries } from './model-catalog.js';

// Side-effect imports register specs into the auth registry.
import './providers/claude-spec.js';
import './providers/codex-spec.js';

describe('model-catalog BUILTIN_ENTRIES assembly', () => {
  it('includes entries from claude-spec', () => {
    const ids = getBuiltinEntries().map((e) => e.id);
    expect(ids).toContain('claude-haiku-4-5');
    expect(ids).toContain('claude-sonnet-4-6');
  });

  it('includes entries from codex-spec', () => {
    const ids = getBuiltinEntries().map((e) => e.id);
    expect(ids).toContain('gpt-5.5');
    expect(ids).toContain('gpt-5.4-mini');
  });

  it('has no duplicate (modelProvider, id) pairs', () => {
    const seen = new Set<string>();
    for (const e of getBuiltinEntries()) {
      const key = `${e.modelProvider}:${e.id}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --run src/model-catalog.test.ts`
Expected: FAIL — `getBuiltinEntries` not exported.

- [ ] **Step 3: Refactor `src/model-catalog.ts`**

Add near the top:

```typescript
import { listProviderSpecs } from './providers/auth-registry.js';

// Side-effect imports so registrations happen before any catalog read.
import './providers/claude-spec.js';
import './providers/codex-spec.js';
// Future provider modules add their own import line here.
```

Replace the static `BUILTIN_ENTRIES` array with:

```typescript
/** Returns the assembled built-in catalog: concat of every registered
 *  ProviderAuthSpec's catalogModels. Order: registration order. */
export function getBuiltinEntries(): ModelEntry[] {
  return listProviderSpecs().flatMap((s) => s.catalogModels ?? []);
}
```

Update every existing reference to `BUILTIN_ENTRIES` in this file to call `getBuiltinEntries()` instead. The local-overrides path (reading `MODEL_CATALOG_LOCAL_PATH`) stays unchanged and merges after.

The 1 remaining local Qwen3.6 entry in BUILTIN_ENTRIES stays inline for now — it moves into `omlx-spec.ts` in Task 6.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --run src/model-catalog.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Verify build + full suite**

Run: `pnpm run build && pnpm test --run 2>&1 | tail -5`
Expected: clean.

- [ ] **Step 6: Commit**

```
git add src/model-catalog.ts src/model-catalog.test.ts
git commit -m "refactor(catalog): assemble BUILTIN_ENTRIES from spec modules (mptab-4)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: Create `openai-platform-spec.ts` (new provider)

**Files:**
- Create: `src/providers/openai-platform-spec.ts`
- Create: `src/providers/openai-platform-spec.test.ts`
- Modify: `src/providers/index.ts` (barrel import)
- Modify: `src/credential-proxy.ts` (`/openai-platform/*` proxy route)
- Modify: `src/model-catalog.ts` (one more side-effect import)

- [ ] **Step 1: Write the failing test**

Create `src/providers/openai-platform-spec.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { getProviderSpec } from './auth-registry.js';
import './openai-platform-spec.js';

describe('openai-platform-spec', () => {
  it('registers as id="openai-platform" with apiKey-only credential shape', () => {
    const spec = getProviderSpec('openai-platform');
    expect(spec).not.toBeNull();
    expect(spec!.credentialFileShape).toBe('api-key');
    expect(spec!.oauth).toBeUndefined();
    expect(spec!.apiKey).toBeDefined();
    expect(spec!.apiKey!.placeholder).toMatch(/^sk-/);
  });

  it('ships gpt-4o, gpt-4o-mini, and o3-mini catalog entries', () => {
    const spec = getProviderSpec('openai-platform');
    const ids = spec!.catalogModels!.map((m) => m.id).sort();
    expect(ids).toEqual(['gpt-4o', 'gpt-4o-mini', 'o3-mini']);
    for (const entry of spec!.catalogModels!) {
      expect(entry.modelProvider).toBe('openai-platform');
    }
  });

  it('proxyRoutePrefix is /openai-platform/', () => {
    const spec = getProviderSpec('openai-platform');
    expect(spec!.proxyRoutePrefix).toBe('/openai-platform/');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --run src/providers/openai-platform-spec.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/providers/openai-platform-spec.ts`**

```typescript
import type { ModelEntry } from '../model-catalog.js';
import { registerProvider } from './auth-registry.js';

registerProvider({
  id: 'openai-platform',
  displayName: 'OpenAI Platform',
  proxyRoutePrefix: '/openai-platform/',
  credentialFileShape: 'api-key',
  apiKey: {
    placeholder: 'sk-…',
    validatePrefix: 'sk-',
  },
  catalogModels: [
    {
      id: 'gpt-4o',
      modelProvider: 'openai-platform',
      displayName: 'gpt-4o',
      origin: 'cloud',
      costPer1kInUsd: 0.0025,
      costPer1kOutUsd: 0.01,
      costPer1kCachedInUsd: 0.00125,
      avgLatencySec: 2.0,
      modalities: ['text', 'image'],
      chips: ['☁ OpenAI', '$$ pricier'],
      notes: 'OpenAI Platform direct-API. Standard multi-modal model.',
      bestFor: 'General coding + writing when ChatGPT subscription routing is unavailable.',
    },
    {
      id: 'gpt-4o-mini',
      modelProvider: 'openai-platform',
      displayName: 'gpt-4o-mini',
      origin: 'cloud',
      costPer1kInUsd: 0.00015,
      costPer1kOutUsd: 0.0006,
      costPer1kCachedInUsd: 0.000075,
      avgLatencySec: 1.0,
      modalities: ['text', 'image'],
      chips: ['☁ OpenAI', '⚡ fast', '$ cheap'],
      notes: 'Small fast Platform model.',
      bestFor: 'Subagents, classification, short answers.',
    },
    {
      id: 'o3-mini',
      modelProvider: 'openai-platform',
      displayName: 'o3-mini',
      origin: 'cloud',
      costPer1kInUsd: 0.0011,
      costPer1kOutUsd: 0.0044,
      avgLatencySec: 3.5,
      modalities: ['text'],
      chips: ['☁ OpenAI', '🧠 reasoning'],
      notes: 'Reasoning-tuned Platform model.',
      bestFor: 'Stepwise reasoning, math, structured analysis.',
    },
  ] satisfies ModelEntry[],
});
```

- [ ] **Step 4: Add side-effect imports**

In `src/providers/index.ts` add:

```typescript
import './openai-platform-spec.js';
```

In `src/model-catalog.ts` add the same line near the other provider imports.

- [ ] **Step 5: Add `/openai-platform/*` route in `src/credential-proxy.ts`**

Find the existing OMLX route by `grep -n omlx src/credential-proxy.ts`. Mirror it for OpenAI Platform:

- New `if (url.pathname.startsWith('/openai-platform/'))` branch
- Strips the `/openai-platform` prefix and forwards to `https://api.openai.com`
- Substitutes `Authorization: Bearer ${OPENAI_PLATFORM_API_KEY}` from env (or per-student key via the existing `studentCredsHook(agentGroupId, 'openai-platform')` — fall back to env when null)
- Logs the substitution like the other routes

Read the existing `/openai/*` route (the ChatGPT-codex one) for the exact substitution pattern.

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test --run src/providers/openai-platform-spec.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 7: Verify build + full suite**

Run: `pnpm run build && pnpm test --run 2>&1 | tail -5`
Expected: clean.

- [ ] **Step 8: Commit**

```
git add src/providers/openai-platform-spec.ts src/providers/openai-platform-spec.test.ts src/providers/index.ts src/model-catalog.ts src/credential-proxy.ts
git commit -m "feat(provider): openai-platform-spec (API-key direct OpenAI API) (mptab-5)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: Create `omlx-spec.ts` (none-auth, reachability)

**Files:**
- Create: `src/providers/omlx-spec.ts`
- Create: `src/providers/omlx-spec.test.ts`
- Modify: `src/providers/index.ts` (barrel import)
- Modify: `src/model-catalog.ts` (side-effect import; remove inline Qwen3.6 entry)

- [ ] **Step 1: Write the failing test**

Create `src/providers/omlx-spec.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { getProviderSpec } from './auth-registry.js';
import './omlx-spec.js';

describe('omlx-spec', () => {
  it('registers as id="omlx" with credentialFileShape="none"', () => {
    const spec = getProviderSpec('omlx');
    expect(spec).not.toBeNull();
    expect(spec!.credentialFileShape).toBe('none');
    expect(spec!.oauth).toBeUndefined();
    expect(spec!.apiKey).toBeUndefined();
  });

  it('owns Qwen3.6 catalog entry with modelProvider="local"', () => {
    const spec = getProviderSpec('omlx');
    const ids = spec!.catalogModels!.map((m) => m.id);
    expect(ids).toContain('Qwen3.6-35B-A3B-UD-MLX-4bit');
    for (const e of spec!.catalogModels!) {
      expect(e.modelProvider).toBe('local');
      expect(e.origin).toBe('local');
    }
  });

  it('reachability probe hits /v1/models (mocked)', async () => {
    const spec = getProviderSpec('omlx');
    expect(spec!.reachability).toBeDefined();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const ok = await spec!.reachability!();
    expect(ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/v1/models'),
      expect.any(Object),
    );
    fetchSpy.mockRestore();
  });

  it('reachability returns false on network error', async () => {
    const spec = getProviderSpec('omlx');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const ok = await spec!.reachability!();
    expect(ok).toBe(false);
    fetchSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --run src/providers/omlx-spec.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/providers/omlx-spec.ts`**

```typescript
import type { ModelEntry } from '../model-catalog.js';
import { registerProvider } from './auth-registry.js';

const OMLX_BASE_URL = process.env.OMLX_BASE_URL || 'http://localhost:8000';

async function probeReachability(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${OMLX_BASE_URL}/v1/models`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

registerProvider({
  id: 'omlx',
  displayName: 'OMLX (local server)',
  proxyRoutePrefix: '/omlx/',
  credentialFileShape: 'none',
  catalogModels: [
    {
      id: 'Qwen3.6-35B-A3B-UD-MLX-4bit',
      modelProvider: 'local',
      displayName: 'Qwen3.6-35B-A3B (MLX 4-bit)',
      origin: 'local',
      costPer1kInUsd: 0,
      costPer1kOutUsd: 0,
      host: OMLX_BASE_URL,
      paramCount: '35B',
      avgLatencySec: 8,
      modalities: ['text'],
      chips: ['🆓 free', '💻 mlx local', '🐢 slower'],
      notes: 'Local MLX model. No cloud auth.',
      bestFor: 'Comparing local vs cloud cost/latency tradeoffs.',
    },
  ] satisfies ModelEntry[],
  reachability: probeReachability,
});
```

- [ ] **Step 4: Add barrel + catalog imports**

In `src/providers/index.ts` and `src/model-catalog.ts` add:

```typescript
import './omlx-spec.js';
```

(In `model-catalog.ts`, place near the other provider imports.)

- [ ] **Step 5: Remove the inline Qwen3.6 entry from `src/model-catalog.ts`**

Delete the local entry block (the only remaining literal in the original BUILTIN_ENTRIES). `getBuiltinEntries()` will pick it up from the spec.

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test --run src/providers/omlx-spec.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 7: Verify build + full suite**

Run: `pnpm run build && pnpm test --run 2>&1 | tail -5`
Expected: clean.

- [ ] **Step 8: Commit**

```
git add src/providers/omlx-spec.ts src/providers/omlx-spec.test.ts src/providers/index.ts src/model-catalog.ts
git commit -m "feat(provider): omlx-spec (local server with reachability probe) (mptab-6)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: Default `OMLX_API_KEY` to `'godfrey'` in credential-proxy

**Files:**
- Modify: `src/credential-proxy.ts`
- Modify (or create): `src/credential-proxy.test.ts`
- Modify (if exists): `.env.example`

- [ ] **Step 1: Write the failing test**

Append to `src/credential-proxy.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveOmlxKey } from './credential-proxy.js';

describe('credential-proxy OMLX_API_KEY default', () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.OMLX_API_KEY;
    delete process.env.OMLX_API_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.OMLX_API_KEY;
    else process.env.OMLX_API_KEY = originalKey;
  });

  it('defaults to "godfrey" when OMLX_API_KEY is unset', () => {
    expect(resolveOmlxKey()).toBe('godfrey');
  });

  it('uses OMLX_API_KEY env when set', () => {
    process.env.OMLX_API_KEY = 'classroom-shared-key';
    expect(resolveOmlxKey()).toBe('classroom-shared-key');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --run src/credential-proxy.test.ts`
Expected: FAIL — `resolveOmlxKey` not exported, or default is still `'local'`.

- [ ] **Step 3: Edit `src/credential-proxy.ts`**

Find the existing OMLX key resolution (likely `process.env.OMLX_API_KEY || 'local'` or similar). Replace with:

```typescript
/** Resolve the OMLX upstream auth token. Defaults to literal "godfrey"
 *  so the auth-substitution path is always exercised even on installs
 *  that haven't configured a real key. Override by setting OMLX_API_KEY. */
export function resolveOmlxKey(): string {
  return process.env.OMLX_API_KEY ?? 'godfrey';
}
```

Replace any `'local'` literal substitution at the OMLX route with `resolveOmlxKey()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --run src/credential-proxy.test.ts`
Expected: PASS.

- [ ] **Step 5: Update `.env.example` if it exists**

Append:

```
# OMLX local server bearer token. Defaults to "godfrey" if unset —
# leave as-is unless your local OMLX server enforces a real key.
# OMLX_API_KEY=godfrey

# OpenAI Platform (direct API) key — class-pool fallback when a student
# has no personal key. Leave unset to require per-student keys.
# OPENAI_PLATFORM_API_KEY=sk-...
```

- [ ] **Step 6: Verify build + full suite**

Run: `pnpm run build && pnpm test --run 2>&1 | tail -5`
Expected: clean.

- [ ] **Step 7: Commit**

```
git add src/credential-proxy.ts src/credential-proxy.test.ts .env.example
git commit -m "fix(proxy): default OMLX_API_KEY to 'godfrey' (mptab-7)

Keeps the auth-substitution path always exercised. Easy to swap to a
real key by setting OMLX_API_KEY in .env.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 8: Greying-rule pure function + truth-table test

**Files:**
- Create: `src/channels/playground/api/models-tab-state.ts` (pure function only — endpoint in Task 9)
- Create: `src/channels/playground/api/models-tab-state.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/channels/playground/api/models-tab-state.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { deriveProviderState } from './models-tab-state.js';
import type { SpecFacts } from './models-tab-state.js';

const baseSpec: SpecFacts = {
  id: 'test',
  displayName: 'Test',
  catalogModels: [],
  hasReachabilityProbe: false,
  isLocalOnly: false,
  hasOauthMethod: false,
  hasApiKeyMethod: true,
};

const allow = { allow: true, provideDefault: false, allowByo: false };
const noCreds = { hasOAuth: false, hasApiKey: false };
const ownOauth = { hasOAuth: true, hasApiKey: false };

describe('deriveProviderState — truth table', () => {
  it('HIDDEN when policy.allow=false', () => {
    const r = deriveProviderState({ spec: baseSpec, policy: { ...allow, allow: false }, creds: noCreds, reachable: true });
    expect(r.state).toBe('HIDDEN');
  });

  it('GREYED + "test connection" when local-only and unreachable', () => {
    const r = deriveProviderState({
      spec: { ...baseSpec, hasReachabilityProbe: true, isLocalOnly: true },
      policy: allow, creds: noCreds, reachable: false,
    });
    expect(r.state).toBe('GREYED');
    expect(r.actionLabel).toBe('test connection');
  });

  it('AVAILABLE (source local) when local-only and reachable', () => {
    const r = deriveProviderState({
      spec: { ...baseSpec, hasReachabilityProbe: true, isLocalOnly: true },
      policy: allow, creds: noCreds, reachable: true,
    });
    expect(r.state).toBe('AVAILABLE');
    expect(r.source).toBe('local');
  });

  it('AVAILABLE (source class-pool) when provideDefault=true', () => {
    const r = deriveProviderState({
      spec: baseSpec, policy: { ...allow, provideDefault: true }, creds: noCreds, reachable: true,
    });
    expect(r.state).toBe('AVAILABLE');
    expect(r.source).toBe('class-pool');
  });

  it('AVAILABLE (source personal-oauth) when student has OAuth', () => {
    const r = deriveProviderState({
      spec: baseSpec, policy: { ...allow, allowByo: true }, creds: ownOauth, reachable: true,
    });
    expect(r.state).toBe('AVAILABLE');
    expect(r.source).toBe('personal-oauth');
  });

  it('GREYED + "add api key" when allowByo=true and no creds and apiKey method', () => {
    const r = deriveProviderState({
      spec: baseSpec, policy: { ...allow, allowByo: true }, creds: noCreds, reachable: true,
    });
    expect(r.state).toBe('GREYED');
    expect(r.actionLabel).toBe('add api key');
  });

  it('GREYED + "connect" when allowByo=true, oauth method, no creds', () => {
    const r = deriveProviderState({
      spec: { ...baseSpec, hasOauthMethod: true, hasApiKeyMethod: false },
      policy: { ...allow, allowByo: true }, creds: noCreds, reachable: true,
    });
    expect(r.state).toBe('GREYED');
    expect(r.actionLabel).toBe('connect');
  });

  it('GREYED + "ask instructor" when allow=true but no fallbacks', () => {
    const r = deriveProviderState({ spec: baseSpec, policy: allow, creds: noCreds, reachable: true });
    expect(r.state).toBe('GREYED');
    expect(r.actionLabel).toBe('ask instructor');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --run src/channels/playground/api/models-tab-state.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the function**

Create `src/channels/playground/api/models-tab-state.ts`:

```typescript
/**
 * Greying-rule for the Models tab. Pure function: inputs are policy +
 * cred state + reachability, output is the {state, source, actionLabel}
 * triple the frontend renders verbatim.
 *
 * Truth table (precedence top to bottom):
 *   1. !policy.allow                  -> HIDDEN
 *   2. local-only && !reachable       -> GREYED + "test connection"
 *   3. local-only && reachable        -> AVAILABLE + source=local
 *   4. policy.provideDefault          -> AVAILABLE + source=class-pool
 *   5. has personal creds             -> AVAILABLE + source=personal-{oauth|key}
 *   6. policy.allowByo                -> GREYED + "add api key" or "connect"
 *   7. (else)                         -> GREYED + "ask instructor"
 */

export type ProviderState = 'AVAILABLE' | 'GREYED' | 'HIDDEN';
export type ProviderSource = 'personal-oauth' | 'personal-key' | 'class-pool' | 'local' | null;

export interface SpecFacts {
  id: string;
  displayName: string;
  catalogModels: Array<{ id: string; modelProvider: string }>;
  hasReachabilityProbe: boolean;
  isLocalOnly: boolean;
  hasOauthMethod: boolean;
  hasApiKeyMethod: boolean;
}

export interface ProviderPolicy {
  allow: boolean;
  provideDefault: boolean;
  allowByo: boolean;
}

export interface CredState {
  hasOAuth: boolean;
  hasApiKey: boolean;
}

export interface DerivedProviderState {
  state: ProviderState;
  source: ProviderSource;
  actionLabel: string | null;
}

export function deriveProviderState(input: {
  spec: SpecFacts;
  policy: ProviderPolicy;
  creds: CredState;
  reachable: boolean;
}): DerivedProviderState {
  const { spec, policy, creds, reachable } = input;

  if (!policy.allow) return { state: 'HIDDEN', source: null, actionLabel: null };

  if (spec.isLocalOnly) {
    if (!reachable) return { state: 'GREYED', source: null, actionLabel: 'test connection' };
    return { state: 'AVAILABLE', source: 'local', actionLabel: 'settings' };
  }

  if (policy.provideDefault) {
    return {
      state: 'AVAILABLE',
      source: 'class-pool',
      actionLabel: policy.allowByo ? 'use my own' : 'manage',
    };
  }

  if (creds.hasOAuth) return { state: 'AVAILABLE', source: 'personal-oauth', actionLabel: 'manage' };
  if (creds.hasApiKey) return { state: 'AVAILABLE', source: 'personal-key', actionLabel: 'manage' };

  if (policy.allowByo) {
    const action = spec.hasOauthMethod ? 'connect' : 'add api key';
    return { state: 'GREYED', source: null, actionLabel: action };
  }

  return { state: 'GREYED', source: null, actionLabel: 'ask instructor' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --run src/channels/playground/api/models-tab-state.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Verify build + full suite**

Run: `pnpm run build && pnpm test --run 2>&1 | tail -5`
Expected: clean.

- [ ] **Step 6: Commit**

```
git add src/channels/playground/api/models-tab-state.ts src/channels/playground/api/models-tab-state.test.ts
git commit -m "feat(api): greying-rule pure function for Models tab state (mptab-8)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 9: Add `GET /api/me/models-tab-state` endpoint

**Files:**
- Modify: `src/channels/playground/api/models-tab-state.ts` (append handler)
- Modify: `src/channels/playground/api/models-tab-state.test.ts` (integration test)
- Modify: `src/channels/playground/api-routes.ts` (register route)

- [ ] **Step 1: Write the failing integration test**

Append to `src/channels/playground/api/models-tab-state.test.ts`:

```typescript
import { handleGetModelsTabState } from './models-tab-state.js';

describe('handleGetModelsTabState — integration', () => {
  it('returns one entry per registered provider with the documented shape', async () => {
    // Stub via the existing playground test fixtures: Class Controls allows
    // claude+provideDefault, allowByo openai-platform, hides codex,
    // omlx with allow+provideDefault. Student has no personal creds.
    const res = await handleGetModelsTabState({
      userId: 'user:test',
      agentGroupId: 'ag-test',
      classId: 'default',
    });
    expect(res.status).toBe(200);
    const body = res.body as { providers: Array<{ id: string; state: string }> };
    const map = Object.fromEntries(body.providers.map((p) => [p.id, p.state]));
    expect(map['claude']).toBe('AVAILABLE');
    expect(map['openai-platform']).toBe('GREYED');
    expect(map['codex']).toBe('HIDDEN');
    expect(map['omlx']).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --run src/channels/playground/api/models-tab-state.test.ts`
Expected: FAIL — `handleGetModelsTabState` not defined.

- [ ] **Step 3: Append handler to `src/channels/playground/api/models-tab-state.ts`**

```typescript
import { listProviderSpecs } from '../../../providers/auth-registry.js';
import { readClassControls } from './class-controls.js';
// Confirm the exact helper name with `codegraph_search readPerStudentProviderCreds`
// before importing — likely lives in provider-auth.ts. Adapt if different.
import { readPerStudentProviderCreds } from './provider-auth.js';
import type { ModelEntry } from '../../../model-catalog.js';

const REACHABILITY_CACHE_MS = 30_000;
const reachabilityCache = new Map<string, { value: boolean; expiresAt: number }>();

async function probeWithCache(specId: string, probe: () => Promise<boolean>): Promise<boolean> {
  const now = Date.now();
  const cached = reachabilityCache.get(specId);
  if (cached && cached.expiresAt > now) return cached.value;
  const value = await probe();
  reachabilityCache.set(specId, { value, expiresAt: now + REACHABILITY_CACHE_MS });
  return value;
}

export interface ModelsTabStateResponse {
  providers: Array<{
    id: string;
    displayName: string;
    state: ProviderState;
    source: ProviderSource;
    actionLabel: string | null;
    catalogModels: ModelEntry[];
  }>;
}

export async function handleGetModelsTabState(input: {
  userId: string;
  agentGroupId: string;
  classId: string;
}): Promise<{ status: number; body: ModelsTabStateResponse }> {
  const cc = readClassControls();
  const policies = cc.classes[input.classId]?.providers ?? {};
  const specs = listProviderSpecs();

  const providers = await Promise.all(
    specs.map(async (spec) => {
      const policy = policies[spec.id] ?? { allow: false, provideDefault: false, allowByo: false };
      const creds = readPerStudentProviderCreds(input.userId, spec.id) ?? { hasOAuth: false, hasApiKey: false };
      const isLocalOnly = spec.credentialFileShape === 'none';
      const reachable = spec.reachability ? await probeWithCache(spec.id, spec.reachability) : true;
      const facts: SpecFacts = {
        id: spec.id,
        displayName: spec.displayName,
        catalogModels: (spec.catalogModels ?? []).map((m) => ({ id: m.id, modelProvider: m.modelProvider })),
        hasReachabilityProbe: !!spec.reachability,
        isLocalOnly,
        hasOauthMethod: !!spec.oauth,
        hasApiKeyMethod: !!spec.apiKey,
      };
      const derived = deriveProviderState({ spec: facts, policy, creds, reachable });
      return {
        id: spec.id,
        displayName: spec.displayName,
        state: derived.state,
        source: derived.source,
        actionLabel: derived.actionLabel,
        catalogModels: derived.state === 'HIDDEN' ? [] : (spec.catalogModels ?? []),
      };
    }),
  );

  return { status: 200, body: { providers } };
}
```

- [ ] **Step 4: Register the route in `src/channels/playground/api-routes.ts`**

Mirror a neighboring `/api/me/*` GET handler for auth + session boilerplate. Add:

```typescript
if (method === 'GET' && url.pathname === '/api/me/models-tab-state') {
  const session = await requireSession(req, res);
  if (!session) return;
  const agentGroupId = url.searchParams.get('agentGroupId') ?? '';
  const result = await handleGetModelsTabState({
    userId: session.userId,
    agentGroupId,
    classId: session.classId ?? 'default',
  });
  return send(res, result.status, result.body);
}
```

(Adapt `requireSession` / `send` names to whatever the file's neighboring handlers use.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test --run src/channels/playground/api/models-tab-state.test.ts`
Expected: PASS — 9 tests total (8 unit + 1 integration).

- [ ] **Step 6: Verify build + full suite**

Run: `pnpm run build && pnpm test --run 2>&1 | tail -5`
Expected: clean.

- [ ] **Step 7: Commit**

```
git add src/channels/playground/api/models-tab-state.ts src/channels/playground/api/models-tab-state.test.ts src/channels/playground/api-routes.ts
git commit -m "feat(api): GET /api/me/models-tab-state endpoint (mptab-9)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 10: Extract shared cred dialog component

**Files:**
- Create: `src/channels/playground/public/components/cred-dialog.js`
- Modify: `src/channels/playground/public/tabs/home.js`

- [ ] **Step 1: Find the existing inline dialog code in home.js**

Run: `codegraph_search "Providers card" src/channels/playground/public/tabs/home.js` and read lines 728-943 (the existing `classroom-provider-auth:providers-card-impl` block).

- [ ] **Step 2: Extract the dialog into a new module**

Create `src/channels/playground/public/components/cred-dialog.js` with:

```javascript
/**
 * Shared credential dialog. Open from anywhere with:
 *   openCredDialog({ providerId, providerSpec, currentCredState, onSaved })
 *
 * providerSpec — { id, displayName, credentialFileShape, oauth?, apiKey?, host? }
 * currentCredState — { hasOAuth, hasApiKey, activeMethod?, accountEmail?, tokenExpiresAt? }
 * onSaved — callback fired after Save/Disconnect succeeds.
 *
 * Renders one of four variants based on credentialFileShape:
 *   'oauth-token' -> single OAuth tab
 *   'api-key'     -> single API-key paste tab
 *   'mixed'       -> tabs + active-method radio when both creds set
 *   'none'        -> URL field + reachability probe (Task 11)
 *
 * Wires up:
 *   POST /provider-auth/<id>/start    -> OAuth start (existing endpoint)
 *   POST /provider-auth/<id>/exchange -> OAuth code exchange (existing)
 *   POST /api/me/providers/<id>/api-key -> save key (existing)
 *   POST /api/me/providers/<id>/active  -> set active method (existing)
 *   DELETE /api/me/providers/<id>       -> disconnect (existing)
 */
export function openCredDialog({ providerId, providerSpec, currentCredState, onSaved }) {
  // Build modal DOM. Set data-tab, data-active-method, data-role attributes so
  // Task 13's happy-dom tests can target them.
  // ...
}

export function closeCredDialog() {
  // ...
}
```

Copy the existing dialog logic from home.js verbatim. Make the variant switch based on `providerSpec.credentialFileShape` instead of hardcoded `'claude'`/`'codex'` branches.

- [ ] **Step 3: Replace inline call sites in home.js**

In `src/channels/playground/public/tabs/home.js`, replace the inline dialog open code with:

```javascript
import { openCredDialog } from '../components/cred-dialog.js';

// In the Providers card's per-provider Connect/Manage button handler:
openCredDialog({
  providerId: p.id,
  providerSpec: p,
  currentCredState: p.userCreds,
  onSaved: () => refreshProvidersCard(),
});
```

Delete the now-unused inline template builder + handlers.

- [ ] **Step 4: Smoke-test the Home Providers card manually**

```
pnpm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-581fefa4
```

Open the playground, click Connect on the Home Providers card for Anthropic. Verify the dialog opens and behaves identically to today. Save an API key, verify it persists.

- [ ] **Step 5: Commit**

```
git add src/channels/playground/public/components/cred-dialog.js src/channels/playground/public/tabs/home.js
git commit -m "refactor(playground): extract shared cred-dialog component (mptab-10)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 11: Add `'none'` (OMLX) variant to cred dialog

**Files:**
- Modify: `src/channels/playground/public/components/cred-dialog.js`
- Create: `src/channels/playground/api/omlx-reachability.ts`
- Modify: `src/channels/playground/api-routes.ts`

- [ ] **Step 1: Add the local variant in cred-dialog.js**

In the dialog's variant switch:

```javascript
if (providerSpec.credentialFileShape === 'none') {
  return renderLocalVariant({ providerId, providerSpec, onSaved });
}

function renderLocalVariant({ providerId, providerSpec, onSaved }) {
  // Renders:
  //   * info banner "no credentials needed — local server"
  //   * server URL input (data-role="server-url"), prefilled from providerSpec.host
  //   * reachability state row (data-role="reachability") showing last probe + checked-at
  //   * "Re-test" button -> POST /api/me/providers/<id>/reachability
  //   * "Save" button (only persists URL change if instructor)
  //
  // Lock the URL field read-only when role !== 'instructor'. Confirm role
  // detection pattern with: codegraph_search instanceRole
}
```

- [ ] **Step 2: Add the reachability endpoint handler**

Create `src/channels/playground/api/omlx-reachability.ts`:

```typescript
import { getProviderSpec } from '../../../providers/auth-registry.js';

export async function handleOmlxReachability(): Promise<{
  status: number;
  body: { ok: boolean; checkedAt: string };
}> {
  const spec = getProviderSpec('omlx');
  if (!spec?.reachability) return { status: 404, body: { ok: false, checkedAt: new Date().toISOString() } };
  const ok = await spec.reachability();
  return { status: 200, body: { ok, checkedAt: new Date().toISOString() } };
}
```

Register in `src/channels/playground/api-routes.ts`:

```typescript
if (method === 'POST' && url.pathname === '/api/me/providers/omlx/reachability') {
  const result = await handleOmlxReachability();
  return send(res, result.status, result.body);
}
```

- [ ] **Step 3: Verify the variant manually**

`pnpm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-581fefa4`

In the playground, ensure OMLX appears in the Home Providers card (Task 14 enables this via Class Controls defaults). Click Manage. Confirm the local variant renders, Re-test triggers a probe, state updates accordingly.

- [ ] **Step 4: Commit**

```
git add src/channels/playground/public/components/cred-dialog.js src/channels/playground/api/omlx-reachability.ts src/channels/playground/api-routes.ts
git commit -m "feat(playground): OMLX 'local' variant of cred dialog + reachability endpoint (mptab-11)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 12: Rework Models tab to v2 layout (per-provider sections)

**Files:**
- Modify: `src/channels/playground/public/tabs/models.js`

- [ ] **Step 1: Read existing models.js to identify keep-vs-replace**

`codegraph_search loadModels` then read the relevant function (around line 75). Note keepers (`computeAgentCallCost`, `toggleModel`, `allowedModelsCache`) vs replacers (per-card render loop, modelProvider grouping).

- [ ] **Step 2: Switch `loadModels` to use the new endpoint**

```javascript
async function loadModels() {
  const res = await fetch(`/api/me/models-tab-state?agentGroupId=${encodeURIComponent(currentAgentGroupId)}`);
  const data = await res.json();
  const container = document.getElementById('models-tab-content');
  container.innerHTML = '';

  let hiddenCount = 0;
  const hiddenNames = [];
  for (const provider of data.providers) {
    if (provider.state === 'HIDDEN') {
      hiddenCount++;
      hiddenNames.push(provider.displayName);
      continue;
    }
    container.appendChild(renderProviderSection(provider));
  }
  if (hiddenCount > 0) container.appendChild(renderHiddenFooter(hiddenCount, hiddenNames));
}
```

- [ ] **Step 3: Implement `renderProviderSection`**

```javascript
import { openCredDialog } from '../components/cred-dialog.js';

function renderProviderSection(provider) {
  const section = document.createElement('div');
  section.className = `provider-section provider-section--${provider.state.toLowerCase()}`;
  section.style.marginBottom = '24px';
  if (provider.state === 'GREYED') section.style.opacity = '0.55';

  const header = document.createElement('div');
  header.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:baseline;padding-bottom:6px;border-bottom:1px solid var(--border-subtle);margin-bottom:10px">
      <div style="font-size:14px">
        <b>${escapeHtml(provider.displayName)}</b>
        <span class="status-dot status-dot--${provider.source ?? 'none'}" style="margin-left:8px;font-size:11px">${statusPhrase(provider)}</span>
      </div>
      ${provider.actionLabel
        ? `<a class="provider-action" data-provider="${provider.id}" style="color:var(--link);font-size:11px;cursor:pointer">${provider.actionLabel}</a>`
        : ''}
    </div>
  `;
  section.appendChild(header);

  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px';
  for (const model of provider.catalogModels) grid.appendChild(renderModelCard(model, provider));
  section.appendChild(grid);

  const action = section.querySelector('.provider-action');
  if (action) {
    action.addEventListener('click', () => openCredDialog({
      providerId: provider.id,
      providerSpec: provider,
      currentCredState: { /* fetched via /api/me/providers/<id> if needed */ },
      onSaved: () => loadModels(),
    }));
  }
  return section;
}

function statusPhrase(provider) {
  if (provider.source === 'personal-oauth') return '● your subscription';
  if (provider.source === 'personal-key')   return '● your API key';
  if (provider.source === 'class-pool')     return '● class pool';
  if (provider.source === 'local')          return '● reachable';
  return '○ not connected';
}
```

Drop status-dot color CSS into the existing playground stylesheet:
- `.status-dot--personal-oauth, .status-dot--personal-key, .status-dot--local { color: var(--green); }`
- `.status-dot--class-pool { color: var(--purple); }`
- `.status-dot--none { color: var(--text-muted); }`

- [ ] **Step 4: Implement `renderModelCard` and `renderHiddenFooter`**

```javascript
function renderModelCard(model, provider) {
  const card = document.createElement('div');
  card.style.cssText = 'border:1px solid var(--border-subtle);padding:12px;border-radius:6px';
  card.innerHTML = `
    <div style="font-weight:bold;font-size:13px">${escapeHtml(model.id)}</div>
    <div style="opacity:.7;font-size:11px;margin-top:4px">${formatCostLatency(model)}</div>
    <div style="margin-top:6px">${(model.chips ?? []).map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join(' ')}</div>
  `;
  if (provider.state === 'AVAILABLE') {
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => selectModel(provider.id, model.id));
  }
  return card;
}

function renderHiddenFooter(count, names) {
  const div = document.createElement('div');
  div.style.cssText = 'font-size:11px;color:var(--text-muted);text-align:center;font-style:italic;padding-top:8px;border-top:1px dashed var(--border-subtle);margin-top:16px';
  div.textContent = `${count} provider${count === 1 ? '' : 's'} hidden — ${names.join(', ')} not enabled by instructor.`;
  return div;
}

function formatCostLatency(m) {
  if (m.origin === 'local') return `free${m.avgLatencySec ? ' · ' + m.avgLatencySec + 's' : ''}${m.paramCount ? ' · ' + m.paramCount : ''}`;
  const cost = `$${(m.costPer1kInUsd ?? 0).toFixed(3)}/$${(m.costPer1kOutUsd ?? 0).toFixed(3)} per 1k`;
  const lat = m.avgLatencySec ? ` · ${m.avgLatencySec}s` : '';
  return `${cost}${lat}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
```

- [ ] **Step 5: Live smoke test the new layout**

```
pnpm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-581fefa4
```

Open the playground, navigate to Models. Verify:
- 4 provider sections render (modulo what Class Controls allows)
- Greyed sections show models at reduced opacity
- The hidden-footer counter shows for any `allow: false` provider
- Clicking the action link opens the shared cred dialog

- [ ] **Step 6: Commit**

```
git add src/channels/playground/public/tabs/models.js
git commit -m "feat(playground): Models tab v2 layout — per-provider sections, greyed/hidden states (mptab-12)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 13: Frontend unit tests for cred-dialog

**Files:**
- Create: `src/channels/playground/public/components/cred-dialog.test.ts`

- [ ] **Step 1: Confirm happy-dom is available**

Check `vitest.config.ts` for `environment: 'happy-dom'`. If not configured globally, add the per-file `@vitest-environment happy-dom` comment used below.

- [ ] **Step 2: Write the tests**

Create `src/channels/playground/public/components/cred-dialog.test.ts`:

```typescript
/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openCredDialog, closeCredDialog } from './cred-dialog.js';

beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div>';
});
afterEach(() => {
  closeCredDialog();
  document.body.innerHTML = '';
});

const oauthOnly = { id: 'codex', displayName: 'ChatGPT', credentialFileShape: 'oauth-token', oauth: { clientId: 'x' } };
const apiKeyOnly = { id: 'openai-platform', displayName: 'OpenAI Platform', credentialFileShape: 'api-key', apiKey: { placeholder: 'sk-…' } };
const mixed = { id: 'claude', displayName: 'Anthropic', credentialFileShape: 'mixed', oauth: { clientId: 'y' }, apiKey: { placeholder: 'sk-ant-…' } };
const local = { id: 'omlx', displayName: 'OMLX', credentialFileShape: 'none' };

describe('cred-dialog variants', () => {
  it('oauth-only: one tab, no api-key tab, no active-method radio', () => {
    openCredDialog({ providerId: 'codex', providerSpec: oauthOnly, currentCredState: { hasOAuth: true, hasApiKey: false }, onSaved: () => {} });
    expect(document.querySelectorAll('[data-tab]').length).toBe(1);
    expect(document.querySelector('[data-active-method]')).toBeNull();
  });

  it('api-key-only: paste input visible, no oauth UI', () => {
    openCredDialog({ providerId: 'openai-platform', providerSpec: apiKeyOnly, currentCredState: { hasOAuth: false, hasApiKey: false }, onSaved: () => {} });
    expect(document.querySelector('[data-role="api-key"]')).not.toBeNull();
    expect(document.querySelector('[data-tab="oauth"]')).toBeNull();
  });

  it('mixed with both methods set: two tabs + active-method radio', () => {
    openCredDialog({ providerId: 'claude', providerSpec: mixed, currentCredState: { hasOAuth: true, hasApiKey: true }, onSaved: () => {} });
    expect(document.querySelectorAll('[data-tab]').length).toBe(2);
    expect(document.querySelector('[data-active-method]')).not.toBeNull();
  });

  it('local: URL field + reachability state visible, no cred fields', () => {
    openCredDialog({ providerId: 'omlx', providerSpec: local, currentCredState: { hasOAuth: false, hasApiKey: false }, onSaved: () => {} });
    expect(document.querySelector('[data-role="server-url"]')).not.toBeNull();
    expect(document.querySelector('[data-role="reachability"]')).not.toBeNull();
    expect(document.querySelector('[data-tab]')).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests**

Run: `pnpm test --run src/channels/playground/public/components/cred-dialog.test.ts`
Expected: PASS — 4 tests. If they fail, add the missing `data-*` attributes to `cred-dialog.js` markup so the assertions key off.

- [ ] **Step 4: Verify build + full suite**

Run: `pnpm run build && pnpm test --run 2>&1 | tail -5`
Expected: clean.

- [ ] **Step 5: Commit**

```
git add src/channels/playground/public/components/cred-dialog.test.ts src/channels/playground/public/components/cred-dialog.js
git commit -m "test(playground): cred-dialog variant tests via happy-dom (mptab-13)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 14: Default Class Controls provider entries for new specs

**Files:**
- Modify: `src/channels/playground/api/class-controls.ts`
- Modify (or create): `src/channels/playground/api/class-controls.test.ts`

- [ ] **Step 1: Find `DEFAULT_CLASS_CONTROL` and extend**

Read the file (near the top). Add the 2 new providers to its `providers` map:

```typescript
const DEFAULT_CLASS_CONTROL = {
  tabsVisibleToStudents: [...],
  authModesAvailable: [...],
  providers: {
    claude: { allow: false, provideDefault: false, allowByo: false },
    codex: { allow: false, provideDefault: false, allowByo: false },
    'openai-platform': { allow: false, provideDefault: false, allowByo: false },  // NEW — instructor enables
    omlx: { allow: true, provideDefault: true, allowByo: false },                  // NEW — local, free, default-on
  },
};
```

- [ ] **Step 2: Write a migration-safety test**

Append to `src/channels/playground/api/class-controls.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readClassControls } from './class-controls.js';

describe('Class Controls — old configs gain new provider defaults', () => {
  it('reads a pre-existing config and fills new provider keys without losing existing data', () => {
    // Adapt to the existing test-fixture helper that writes a v2 config file.
    // Write a config with only claude+codex entries, then readClassControls.
    // Assert the result has openai-platform + omlx entries with the expected defaults
    // AND existing claude/codex policies are preserved verbatim.
  });
});
```

- [ ] **Step 3: Verify build + full suite**

Run: `pnpm run build && pnpm test --run 2>&1 | tail -5`
Expected: clean.

- [ ] **Step 4: Commit**

```
git add src/channels/playground/api/class-controls.ts src/channels/playground/api/class-controls.test.ts
git commit -m "feat(class-controls): default openai-platform + omlx provider entries (mptab-14)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 15: Close out the OMLX smoke test

**Files:**
- Modify: `docs/superpowers/plans/2026-05-14-omlx-local-model-integration.md`
- No code changes if smoke passes

- [ ] **Step 1: Verify OMLX server is running**

```
curl -s http://localhost:8000/v1/models | head -1
```
Expected: JSON with `"data": [...]`. If unreachable, start the OMLX server (outside this plan).

- [ ] **Step 2: Configure a test agent group to use the local model**

```
./bin/ncl groups config-update <test-agent-group-id> --model-provider local --model Qwen3.6-35B-A3B-UD-MLX-4bit
```

- [ ] **Step 3: Send a message**

```
curl -X POST http://localhost:3002/api/drafts/<folder>/messages \
  -H 'Content-Type: application/json' \
  -d '{"text": "Reply with the word ALIVE"}'
```

- [ ] **Step 4: Verify the response**

```
tail -f logs/nanoclaw.log | grep -E "(Message delivered|ERROR)"
```

Read the chat row in outbound.db:

```
pnpm exec tsx scripts/q.ts data/v2-sessions/<ag>/<sess>/outbound.db \
  "SELECT id, provider, model, tokens_in, tokens_out, substr(content,1,100) FROM messages_out WHERE kind='chat' ORDER BY seq DESC LIMIT 1"
```

Expected: reply contains `ALIVE`; `model = 'Qwen3.6-...'`; `provider` populated (`local` or pi-ai's internal mapping); `tokens_in/out > 0`.

- [ ] **Step 5: Close out the OMLX plan's open box**

In `docs/superpowers/plans/2026-05-14-omlx-local-model-integration.md`, find the open "Smoke test 2 students end-to-end" task at the bottom and tick it off with a closeout line:

```
- [x] Closed YYYY-MM-DD via mptab-15 — OMLX reachable, agent replied via local provider, cost recorded in messages_out.
```

- [ ] **Step 6: Commit**

```
git add docs/superpowers/plans/2026-05-14-omlx-local-model-integration.md
git commit -m "docs(omlx): close out smoke test step (mptab-15)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 16: End-to-end manual smoke + tag

**Files:**
- Modify: `state.md` (Decision log entry)
- No code changes (validation only)

- [ ] **Step 1: Confirm host is on the latest build**

```
pnpm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-581fefa4
sleep 5 && tail -20 logs/nanoclaw.log | grep -E "(Migration|running|error)"
```

- [ ] **Step 2: Run the spec's 8 acceptance criteria manually + tick each**

- [ ] AC1: Open Models tab → 4 sections render (Anthropic / ChatGPT / OpenAI Platform / OMLX) plus possible footer line.
- [ ] AC2: With instructor `provideDefault: true` for Anthropic + ChatGPT, those sections are AVAILABLE with `● class pool` badges.
- [ ] AC3: With `allowByo: true` for OpenAI Platform and no student key, section is GREYED with `add api key`. Paste + Save → ungreyed within 1 page reload.
- [ ] AC4: OMLX is AVAILABLE + `● reachable · localhost:8000` when up; transitions to GREYED + `test connection` when stopped; back when restarted (within 60s).
- [ ] AC5: Provider with `allow: false` is hidden (visible only in the footer counter).
- [ ] AC6: Home Providers card opens the same dialog as Models tab.
- [ ] AC7: Send chat with `gpt-4o` selected → response delivered → trace shows cost; `messages_out` row has `provider='openai-platform' model='gpt-4o' tokens_in>0 tokens_out>0`.
- [ ] AC8: Proof-of-concept: create temporary `src/providers/google-spec.ts` with one fake catalog entry + one barrel-import line → reload Models tab → Google section appears. Delete the proof file before tagging.

- [ ] **Step 3: Append the state.md Decision log entry**

In `state.md` under `## Decision log` (above the AUTO-GENERATED marker), prepend:

```
- **YYYY-MM-DD** — Multi-provider Models tab + per-student auth extension shipped. Why: extend per-student auth to cover OpenAI Platform + OMLX; rework Models tab to per-provider sections with greyed/hidden states; bake in extensibility for future Google/OpenRouter providers (one TypeScript module each). Tag: `multi-provider-models-tab-complete-YYYY-MM-DD`.
```

- [ ] **Step 4: Tag the milestone**

```
git add state.md
git commit -m "docs(state): log multi-provider Models tab milestone (mptab-16)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git tag -a multi-provider-models-tab-complete-YYYY-MM-DD \
  -m "Multi-provider Models tab + per-student auth extension complete.

All 16 tasks (mptab-1..16) landed:
- Provider-spec module extension (catalogModels + reachability + 'none' auth)
- claude-spec + codex-spec own their catalog entries
- model-catalog assembles from registered specs
- openai-platform-spec (new) — API-key direct OpenAI API
- omlx-spec (new) — local-server with reachability probe
- OMLX_API_KEY defaults to 'godfrey'
- Greying-rule pure function + truth-table tests
- GET /api/me/models-tab-state endpoint
- Shared cred-dialog component (extracted from home.js)
- OMLX variant of cred-dialog + reachability endpoint
- Models tab v2 layout — per-provider sections, greyed/hidden states
- Cred-dialog happy-dom tests
- Class Controls defaults for new providers
- OMLX smoke test closed out

Live-verified against all 8 acceptance criteria.
"
```

- [ ] **Step 5: Push**

```
git push origin main
git push origin --tags
```

---

## Self-review checklist

- [ ] No reference in any new task to pre-Phase-D harness modules (`claude.ts` / `codex.ts`) — those were deleted in Phase D
- [ ] All 4 provider specs (`claude`, `codex`, `openai-platform`, `omlx`) registered and visible via `listProviderSpecs()`
- [ ] No catalog entries left in `src/model-catalog.ts` static array — everything lives in spec modules
- [ ] `getBuiltinEntries()` is the only assembled-catalog accessor; no legacy `BUILTIN_ENTRIES` import remains in the file
- [ ] `/api/me/models-tab-state` returns the documented shape; the truth-table test passes
- [ ] Cred-dialog opens identically from Home Providers card AND Models tab inline link
- [ ] OMLX section renders with reachability state; probe runs at most once per 30s server-side
- [ ] `OMLX_API_KEY` defaults to `'godfrey'` (test passes with env unset)
- [ ] Greyed sections still display models at reduced opacity (not hidden)
- [ ] Hidden providers collapse to one footer line (not separate rows)
- [ ] Host build clean, host vitest green, container untouched
- [ ] Live test of all 8 acceptance criteria passes (Task 16 Step 2)
- [ ] `state.md` Decision log updated in the same commit that ships the milestone
- [ ] Tag `multi-provider-models-tab-complete-YYYY-MM-DD` exists and is pushed
