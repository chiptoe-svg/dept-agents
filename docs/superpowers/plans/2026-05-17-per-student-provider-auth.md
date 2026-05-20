# Per-Student Provider Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-student Anthropic/OpenAI credentials (paste-API-key OR vendor OAuth), with an explicit active-method toggle, instructor-controlled class-pool fallback, and a `classId` seam for future multi-class. Trunk gets the generic registry + hook; classroom branch ships the resolver, storage, OAuth routes, and UI.

**Architecture:** Two layers. Trunk: `src/providers/auth-registry.ts` (registry) + a no-op `studentCredsHook` in `src/credential-proxy.ts`. Classroom branch (installed via new `/add-classroom-provider-auth` skill): per-student credential storage, the resolver that implements the trunk hook, OAuth HTTP routes (PKCE auth-code grant against vendor CLI OAuth client IDs), Class Controls schema migration, and Home/Models UI patches.

**Tech Stack:** Node 22 (host) + Vitest. SQLite (better-sqlite3) for session DBs; JSON-on-disk for per-student creds. Vanilla JS for playground UI. PKCE S256 for OAuth. Existing patterns to mirror: `src/student-google-auth.ts` (storage), `src/channels/playground/api/google-auth.ts` (OAuth routes), `src/channels/playground/api/class-controls.ts` (Class Controls).

**Spec:** `docs/superpowers/specs/2026-05-17-per-student-provider-auth-design.md` — refer back for "why" and acceptance criteria.

## Progress (2026-05-17)

| Tier | Tasks | Status | Commits |
|---|---|---|---|
| Discovery | 1 | ✅ | `51c3465` |
| Trunk infrastructure | 2, 3 | ✅ on `origin/main` | `f632b0a`, `f4faa5e`, `f30cfb0`, `13a43a9`, `73f0ab7`, `b480367` |
| Worktree setup | 4 | ✅ | (no commit — environment setup; worktree at `/Users/admin/projects/nanoclaw-classroom-x7`) |
| Classroom backend | 5–10 | ✅ on `classroom-x7-provider-auth` | `ed651bd`, `8f356af`, `1db3d30`, `f24ae00`, `03a9f75`, `ccdd517`, `c388605`, `8950332`, `9f15051` |
| Classroom UI | 11 | ✅ on `classroom-x7-provider-auth` | `d1e3cbe`, `f3ec9d7` |
| Classroom UI | 12 | ✅ on `classroom-x7-provider-auth` | `c0b28f0`, `9a9fef1` |
| Classroom UI | 13 | ✅ on `classroom-x7-provider-auth` | `b3ec07a`, `0817e34` |
| Wire-up | 14 | ✅ trunk + classroom | `389e719` (main), `f7672bc` (classroom) |
| Skill packaging | 15 | ✅ on `main` | `9bd86f2` |
| Integration test | 16 | ✅ on `classroom-x7-provider-auth` | `eb8b93c` |
| Docs follow-up | 17 | ✅ on `main` | (this commit) |

**Backend total:** 37 tests passing (36 backend + 1 end-to-end integration). Full suite green (793/793 on classroom worktree, 753/753 on main).

**Status:** All 17 tasks complete. Phase X.7 ready for live smoke test (Task 14 step 6 — owner signs in, configures Class Controls, clicks Connect on the Providers card and verifies the authorize URL).

**Update 2026-05-19 — folded into trunk.** The classroom-branch layer
(per-student storage, resolver, OAuth routes, Class Controls v2 schema,
Home Providers card, Models status pills) was merged into trunk on
`main` (commit `e0ef45a`). X.7 no longer ships as a skill install —
`/add-classroom-provider-auth` and the `classroom-x7-provider-auth`
branch are superseded. The two-layer trunk/classroom-branch split
described under **Architecture** above is the original plan, not the
shipped reality. Rationale + cross-links: `plans/master.md` Phase 1.7
follow-ups and Phase 2 #2.

---

## File Inventory

**Trunk (lands on `main`):**
- Create: `src/providers/auth-registry.ts`
- Create: `src/providers/auth-registry.test.ts`
- Create: `src/providers/claude-spec.ts` (registry entry)
- Create: `src/providers/codex-spec.ts` (registry entry)
- Modify: `src/credential-proxy.ts` — add `studentCredsHook` extension point + 402/403 serialization
- Modify: `src/credential-proxy.test.ts` — hook tests
- Create: `docs/providers/oauth-endpoints.md` — research artifact

**Classroom branch (`origin/classroom-x7-provider-auth`):**
- Create: `src/student-provider-auth.ts`
- Create: `src/student-provider-auth.test.ts`
- Create: `src/classroom-provider-resolver.ts`
- Create: `src/classroom-provider-resolver.test.ts`
- Modify: `src/channels/playground/api/class-controls.ts` (schema migration + per-provider toggles)
- Modify: `src/channels/playground/api/class-controls.test.ts`
- Create: `src/channels/playground/api/provider-auth.ts` (OAuth routes + CRUD)
- Create: `src/channels/playground/api/provider-auth.test.ts`
- Modify: `src/channels/playground/server.ts` — register routes (sentinel-bounded)
- Modify: `src/channels/playground/public/tabs/home.js` — Providers card + Class Controls table (sentinel-bounded)
- Modify: `src/channels/playground/public/tabs/models.js` — status pills (sentinel-bounded)
- Modify: `src/index.ts` or a new bootstrap file — call `setStudentCredsHook` at startup (sentinel-bounded)

**Skill files (land on `main` under `.claude/skills/`):**
- Create: `.claude/skills/add-classroom-provider-auth/SKILL.md`

---

## Task 1: OAuth endpoint discovery

**Why first:** Two registry entries (`claude`, `codex`) need real authorize URLs, token URLs, client IDs, and scopes. Spec §Open Questions calls these "TBD pending discovery." Everything else depends on this.

**Files:**
- Create: `docs/providers/oauth-endpoints.md`

- [ ] **Step 1: Inspect `@anthropic-ai/claude-code` for OAuth config**

```bash
find node_modules/@anthropic-ai/claude-code -name "*.js" -o -name "*.json" 2>/dev/null | head -20
grep -rE "oauth/(authorize|token)|claude\.ai/oauth|platform\.claude\.com" node_modules/@anthropic-ai/claude-code/ 2>/dev/null | head -20
grep -rE "9d1c250a|client_id" node_modules/@anthropic-ai/claude-code/ 2>/dev/null | head -10
```

Expected: identify authorize URL (likely `https://claude.ai/oauth/authorize` or `https://console.anthropic.com/oauth/authorize`), token URL (`https://platform.claude.com/v1/oauth/token` is already known from `src/credential-proxy.ts:166-168`), client ID (`9d1c250a-e61b-44d9-88ed-5944d1962f5e` is already known), scopes, redirect URI pattern.

- [ ] **Step 2: Inspect `@openai/codex` for OAuth config**

```bash
find node_modules/@openai/codex -name "*.js" -o -name "*.json" 2>/dev/null | head -20
grep -rE "oauth/(authorize|token)|auth\.openai\.com|api\.openai\.com/oauth" node_modules/@openai/codex/ 2>/dev/null | head -20
grep -rE "client_id|scope" node_modules/@openai/codex/ 2>/dev/null | head -20
```

Expected: codex CLI's authorize URL, token URL, client ID, scopes for Codex API access.

- [ ] **Step 3: Document findings in `docs/providers/oauth-endpoints.md`**

```markdown
# Provider OAuth Endpoints

Source-of-truth for the OAuth client IDs and URLs NanoClaw uses for
each provider. All values rediscovered from vendor CLI npm packages.

## claude (Anthropic)

- Client ID: `9d1c250a-e61b-44d9-88ed-5944d1962f5e` (Claude Code's public CLI client)
- Authorize URL: `<discovered>`
- Token URL: `https://platform.claude.com/v1/oauth/token`
- Scopes: `<discovered>`
- Redirect URI format: `<discovered>` — confirm whether `http://localhost:PORT/callback` is acceptable or only specific schemes
- PKCE: S256 (verified from `src/credential-proxy.ts`)
- Source: `node_modules/@anthropic-ai/claude-code/` <commit/version>

## codex (OpenAI)

- Client ID: `<discovered>`
- Authorize URL: `<discovered>`
- Token URL: `<discovered>`
- Scopes: `<discovered>`
- Redirect URI format: `<discovered>`
- PKCE: `<discovered>`
- Source: `node_modules/@openai/codex/` <commit/version>

## Notes for maintainers

These URLs/IDs are vendor-internal CLI configuration, not publicly documented APIs. Re-verify after major vendor CLI version bumps. If a vendor changes their OAuth product or revokes the client ID, the paste-API-key fallback path remains operational; users will see a 401 from OAuth refresh and the resolver will fall back to that.
```

Fill in the `<discovered>` placeholders before committing this step.

- [ ] **Step 4: Commit the discovery artifact**

```bash
git add docs/providers/oauth-endpoints.md
git commit -m "$(cat <<'EOF'
docs(providers): document OAuth endpoints for claude + codex

Discovered from vendor CLI npm packages. Source of truth for the registry
entries in src/providers/. Re-verify after vendor CLI version bumps.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Provider auth registry — trunk module

**Files:**
- Create: `src/providers/auth-registry.ts`
- Create: `src/providers/auth-registry.test.ts`
- Create: `src/providers/claude-spec.ts`
- Create: `src/providers/codex-spec.ts`

- [ ] **Step 1: Write the failing tests**

`src/providers/auth-registry.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import {
  registerProvider,
  getProviderSpec,
  listProviderSpecs,
  resetRegistryForTests,
} from './auth-registry.js';

beforeEach(() => resetRegistryForTests());

describe('auth-registry', () => {
  it('registers and retrieves a provider spec', () => {
    registerProvider({
      id: 'test-prov',
      displayName: 'Test',
      proxyRoutePrefix: '/test/',
      credentialFileShape: 'mixed',
      apiKey: { placeholder: 'tk-…' },
    });
    expect(getProviderSpec('test-prov')?.displayName).toBe('Test');
  });

  it('returns null for unknown providers', () => {
    expect(getProviderSpec('nope')).toBeNull();
  });

  it('lists all registered specs in registration order', () => {
    registerProvider({ id: 'a', displayName: 'A', proxyRoutePrefix: '/a/', credentialFileShape: 'api-key' });
    registerProvider({ id: 'b', displayName: 'B', proxyRoutePrefix: '/b/', credentialFileShape: 'api-key' });
    expect(listProviderSpecs().map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('replacing a provider with the same id overwrites the previous entry', () => {
    registerProvider({ id: 'dup', displayName: 'First', proxyRoutePrefix: '/dup/', credentialFileShape: 'api-key' });
    registerProvider({ id: 'dup', displayName: 'Second', proxyRoutePrefix: '/dup/', credentialFileShape: 'api-key' });
    expect(getProviderSpec('dup')?.displayName).toBe('Second');
    expect(listProviderSpecs()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/providers/auth-registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `auth-registry.ts`**

`src/providers/auth-registry.ts`:

```ts
/**
 * Provider auth registry. Source of truth for what providers NanoClaw
 * understands auth for: their OAuth config (if any), API-key shape (if
 * any), proxy route prefix, and display name. Pure module — no I/O, no
 * side effects beyond the in-process map. Classroom-skill installation
 * adds nothing here; the registry is generic trunk infrastructure.
 */

export type ProviderAuthSpec = {
  id: string;
  displayName: string;
  proxyRoutePrefix: string; // '/openai/' | '' (anthropic default) | …
  credentialFileShape: 'oauth-token' | 'api-key' | 'mixed';
  oauth?: {
    clientId: string;
    authorizeUrl: string;
    tokenUrl: string;
    /** Vendor-pinned redirect URI — included verbatim in the
     *  authorize-URL request and the token-exchange POST.
     *  We piggyback on vendor CLI OAuth clients whose redirect_uri
     *  cannot be overridden, so the user pastes the code back rather
     *  than NanoClaw receiving a callback. */
    redirectUri: string;
    scopes: string[];
    refreshGrantBody: (refreshToken: string, clientId: string) => string;
    pkce: 'S256';
    /** Token endpoint body format for the auth-code grant. Discovered
     *  empirically (smoke test 2026-05-17): Anthropic requires JSON,
     *  OpenAI accepts standard form-urlencoded. Refresh grant is
     *  separately form-urlencoded for both per refreshGrantBody. */
    authCodeBodyFormat: 'json' | 'form';
    /** Per-provider user-facing walkthrough rendered in the Home
     *  Providers card paste form. The OpenAI/loopback flow needs
     *  different copy than Anthropic's vendor-display flow. */
    connectInstructions: string;
  };
  apiKey?: {
    placeholder: string;
    validatePrefix?: string;
  };
};

const registry = new Map<string, ProviderAuthSpec>();

export function registerProvider(spec: ProviderAuthSpec): void {
  registry.set(spec.id, spec);
}

export function getProviderSpec(id: string): ProviderAuthSpec | null {
  return registry.get(id) ?? null;
}

export function listProviderSpecs(): ProviderAuthSpec[] {
  return [...registry.values()];
}

/** Test-only — clears the registry. Not exported via the barrel. */
export function resetRegistryForTests(): void {
  registry.clear();
}
```

- [ ] **Step 4: Implement provider specs (using discovered values from Task 1)**

`src/providers/claude-spec.ts`:

```ts
import { registerProvider } from './auth-registry.js';

// Values sourced from docs/providers/oauth-endpoints.md (Claude Code v2.1.116).
// Re-verify after major @anthropic-ai/claude-code version bumps.
// Notes from smoke test 2026-05-17:
//   - Anthropic silently drops `org:create_api_key` on grant; omitted here.
//   - Auth-code grant requires JSON body (not form-urlencoded); refresh grant
//     still uses form per refreshGrantBody.
registerProvider({
  id: 'claude',
  displayName: 'Anthropic',
  proxyRoutePrefix: '', // anthropic is the default route in credential-proxy
  credentialFileShape: 'mixed',
  oauth: {
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    authorizeUrl: 'https://claude.com/cai/oauth/authorize',
    tokenUrl: 'https://platform.claude.com/v1/oauth/token',
    redirectUri: 'https://platform.claude.com/oauth/code/callback',
    scopes: [
      'user:profile',
      'user:inference',
      'user:sessions:claude_code',
      'user:mcp_servers',
      'user:file_upload',
    ],
    refreshGrantBody: (refreshToken, clientId) =>
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }).toString(),
    pkce: 'S256',
    authCodeBodyFormat: 'json',
    connectInstructions: [
      '1. Sign in to your Anthropic account in the new tab.',
      '2. Click "Authorize".',
      '3. Anthropic will display an authorization code on the next page.',
      '4. Copy the code (it may be combined with state separated by "#" — paste the whole thing).',
    ].join('\n'),
  },
  apiKey: {
    placeholder: 'sk-ant-api03-…',
    validatePrefix: 'sk-ant-',
  },
});
```

`src/providers/codex-spec.ts`:

```ts
import { registerProvider } from './auth-registry.js';

// Values sourced from docs/providers/oauth-endpoints.md (Codex v0.124.0).
// Re-verify after major @openai/codex version bumps.
// Note: codex CLI's redirectUri is `http://localhost:<ephemeral>/auth/callback`
// — a loopback listener that only works for the CLI's own desktop flow.
// For NanoClaw's web-driven paste-back flow we use the localhost form below;
// OpenAI's OAuth server accepts any loopback URI for this client. The actual
// loopback port doesn't matter — the user never lands on it (paste-back).
registerProvider({
  id: 'codex',
  displayName: 'OpenAI',
  proxyRoutePrefix: '/openai/',
  credentialFileShape: 'mixed',
  oauth: {
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    redirectUri: 'http://localhost:1455/auth/callback',
    scopes: [
      'openid',
      'profile',
      'email',
      'offline_access',
      'api.connectors.read',
      'api.connectors.invoke',
    ],
    refreshGrantBody: (refreshToken, clientId) =>
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }).toString(),
    pkce: 'S256',
    authCodeBodyFormat: 'form',
    connectInstructions: [
      '1. Sign in to your OpenAI account in the new tab.',
      '2. Click "Authorize".',
      '3. Your browser will try to load "localhost:1455" and FAIL — this is expected.',
      '4. Look at the URL bar. It will show:',
      '   http://localhost:1455/auth/callback?code=ac_...&state=...',
      '5. Copy the entire URL (or just the value of the "code" parameter) and paste below.',
    ].join('\n'),
  },
  apiKey: {
    placeholder: 'sk-…',
    validatePrefix: 'sk-',
  },
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run src/providers/auth-registry.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 6: Build cleanly**

Run: `pnpm run build`
Expected: clean exit, no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add src/providers/auth-registry.ts src/providers/auth-registry.test.ts src/providers/claude-spec.ts src/providers/codex-spec.ts
git commit -m "$(cat <<'EOF'
feat(providers): provider auth registry trunk module

Generic registration API for OAuth + API-key provider metadata.
Trunk-side infrastructure used by both the credential proxy hook
(this commit) and the classroom-skill resolver (later).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Credential proxy hook + sentinel serialization — trunk extension

**Files:**
- Modify: `src/credential-proxy.ts` — add hook + ResolvedCreds type + 402/403 serialization
- Modify: `src/credential-proxy.test.ts` — hook tests

- [ ] **Step 1: Write the failing tests**

Append to `src/credential-proxy.test.ts`:

```ts
import { setStudentCredsHook, studentCredsHook } from './credential-proxy.js';

describe('studentCredsHook', () => {
  afterEach(() => {
    setStudentCredsHook(async () => null);
  });

  it('default hook returns null (no-op for solo installs)', async () => {
    const result = await studentCredsHook('any-gid', 'claude');
    expect(result).toBeNull();
  });

  it('setStudentCredsHook installs a new hook globally', async () => {
    setStudentCredsHook(async (gid, provider) => ({
      kind: 'apiKey',
      value: `key-for-${gid}-${provider}`,
    }));
    const result = await studentCredsHook('g1', 'claude');
    expect(result).toEqual({ kind: 'apiKey', value: 'key-for-g1-claude' });
  });

  it('serializes connect_required sentinel to HTTP 402', async () => {
    setStudentCredsHook(async () => ({
      kind: 'connect_required',
      provider: 'claude',
      message: 'Connect your Anthropic account to use this model.',
      connect_url: '/provider-auth/claude/start',
    }));

    // Use the proxy's serialization helper directly
    const { serializeResolvedCredsError } = await import('./credential-proxy.js');
    const sentinel = await studentCredsHook('g1', 'claude');
    const { status, body } = serializeResolvedCredsError(sentinel!);
    expect(status).toBe(402);
    expect(body).toEqual({
      type: 'connect_required',
      provider: 'claude',
      message: 'Connect your Anthropic account to use this model.',
      connect_url: '/provider-auth/claude/start',
    });
  });

  it('serializes forbidden sentinel to HTTP 403', async () => {
    const { serializeResolvedCredsError } = await import('./credential-proxy.js');
    const { status, body } = serializeResolvedCredsError({
      kind: 'forbidden',
      provider: 'claude',
    });
    expect(status).toBe(403);
    expect(body).toEqual({ type: 'forbidden', provider: 'claude' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/credential-proxy.test.ts`
Expected: FAIL — `setStudentCredsHook`, `studentCredsHook`, `serializeResolvedCredsError` not exported.

- [ ] **Step 3: Add hook + types to `src/credential-proxy.ts`**

Find the end of the imports block in `src/credential-proxy.ts` (after `import { log } from './log.js';`). Add:

```ts
/**
 * Per-request credential resolution outcome returned by the
 * studentCredsHook. The trunk proxy understands four shapes:
 *   - apiKey / oauth: real creds; proxy injects them
 *   - connect_required: 402 envelope (classroom-skill policy)
 *   - forbidden:       403 envelope (classroom-skill policy)
 *   - null:            no per-student creds; proxy falls through to
 *                      the existing .env / file / keychain chain
 */
export type ResolvedCreds =
  | { kind: 'apiKey'; value: string }
  | { kind: 'oauth'; accessToken: string }
  | { kind: 'connect_required'; provider: string; message: string; connect_url: string }
  | { kind: 'forbidden'; provider: string }
  | null;

export type StudentCredsHook = (
  agentGroupId: string,
  providerId: string,
) => Promise<ResolvedCreds>;

/**
 * Trunk default — no-op. Solo installs see this and the proxy falls
 * through to existing .env / file / keychain resolution. The classroom
 * skill calls setStudentCredsHook() at startup to install its real
 * resolver.
 */
export let studentCredsHook: StudentCredsHook = async () => null;

export function setStudentCredsHook(fn: StudentCredsHook): void {
  studentCredsHook = fn;
}

export function serializeResolvedCredsError(
  result: Extract<ResolvedCreds, { kind: 'connect_required' | 'forbidden' }>,
): { status: number; body: Record<string, unknown> } {
  if (result.kind === 'connect_required') {
    return {
      status: 402,
      body: {
        type: 'connect_required',
        provider: result.provider,
        message: result.message,
        connect_url: result.connect_url,
      },
    };
  }
  return {
    status: 403,
    body: { type: 'forbidden', provider: result.provider },
  };
}
```

**Note:** the per-request invocation of the hook (i.e. the proxy actually CALLING `studentCredsHook` in its request handler) is not wired in this task — we add the call-site in Task 17 once the classroom-side hook is ready and integration-testable. Wiring it now would route every solo-install request through a no-op hook, which is harmless but adds latency and a code path to maintain before the consumer exists.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/credential-proxy.test.ts`
Expected: PASS — 4 new tests plus the existing proxy tests.

- [ ] **Step 5: Build cleanly**

Run: `pnpm run build`
Expected: clean exit, no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/credential-proxy.ts src/credential-proxy.test.ts
git commit -m "$(cat <<'EOF'
feat(credential-proxy): studentCredsHook extension point + sentinel serialization

Adds a no-op hook (overridden at runtime by the classroom skill) and
helpers to serialize connect_required / forbidden sentinels into 402 /
403 HTTP envelopes. Per-request invocation is wired in a later commit
once the consumer (classroom resolver) exists.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Worktree setup — new long-lived branch off main

**Files:** none (environment setup).

**Why a new branch (not the legacy `origin/classroom`):** that long-lived branch is 606 commits behind main with significant overlap in the same files. A merge produces 9+ conflicts that aren't in X.7's scope to reconcile. Solution: branch off current main with a fresh name (`classroom-x7-provider-auth`). The skill (Task 15) fetches from this branch, same install pattern as `add-gws-tool` uses for `origin/gws-mcp`.

- [x] **Step 1: Create a worktree on a new branch off main**

```bash
git worktree add /Users/admin/projects/nanoclaw-classroom-x7 -b classroom-x7-provider-auth main
cd /Users/admin/projects/nanoclaw-classroom-x7
pnpm install --frozen-lockfile
```

Expected: worktree at `/Users/admin/projects/nanoclaw-classroom-x7`, branch `classroom-x7-provider-auth` rooted at the current main HEAD (which already has the registry + hook from Tasks 2-3).

- [x] **Step 2: Copy gitignored install-local files into the worktree**

The host install has admin-handlers and model-providers files installed via `/add-admintools` that are gitignored. The worktree doesn't have them, which breaks the build. Copy them in (one-time setup; they stay gitignored and never enter the branch):

```bash
cp src/admin-handlers/{auth,model,provider}.ts /Users/admin/projects/nanoclaw-classroom-x7/src/admin-handlers/
cp src/{auth-switch,model-discovery,model-discovery.test,model-switch,provider-switch.test}.ts /Users/admin/projects/nanoclaw-classroom-x7/src/
cp src/model-providers/{anthropic,anthropic.test,openai,openai.test,types}.ts /Users/admin/projects/nanoclaw-classroom-x7/src/model-providers/
```

- [x] **Step 3: Verify build + targeted tests**

```bash
cd /Users/admin/projects/nanoclaw-classroom-x7
pnpm run build
pnpm exec vitest run src/providers/auth-registry.test.ts src/credential-proxy.test.ts
```

Expected: build clean, 16/16 tests pass (4 registry + 12 proxy). Full `pnpm test` has 12 pre-existing failures unrelated to X.7 — match main, ignorable.

No commit at this step. The worktree directory is the dev environment for Tasks 5-14.

---

## Task 5: Student credential storage — classroom branch

**Files (in `../nanoclaw-classroom-x7` worktree):**
- Create: `src/student-provider-auth.ts`
- Create: `src/student-provider-auth.test.ts`

Mirrors `src/student-google-auth.ts:1-83`, with three additions: (a) the `active` field, (b) `addApiKey`/`addOAuth` helpers that auto-set `active` when the file is fresh and auto-flip when one method is cleared, (c) a `clearMethod` that removes the file entirely when both methods are gone.

- [ ] **Step 1: Write the failing tests**

`src/student-provider-auth.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  addApiKey,
  addOAuth,
  clearMethod,
  hasStudentProviderCreds,
  loadStudentProviderCreds,
  setActiveMethod,
} from './student-provider-auth.js';

let tmpRoot: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-test-'));
  process.chdir(tmpRoot);
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('student-provider-auth', () => {
  it('addApiKey on empty store sets active=apiKey', () => {
    addApiKey('alice@x.edu', 'claude', 'sk-ant-test');
    const creds = loadStudentProviderCreds('alice@x.edu', 'claude');
    expect(creds?.active).toBe('apiKey');
    expect(creds?.apiKey?.value).toBe('sk-ant-test');
    expect(creds?.oauth).toBeUndefined();
  });

  it('addOAuth on empty store sets active=oauth', () => {
    addOAuth('alice@x.edu', 'claude', {
      accessToken: 'at', refreshToken: 'rt', expiresAt: 999, account: 'alice',
    });
    const creds = loadStudentProviderCreds('alice@x.edu', 'claude');
    expect(creds?.active).toBe('oauth');
    expect(creds?.oauth?.accessToken).toBe('at');
  });

  it('adding the second method leaves active unchanged', () => {
    addApiKey('alice@x.edu', 'claude', 'sk-1');
    addOAuth('alice@x.edu', 'claude', {
      accessToken: 'at', refreshToken: 'rt', expiresAt: 999,
    });
    expect(loadStudentProviderCreds('alice@x.edu', 'claude')?.active).toBe('apiKey');
  });

  it('setActiveMethod switches active when both methods present', () => {
    addApiKey('alice@x.edu', 'claude', 'sk-1');
    addOAuth('alice@x.edu', 'claude', { accessToken: 'at', refreshToken: 'rt', expiresAt: 999 });
    setActiveMethod('alice@x.edu', 'claude', 'oauth');
    expect(loadStudentProviderCreds('alice@x.edu', 'claude')?.active).toBe('oauth');
  });

  it('clearMethod removes only the named method and flips active', () => {
    addApiKey('alice@x.edu', 'claude', 'sk-1');
    addOAuth('alice@x.edu', 'claude', { accessToken: 'at', refreshToken: 'rt', expiresAt: 999 });
    setActiveMethod('alice@x.edu', 'claude', 'oauth');
    clearMethod('alice@x.edu', 'claude', 'oauth');
    const creds = loadStudentProviderCreds('alice@x.edu', 'claude');
    expect(creds?.oauth).toBeUndefined();
    expect(creds?.active).toBe('apiKey');
  });

  it('clearMethod with no remaining method removes the file', () => {
    addApiKey('alice@x.edu', 'claude', 'sk-1');
    clearMethod('alice@x.edu', 'claude', 'apiKey');
    expect(loadStudentProviderCreds('alice@x.edu', 'claude')).toBeNull();
    expect(hasStudentProviderCreds('alice@x.edu', 'claude')).toBe(false);
  });

  it('hasStudentProviderCreds returns false for never-written user', () => {
    expect(hasStudentProviderCreds('nobody@x.edu', 'claude')).toBe(false);
  });

  it('sanitizes user_id for filesystem (slashes, colons, dots)', () => {
    addApiKey('playground:alice@x.edu', 'claude', 'sk-1');
    const sanitized = 'playground_alice_at_x.edu'; // implementation-defined
    const expectedPath = path.join(tmpRoot, 'data', 'student-provider-creds', sanitized, 'claude.json');
    expect(fs.existsSync(expectedPath)).toBe(true);
  });

  it('file is created with mode 0600 and dir with mode 0700', () => {
    addApiKey('alice', 'claude', 'sk-1');
    const dir = path.join(tmpRoot, 'data', 'student-provider-creds', 'alice');
    const file = path.join(dir, 'claude.json');
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/student-provider-auth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/student-provider-auth.ts`**

```ts
/**
 * Per-student LLM provider credential storage. Mirrors
 * student-google-auth.ts (Phase 14) with three additions:
 *   - `active` field designates which auth method the proxy uses
 *   - addApiKey/addOAuth auto-set active when adding to empty store
 *   - clearMethod removes the file entirely when both methods are gone
 *
 * Path: data/student-provider-creds/<sanitized_user_id>/<providerId>.json
 * File mode 0o600, dir mode 0o700 (chmod after mkdir for existing-dir case).
 */
import fs from 'fs';
import path from 'path';

const ROOT_DIR_NAME = 'data/student-provider-creds';

type ApiKeyCreds = { value: string; addedAt: number };
type OAuthCreds = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  account?: string;
  addedAt: number;
};

export type StudentProviderCreds = {
  apiKey?: ApiKeyCreds;
  oauth?: OAuthCreds;
  active: 'apiKey' | 'oauth';
};

function sanitizeUserId(userId: string): string {
  return userId.replace(/[/\\]/g, '_').replace(/:/g, '_').replace(/@/g, '_at_');
}

function credsRoot(): string {
  return path.join(process.cwd(), ROOT_DIR_NAME);
}

function credsDir(userId: string): string {
  return path.join(credsRoot(), sanitizeUserId(userId));
}

function credsFile(userId: string, providerId: string): string {
  return path.join(credsDir(userId), `${providerId}.json`);
}

function ensureDir(userId: string): string {
  const dir = credsDir(userId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync mode only applies on create; enforce on existing dirs
  fs.chmodSync(dir, 0o700);
  return dir;
}

function writeAtomic(file: string, data: object): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function loadStudentProviderCreds(
  userId: string,
  providerId: string,
): StudentProviderCreds | null {
  try {
    const raw = fs.readFileSync(credsFile(userId, providerId), 'utf-8');
    return JSON.parse(raw) as StudentProviderCreds;
  } catch {
    return null;
  }
}

export function hasStudentProviderCreds(userId: string, providerId: string): boolean {
  return loadStudentProviderCreds(userId, providerId) !== null;
}

export function addApiKey(userId: string, providerId: string, apiKey: string): void {
  ensureDir(userId);
  const existing = loadStudentProviderCreds(userId, providerId);
  const next: StudentProviderCreds = existing
    ? { ...existing, apiKey: { value: apiKey, addedAt: Date.now() } }
    : { apiKey: { value: apiKey, addedAt: Date.now() }, active: 'apiKey' };
  writeAtomic(credsFile(userId, providerId), next);
}

export function addOAuth(
  userId: string,
  providerId: string,
  tokens: { accessToken: string; refreshToken: string; expiresAt: number; account?: string },
): void {
  ensureDir(userId);
  const existing = loadStudentProviderCreds(userId, providerId);
  const oauthEntry: OAuthCreds = { ...tokens, addedAt: Date.now() };
  const next: StudentProviderCreds = existing
    ? { ...existing, oauth: oauthEntry }
    : { oauth: oauthEntry, active: 'oauth' };
  writeAtomic(credsFile(userId, providerId), next);
}

export function setActiveMethod(
  userId: string,
  providerId: string,
  active: 'apiKey' | 'oauth',
): void {
  const existing = loadStudentProviderCreds(userId, providerId);
  if (!existing) throw new Error(`no creds for ${userId}/${providerId}`);
  if (active === 'apiKey' && !existing.apiKey) throw new Error('cannot activate apiKey: not set');
  if (active === 'oauth' && !existing.oauth) throw new Error('cannot activate oauth: not set');
  writeAtomic(credsFile(userId, providerId), { ...existing, active });
}

export function clearMethod(
  userId: string,
  providerId: string,
  which: 'apiKey' | 'oauth',
): void {
  const existing = loadStudentProviderCreds(userId, providerId);
  if (!existing) return;
  const remaining: StudentProviderCreds = { ...existing };
  delete remaining[which];
  // If both gone, remove the file entirely
  if (!remaining.apiKey && !remaining.oauth) {
    try {
      fs.unlinkSync(credsFile(userId, providerId));
    } catch { /* ignore */ }
    return;
  }
  // Otherwise, auto-flip active to the remaining method if we cleared the active one
  if (remaining.active === which) {
    remaining.active = which === 'apiKey' ? 'oauth' : 'apiKey';
  }
  writeAtomic(credsFile(userId, providerId), remaining);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/student-provider-auth.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Build cleanly**

Run: `pnpm run build`
Expected: clean exit.

- [ ] **Step 6: Commit on the classroom feature branch**

```bash
git add src/student-provider-auth.ts src/student-provider-auth.test.ts
git commit -m "$(cat <<'EOF'
feat(classroom): student-provider-auth storage with active-method toggle

Mirror of student-google-auth.ts with three additions: explicit active
field, add/clear helpers that auto-manage the field, and file-removal
when both methods cleared. Tested with 9 unit tests covering the
active-flip semantics.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Class Controls schema migration — classroom branch

**Files:**
- Modify: `src/channels/playground/api/class-controls.ts`
- Modify: `src/channels/playground/api/class-controls.test.ts`

The current flat shape (`tabsVisibleToStudents`, `providersAvailable`, `authModesAvailable`) is replaced with a wrapped+per-provider shape. Backwards-compat load wraps old shape on first read.

- [ ] **Step 1: Write the failing tests**

Replace the contents of `src/channels/playground/api/class-controls.test.ts` (or extend if it exists) with:

```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpRoot: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-'));
  process.chdir(tmpRoot);
  fs.mkdirSync(path.join(tmpRoot, 'config'), { recursive: true });
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('class-controls — new wrapped shape', () => {
  it('returns sensible defaults when no file exists', async () => {
    const { readClassControls, DEFAULT_CLASS_ID } = await import('./class-controls.js');
    const cc = readClassControls();
    expect(cc.classes[DEFAULT_CLASS_ID].providers.codex).toEqual({
      allow: true, provideDefault: true, allowByo: true,
    });
    expect(cc.classes[DEFAULT_CLASS_ID].providers.claude).toEqual({
      allow: true, provideDefault: false, allowByo: true,
    });
    expect(cc.classes[DEFAULT_CLASS_ID].providers.local).toEqual({
      allow: true, provideDefault: true, allowByo: false,
    });
  });

  it('migrates an existing flat-shape file on read', async () => {
    fs.writeFileSync(
      path.join(tmpRoot, 'config', 'class-controls.json'),
      JSON.stringify({
        tabsVisibleToStudents: ['home', 'chat'],
        providersAvailable: ['claude', 'codex'],
        authModesAvailable: ['api-key'],
      }),
    );
    const { readClassControls, DEFAULT_CLASS_ID } = await import('./class-controls.js');
    const cc = readClassControls();
    expect(cc.classes[DEFAULT_CLASS_ID].tabsVisibleToStudents).toEqual(['home', 'chat']);
    expect(cc.classes[DEFAULT_CLASS_ID].providers.claude.allow).toBe(true);
    expect(cc.classes[DEFAULT_CLASS_ID].providers.codex.allow).toBe(true);
    // 'local' was not in the old array → allow=false in migration
    expect(cc.classes[DEFAULT_CLASS_ID].providers.local?.allow).toBe(false);
  });

  it('round-trips through write+read', async () => {
    const { readClassControls, writeClassControls, DEFAULT_CLASS_ID } = await import(
      './class-controls.js'
    );
    const before = readClassControls();
    before.classes[DEFAULT_CLASS_ID].providers.claude.provideDefault = true;
    writeClassControls(before);
    const after = readClassControls();
    expect(after.classes[DEFAULT_CLASS_ID].providers.claude.provideDefault).toBe(true);
  });

  it('handlePutClassControls rejects writes to non-default class IDs in v1', async () => {
    const { handlePutClassControls } = await import('./class-controls.js');
    const result = handlePutClassControls({
      classes: { 'fake-class': { tabsVisibleToStudents: [], authModesAvailable: [], providers: {} } },
    } as never);
    expect(result.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/channels/playground/api/class-controls.test.ts`
Expected: FAIL — `DEFAULT_CLASS_ID`, `writeClassControls`, new shape not exported.

- [ ] **Step 3: Modify `src/channels/playground/api/class-controls.ts`**

Replace the entire file with:

```ts
/**
 * Class-controls config — instructor-curated gates for what students see.
 *
 * v2 shape (wrapped by class for future multi-class):
 *   { classes: { "default": { tabsVisibleToStudents, authModesAvailable,
 *                              providers: { [providerId]: { allow,
 *                                provideDefault, allowByo } } } } }
 *
 * Backwards-compat: if existing file uses the flat v1 shape, hydrate
 * into the v2 shape on read with defaults for any missing fields.
 *
 * v1 was: { tabsVisibleToStudents, providersAvailable[], authModesAvailable }
 */
import fs from 'fs';
import path from 'path';

import { PROJECT_ROOT } from '../../../config.js';
import type { ApiResult } from './me.js';

const CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'class-controls.json');

export type TabId = 'home' | 'chat' | 'persona' | 'skills' | 'models';
export type ProviderId = string; // registry-defined; loose-typed here
export type AuthModeId = 'api-key' | 'oauth' | 'claude-code-oauth';

export const DEFAULT_CLASS_ID = 'default';

export interface ProviderPolicy {
  allow: boolean;
  provideDefault: boolean;
  allowByo: boolean;
}

export interface ClassControl {
  tabsVisibleToStudents: TabId[];
  authModesAvailable: AuthModeId[];
  providers: Record<ProviderId, ProviderPolicy>;
}

export interface ClassControls {
  classes: Record<string, ClassControl>;
}

const DEFAULT_CLASS_CONTROL: ClassControl = {
  tabsVisibleToStudents: ['home', 'chat', 'persona', 'skills', 'models'],
  authModesAvailable: ['api-key', 'oauth', 'claude-code-oauth'],
  providers: {
    codex:  { allow: true, provideDefault: true,  allowByo: true  },
    claude: { allow: true, provideDefault: false, allowByo: true  },
    local:  { allow: true, provideDefault: true,  allowByo: false },
  },
};

function defaultsRoot(): ClassControls {
  return { classes: { [DEFAULT_CLASS_ID]: structuredClone(DEFAULT_CLASS_CONTROL) } };
}

function isV1Flat(parsed: unknown): parsed is {
  tabsVisibleToStudents?: TabId[];
  providersAvailable?: string[];
  authModesAvailable?: AuthModeId[];
} {
  if (!parsed || typeof parsed !== 'object') return false;
  return (
    'providersAvailable' in parsed ||
    ('tabsVisibleToStudents' in parsed && !('classes' in parsed))
  );
}

function migrateV1(v1: {
  tabsVisibleToStudents?: TabId[];
  providersAvailable?: string[];
  authModesAvailable?: AuthModeId[];
}): ClassControls {
  const knownProviders = ['codex', 'claude', 'local'];
  const providers: Record<string, ProviderPolicy> = {};
  for (const p of knownProviders) {
    const inOld = v1.providersAvailable?.includes(p) ?? false;
    providers[p] = inOld
      ? structuredClone(DEFAULT_CLASS_CONTROL.providers[p])
      : { allow: false, provideDefault: false, allowByo: false };
  }
  return {
    classes: {
      [DEFAULT_CLASS_ID]: {
        tabsVisibleToStudents: v1.tabsVisibleToStudents ?? DEFAULT_CLASS_CONTROL.tabsVisibleToStudents,
        authModesAvailable: v1.authModesAvailable ?? DEFAULT_CLASS_CONTROL.authModesAvailable,
        providers,
      },
    },
  };
}

export function readClassControls(): ClassControls {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return defaultsRoot();
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    if (isV1Flat(parsed)) return migrateV1(parsed);
    if (!parsed.classes || typeof parsed.classes !== 'object') return defaultsRoot();
    // Ensure default class always exists
    if (!parsed.classes[DEFAULT_CLASS_ID]) {
      parsed.classes[DEFAULT_CLASS_ID] = structuredClone(DEFAULT_CLASS_CONTROL);
    }
    return parsed as ClassControls;
  } catch {
    return defaultsRoot();
  }
}

export function writeClassControls(cc: ClassControls): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cc, null, 2) + '\n');
}

export function handleGetClassControls(): ApiResult<ClassControls> {
  return { status: 200, body: readClassControls() };
}

export function handlePutClassControls(body: Partial<ClassControls>): ApiResult<ClassControls> {
  if (!body.classes || typeof body.classes !== 'object') {
    return { status: 400, body: { error: 'classes object required' } };
  }
  const keys = Object.keys(body.classes);
  if (keys.length !== 1 || keys[0] !== DEFAULT_CLASS_ID) {
    return { status: 400, body: { error: `v1 supports only classId="${DEFAULT_CLASS_ID}"` } };
  }
  const next: ClassControls = { classes: { [DEFAULT_CLASS_ID]: body.classes[DEFAULT_CLASS_ID] as ClassControl } };
  try {
    writeClassControls(next);
    return { status: 200, body: next };
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/channels/playground/api/class-controls.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Run the full test suite to catch regressions**

Run: `pnpm test`
Expected: PASS. Watch for any home.js / models.js or app.js call sites that read the old flat shape and now break. Fix them by switching to `cc.classes[DEFAULT_CLASS_ID].providers` access — those patches land in Tasks 9-11; for now, fix any tests that break by updating their fixtures to the new shape.

- [ ] **Step 6: Build cleanly**

Run: `pnpm run build`
Expected: clean exit.

- [ ] **Step 7: Commit**

```bash
git add src/channels/playground/api/class-controls.ts src/channels/playground/api/class-controls.test.ts
git commit -m "$(cat <<'EOF'
feat(classroom): class-controls wrapped+per-provider shape

Old flat shape auto-migrates on first read. Per-provider toggles
(allow/provideDefault/allowByo) replace the providersAvailable array.
DEFAULT_CLASS_ID seam threads class identity through every call site
for future multi-class.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Classroom provider resolver — implements the trunk hook

**Files:**
- Create: `src/classroom-provider-resolver.ts`
- Create: `src/classroom-provider-resolver.test.ts`

Implements the trunk `studentCredsHook`. Resolves `(agentGroupId) → (userId, classId='default')` via `classroom_roster`, loads creds, checks active method, refreshes OAuth if expired, falls back per Class Controls policy.

- [ ] **Step 1: Write the failing tests**

`src/classroom-provider-resolver.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpRoot: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-test-'));
  process.chdir(tmpRoot);
  fs.mkdirSync(path.join(tmpRoot, 'config'), { recursive: true });
  vi.resetModules();
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.resetModules();
});

async function setRoster(rows: { agentGroupId: string; userId: string }[]) {
  // Test seam: resolver uses an injectable lookup. Set it before each test.
  const { setRosterLookupForTests } = await import('./classroom-provider-resolver.js');
  setRosterLookupForTests((gid: string) => {
    const row = rows.find((r) => r.agentGroupId === gid);
    return row ? { userId: row.userId, classId: 'default' } : null;
  });
}

describe('classroom-provider-resolver', () => {
  it('returns student apiKey when active=apiKey', async () => {
    const { addApiKey } = await import('./student-provider-auth.js');
    const { resolveStudentCreds } = await import('./classroom-provider-resolver.js');
    await setRoster([{ agentGroupId: 'g1', userId: 'alice@x.edu' }]);
    addApiKey('alice@x.edu', 'claude', 'sk-test');
    const r = await resolveStudentCreds('g1', 'claude');
    expect(r).toEqual({ kind: 'apiKey', value: 'sk-test' });
  });

  it('returns oauth accessToken when active=oauth and not expired', async () => {
    const { addOAuth } = await import('./student-provider-auth.js');
    const { resolveStudentCreds } = await import('./classroom-provider-resolver.js');
    await setRoster([{ agentGroupId: 'g1', userId: 'alice@x.edu' }]);
    addOAuth('alice@x.edu', 'claude', {
      accessToken: 'fresh', refreshToken: 'rt', expiresAt: Date.now() + 3600000,
    });
    const r = await resolveStudentCreds('g1', 'claude');
    expect(r).toEqual({ kind: 'oauth', accessToken: 'fresh' });
  });

  it('refreshes oauth when expiry is within 5min', async () => {
    const { addOAuth } = await import('./student-provider-auth.js');
    const { resolveStudentCreds, setOAuthRefresherForTests } = await import(
      './classroom-provider-resolver.js'
    );
    await setRoster([{ agentGroupId: 'g1', userId: 'alice@x.edu' }]);
    addOAuth('alice@x.edu', 'claude', {
      accessToken: 'stale', refreshToken: 'rt', expiresAt: Date.now() + 60000,
    });
    setOAuthRefresherForTests(async () => ({
      accessToken: 'refreshed', refreshToken: 'rt2', expiresAt: Date.now() + 3600000,
    }));
    const r = await resolveStudentCreds('g1', 'claude');
    expect(r).toEqual({ kind: 'oauth', accessToken: 'refreshed' });
  });

  it('falls back to host .env when provideDefault=true and no creds', async () => {
    const { resolveStudentCreds } = await import('./classroom-provider-resolver.js');
    await setRoster([{ agentGroupId: 'g1', userId: 'alice@x.edu' }]);
    fs.writeFileSync(
      path.join(tmpRoot, 'config', 'class-controls.json'),
      JSON.stringify({ classes: { default: {
        tabsVisibleToStudents: [], authModesAvailable: [],
        providers: { claude: { allow: true, provideDefault: true, allowByo: true } },
      } } }),
    );
    // host .env stub
    const { setClassPoolCredsForTests } = await import('./classroom-provider-resolver.js');
    setClassPoolCredsForTests((classId, provider) => ({ kind: 'apiKey', value: `pool-${classId}-${provider}` }));
    const r = await resolveStudentCreds('g1', 'claude');
    expect(r).toEqual({ kind: 'apiKey', value: 'pool-default-claude' });
  });

  it('returns connect_required when no creds and provideDefault=false', async () => {
    const { resolveStudentCreds } = await import('./classroom-provider-resolver.js');
    await setRoster([{ agentGroupId: 'g1', userId: 'alice@x.edu' }]);
    fs.writeFileSync(
      path.join(tmpRoot, 'config', 'class-controls.json'),
      JSON.stringify({ classes: { default: {
        tabsVisibleToStudents: [], authModesAvailable: [],
        providers: { claude: { allow: true, provideDefault: false, allowByo: true } },
      } } }),
    );
    const r = await resolveStudentCreds('g1', 'claude');
    expect(r?.kind).toBe('connect_required');
    expect((r as { provider: string }).provider).toBe('claude');
  });

  it('returns forbidden when allow=false', async () => {
    const { resolveStudentCreds } = await import('./classroom-provider-resolver.js');
    await setRoster([{ agentGroupId: 'g1', userId: 'alice@x.edu' }]);
    fs.writeFileSync(
      path.join(tmpRoot, 'config', 'class-controls.json'),
      JSON.stringify({ classes: { default: {
        tabsVisibleToStudents: [], authModesAvailable: [],
        providers: { claude: { allow: false, provideDefault: false, allowByo: false } },
      } } }),
    );
    const r = await resolveStudentCreds('g1', 'claude');
    expect(r?.kind).toBe('forbidden');
  });

  it('returns null when agentGroupId is not in roster (solo install path)', async () => {
    const { resolveStudentCreds } = await import('./classroom-provider-resolver.js');
    await setRoster([]);
    const r = await resolveStudentCreds('unknown-gid', 'claude');
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/classroom-provider-resolver.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/classroom-provider-resolver.ts`**

```ts
/**
 * Classroom-side per-student credential resolver. Installed as the
 * trunk studentCredsHook by the classroom skill at startup.
 *
 * Resolution priority (per request):
 *   1. classroom_roster lookup: agentGroupId → (userId, classId)
 *      If no row → null (solo-install path; trunk falls back to .env)
 *   2. loadStudentProviderCreds(userId, providerId)
 *      If present: branch on creds.active. Refresh OAuth if expiry near.
 *   3. Class Controls policy for classId.providers[providerId]:
 *      provideDefault=true  → host .env (via getClassPoolCredsForProvider)
 *      provideDefault=false, allowByo=true → connect_required sentinel
 *      allow=false → forbidden sentinel
 */
import type { ResolvedCreds } from './credential-proxy.js';
import { loadStudentProviderCreds, addOAuth } from './student-provider-auth.js';
import { DEFAULT_CLASS_ID, readClassControls } from './channels/playground/api/class-controls.js';
import { lookupRosterByAgentGroupId } from './db/classroom-roster.js';

// Test seam: roster lookup is injectable for unit tests.
let rosterLookup: (gid: string) => { userId: string; classId: string } | null =
  (gid) => {
    const row = lookupRosterByAgentGroupId(gid);
    return row ? { userId: row.userId, classId: DEFAULT_CLASS_ID } : null;
  };

export function setRosterLookupForTests(fn: typeof rosterLookup): void {
  rosterLookup = fn;
}

// Test seam: oauth refresher is injectable.
// Default implementation: POST refresh_token grant to spec.oauth.tokenUrl
// using spec.oauth.refreshGrantBody. Mirrors the existing dance in
// src/credential-proxy.ts's refreshAnthropicOAuthToken.
import { request as httpsRequest } from 'https';
import { getProviderSpec } from './providers/auth-registry.js';

let oauthRefresher: (
  refreshToken: string,
  providerId: string,
) => Promise<{ accessToken: string; refreshToken: string; expiresAt: number } | null> =
  async (refreshToken, providerId) => {
    const spec = getProviderSpec(providerId);
    if (!spec?.oauth) return null;
    const body = spec.oauth.refreshGrantBody(refreshToken, spec.oauth.clientId);
    const url = new URL(spec.oauth.tokenUrl);
    return new Promise((resolve) => {
      const req = httpsRequest(
        {
          hostname: url.hostname, port: url.port || 443, path: url.pathname, method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c as Buffer));
          res.on('end', () => {
            if (res.statusCode !== 200) return resolve(null);
            try {
              const json = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
              resolve({
                accessToken: json.access_token,
                refreshToken: json.refresh_token ?? refreshToken,
                expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
              });
            } catch { resolve(null); }
          });
        },
      );
      req.on('error', () => resolve(null));
      req.write(body);
      req.end();
    });
  };

export function setOAuthRefresherForTests(fn: typeof oauthRefresher): void {
  oauthRefresher = fn;
}

// Test seam: class-pool creds reader is injectable.
let classPoolCreds: (classId: string, providerId: string) => ResolvedCreds = () => null;

export function setClassPoolCredsForTests(fn: typeof classPoolCreds): void {
  classPoolCreds = fn;
}

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export async function resolveStudentCreds(
  agentGroupId: string,
  providerId: string,
): Promise<ResolvedCreds> {
  const ident = rosterLookup(agentGroupId);
  if (!ident) return null; // solo-install path; trunk falls back to .env

  const creds = loadStudentProviderCreds(ident.userId, providerId);
  if (creds) {
    if (creds.active === 'apiKey' && creds.apiKey) {
      return { kind: 'apiKey', value: creds.apiKey.value };
    }
    if (creds.active === 'oauth' && creds.oauth) {
      const needsRefresh = creds.oauth.expiresAt - Date.now() < REFRESH_BUFFER_MS;
      if (needsRefresh) {
        const refreshed = await oauthRefresher(creds.oauth.refreshToken, providerId);
        if (refreshed) {
          addOAuth(ident.userId, providerId, { ...refreshed, account: creds.oauth.account });
          return { kind: 'oauth', accessToken: refreshed.accessToken };
        }
        // Refresh failed — fall through to policy check
      } else {
        return { kind: 'oauth', accessToken: creds.oauth.accessToken };
      }
    }
  }

  const controls = readClassControls();
  const policy = controls.classes[ident.classId]?.providers[providerId];
  if (!policy || policy.allow === false) {
    return { kind: 'forbidden', provider: providerId };
  }
  if (policy.provideDefault) {
    return classPoolCreds(ident.classId, providerId);
  }
  return {
    kind: 'connect_required',
    provider: providerId,
    message: `Connect your ${providerId} account to use this model.`,
    connect_url: `/provider-auth/${providerId}/start`,
  };
}
```

- [ ] **Step 4: Add the trivial `lookupRosterByAgentGroupId` helper if not present**

```bash
grep -n "lookupRosterByAgentGroupId" src/db/classroom-roster.ts
```

If absent, append to `src/db/classroom-roster.ts`:

```ts
export function lookupRosterByAgentGroupId(agentGroupId: string): { userId: string } | null {
  const row = db
    .prepare(`SELECT user_id AS userId FROM classroom_roster WHERE agent_group_id = ? LIMIT 1`)
    .get(agentGroupId) as { userId: string } | undefined;
  return row ?? null;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run src/classroom-provider-resolver.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 6: Build cleanly**

Run: `pnpm run build`
Expected: clean exit.

- [ ] **Step 7: Commit**

```bash
git add src/classroom-provider-resolver.ts src/classroom-provider-resolver.test.ts src/db/classroom-roster.ts
git commit -m "$(cat <<'EOF'
feat(classroom): provider-resolver implementing studentCredsHook

Decision matrix: roster lookup → student creds (apiKey/oauth/refresh) →
class controls policy (provideDefault/allowByo/allow). Returns
connect_required / forbidden sentinels per policy. Test seams for
roster, refresher, and class-pool creds keep unit tests pure.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: OAuth /start route (PKCE authorize URL builder — paste-back flow)

**Files:**
- Create: `src/channels/playground/api/provider-auth.ts` (handlers; route registration in Task 14)
- Create: `src/channels/playground/api/provider-auth.test.ts`

**Important:** Per the OAuth endpoint discovery (Task 1) and the spec
update on 2026-05-17, the vendor OAuth clients pin their redirect URIs
to vendor-controlled URLs (Claude: a vendor-hosted "display the code"
page; Codex: localhost loopback). NanoClaw cannot host the callback,
so we use a paste-back flow: `/start` returns the authorize URL + state
as JSON; the frontend opens that URL in a new tab and renders a paste
form. `/exchange` (Task 9) receives the pasted code + state via POST.

- [ ] **Step 1: Write the failing tests**

`src/channels/playground/api/provider-auth.test.ts`:

```ts
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { handleProviderAuthStart, getOAuthStateStoreForTests } from './provider-auth.js';
import { registerProvider, resetRegistryForTests } from '../../../providers/auth-registry.js';

beforeEach(() => {
  resetRegistryForTests();
  registerProvider({
    id: 'claude',
    displayName: 'Anthropic',
    proxyRoutePrefix: '',
    credentialFileShape: 'mixed',
    oauth: {
      clientId: 'cid-claude',
      authorizeUrl: 'https://example.com/oauth/authorize',
      tokenUrl: 'https://example.com/oauth/token',
      redirectUri: 'https://example.com/code/callback',
      scopes: ['user'],
      refreshGrantBody: (rt, cid) => `grant_type=refresh_token&refresh_token=${rt}&client_id=${cid}`,
      pkce: 'S256',
    },
  });
});

describe('handleProviderAuthStart (paste-back)', () => {
  it('returns 200 with JSON {authorizeUrl, state} for known provider', () => {
    const result = handleProviderAuthStart('claude', { userId: 'alice@x.edu' });
    expect(result.status).toBe(200);
    const { authorizeUrl, state } = result.body as { authorizeUrl: string; state: string };
    expect(authorizeUrl).toContain('https://example.com/oauth/authorize');
    expect(authorizeUrl).toContain('client_id=cid-claude');
    expect(authorizeUrl).toContain('code_challenge_method=S256');
    expect(authorizeUrl).toContain('redirect_uri=https%3A%2F%2Fexample.com%2Fcode%2Fcallback');
    expect(authorizeUrl).toContain(`state=${encodeURIComponent(state)}`);
    expect(authorizeUrl).toMatch(/code_challenge=[^&]+/);
  });

  it('stores state in TtlMap bound to user_id, providerId, and PKCE verifier', () => {
    handleProviderAuthStart('claude', { userId: 'alice@x.edu' });
    const store = getOAuthStateStoreForTests();
    const entries = [...store.entriesForTest()];
    expect(entries).toHaveLength(1);
    expect(entries[0][1].userId).toBe('alice@x.edu');
    expect(entries[0][1].providerId).toBe('claude');
    expect(entries[0][1].pkceVerifier).toMatch(/^[A-Za-z0-9-._~]+$/);
    expect(entries[0][1].pkceVerifier.length).toBeGreaterThanOrEqual(43);
  });

  it('returns 404 for unknown provider', () => {
    const result = handleProviderAuthStart('nope', { userId: 'alice@x.edu' });
    expect(result.status).toBe(404);
  });

  it('returns 400 when provider has no oauth config', () => {
    registerProvider({
      id: 'apikey-only',
      displayName: 'X',
      proxyRoutePrefix: '/x/',
      credentialFileShape: 'api-key',
      apiKey: { placeholder: 'k' },
    });
    const result = handleProviderAuthStart('apikey-only', { userId: 'alice@x.edu' });
    expect(result.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/channels/playground/api/provider-auth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `handleProviderAuthStart` and the state store**

Create `src/channels/playground/api/provider-auth.ts`:

```ts
/**
 * OAuth + API-key HTTP handlers for per-student provider auth (paste-back flow).
 *
 * Routes (registered in playground/server.ts):
 *   GET    /provider-auth/:provider/start      → handleProviderAuthStart
 *                                                returns JSON { authorizeUrl, state }
 *   POST   /provider-auth/:provider/exchange   → handleProviderAuthExchange (Task 9)
 *                                                body { code, state }
 *   GET    /api/me/providers/:id               → handleGetProviderStatus (Task 10)
 *   POST   /api/me/providers/:id/api-key       → handlePostApiKey (Task 10)
 *   POST   /api/me/providers/:id/active        → handleSetActive (Task 10)
 *   DELETE /api/me/providers/:id               → handleDisconnect (Task 10)
 *
 * PKCE S256, single-use state tokens via TtlMap. State binds to user_id
 * + providerId + PKCE verifier; exchange enforces single-use via take().
 * Vendor's own redirect_uri (from spec.oauth.redirectUri) is sent unchanged
 * since the vendor OAuth clients are pinned to vendor-controlled URLs —
 * see docs/providers/oauth-endpoints.md.
 */
import crypto from 'crypto';

import type { ApiResult } from './me.js';
import { getProviderSpec } from '../../../providers/auth-registry.js';
import { TtlMap } from '../../../ttl-map.js';

const STATE_TTL_MS = 10 * 60 * 1000;

interface OAuthStateEntry {
  userId: string;
  providerId: string;
  pkceVerifier: string;
  redirectUri: string;
  createdAt: number;
}

const oauthStateStore = new TtlMap<string, OAuthStateEntry>(STATE_TTL_MS);

export function getOAuthStateStoreForTests(): TtlMap<string, OAuthStateEntry> {
  return oauthStateStore;
}

function randomBase64Url(byteLength: number): string {
  return crypto.randomBytes(byteLength).toString('base64url');
}

function s256(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

export function handleProviderAuthStart(
  providerId: string,
  session: { userId: string },
): ApiResult<unknown> {
  const spec = getProviderSpec(providerId);
  if (!spec) return { status: 404, body: { error: `unknown provider: ${providerId}` } };
  if (!spec.oauth) return { status: 400, body: { error: `provider ${providerId} has no oauth config` } };

  const state = randomBase64Url(32);
  const pkceVerifier = randomBase64Url(64);
  const codeChallenge = s256(pkceVerifier);

  oauthStateStore.set(state, {
    userId: session.userId,
    providerId,
    pkceVerifier,
    redirectUri: spec.oauth.redirectUri,
    createdAt: Date.now(),
  });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: spec.oauth.clientId,
    redirect_uri: spec.oauth.redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    scope: spec.oauth.scopes.join(' '),
  });

  return {
    status: 200,
    body: {
      authorizeUrl: `${spec.oauth.authorizeUrl}?${params.toString()}`,
      state,
      instructions: spec.oauth.connectInstructions,
      displayName: spec.displayName,
    },
  };
}
```

If `TtlMap` doesn't expose `entriesForTest()`, add it:

```bash
grep -n "entriesForTest" src/ttl-map.ts
```

If absent, append to `src/ttl-map.ts`:

```ts
  /** Test-only: iterate entries without honoring TTL. */
  *entriesForTest(): Iterable<[K, V]> {
    for (const [key, entry] of this.store) {
      yield [key, entry.value];
    }
  }
```

(Adjust property names per the actual TtlMap implementation — open `src/ttl-map.ts` first if needed.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/channels/playground/api/provider-auth.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Build cleanly**

Run: `pnpm run build`
Expected: clean exit.

- [ ] **Step 6: Commit**

```bash
git add src/channels/playground/api/provider-auth.ts src/channels/playground/api/provider-auth.test.ts src/ttl-map.ts
git commit -m "$(cat <<'EOF'
feat(classroom): provider-auth /start handler with PKCE

S256 PKCE, single-use state tokens in TtlMap bound to userId +
providerId + verifier. 302 to vendor authorize URL.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: OAuth /exchange route (paste-back token exchange)

**Files:**
- Modify: `src/channels/playground/api/provider-auth.ts` — add `handleProviderAuthExchange`
- Modify: `src/channels/playground/api/provider-auth.test.ts` — add exchange tests

- [ ] **Step 1: Write the failing tests**

Append to `src/channels/playground/api/provider-auth.test.ts`:

```ts
import { handleProviderAuthExchange, setTokenExchangerForTests } from './provider-auth.js';
import { hasStudentProviderCreds, loadStudentProviderCreds } from '../../../student-provider-auth.js';

describe('handleProviderAuthExchange (paste-back)', () => {
  beforeEach(() => {
    setTokenExchangerForTests(async (_spec, code, _verifier, _redirectUri) => {
      if (code === 'good-code') {
        return {
          accessToken: 'at-from-exchange',
          refreshToken: 'rt-from-exchange',
          expiresIn: 3600,
          account: 'alice@anthropic',
        };
      }
      return null;
    });
  });

  it('rejects unknown state', async () => {
    const r = await handleProviderAuthExchange(
      'claude',
      { code: 'any-code', state: 'unknown-state' },
      { userId: 'alice@x.edu' },
    );
    expect(r.status).toBe(400);
  });

  it('rejects missing code or state', async () => {
    const r = await handleProviderAuthExchange('claude', { code: '', state: 's' } as never, { userId: 'alice@x.edu' });
    expect(r.status).toBe(400);
  });

  it('exchanges code, persists creds, returns 200 on success', async () => {
    const start = handleProviderAuthStart('claude', { userId: 'alice@x.edu' });
    const { state } = start.body as { state: string };
    const r = await handleProviderAuthExchange('claude', { code: 'good-code', state }, { userId: 'alice@x.edu' });
    expect(r.status).toBe(200);
    expect((r.body as { ok: boolean }).ok).toBe(true);
    expect(hasStudentProviderCreds('alice@x.edu', 'claude')).toBe(true);
    const creds = loadStudentProviderCreds('alice@x.edu', 'claude');
    expect(creds?.active).toBe('oauth');
    expect(creds?.oauth?.accessToken).toBe('at-from-exchange');
  });

  it('rejects state from a different session user', async () => {
    const start = handleProviderAuthStart('claude', { userId: 'alice@x.edu' });
    const { state } = start.body as { state: string };
    const r = await handleProviderAuthExchange('claude', { code: 'good-code', state }, { userId: 'bob@x.edu' });
    expect(r.status).toBe(403);
  });

  it('rejects state/provider mismatch', async () => {
    const start = handleProviderAuthStart('claude', { userId: 'alice@x.edu' });
    const { state } = start.body as { state: string };
    const r = await handleProviderAuthExchange('codex', { code: 'good-code', state }, { userId: 'alice@x.edu' });
    expect(r.status).toBe(400);
  });

  it('returns 502 on exchange failure', async () => {
    const start = handleProviderAuthStart('claude', { userId: 'alice@x.edu' });
    const { state } = start.body as { state: string };
    const r = await handleProviderAuthExchange('claude', { code: 'bad-code', state }, { userId: 'alice@x.edu' });
    expect(r.status).toBe(502);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/channels/playground/api/provider-auth.test.ts`
Expected: FAIL — handler and test seam not exported.

- [ ] **Step 3: Implement `handleProviderAuthExchange` + token exchanger**

Append to `src/channels/playground/api/provider-auth.ts`:

```ts
import { request as httpsRequest } from 'https';
import { addOAuth } from '../../../student-provider-auth.js';

type TokenExchanger = (
  spec: NonNullable<ReturnType<typeof getProviderSpec>>,
  code: string,
  pkceVerifier: string,
  redirectUri: string,
) => Promise<{ accessToken: string; refreshToken: string; expiresIn: number; account?: string } | null>;

let tokenExchanger: TokenExchanger = async (spec, code, pkceVerifier, redirectUri) => {
  if (!spec.oauth) return null;
  // Body format dispatched per provider (smoke-tested 2026-05-17):
  //   Anthropic auth-code grant requires JSON
  //   OpenAI auth-code grant uses standard form-urlencoded
  const payload = {
    grant_type: 'authorization_code',
    code,
    code_verifier: pkceVerifier,
    client_id: spec.oauth.clientId,
    redirect_uri: redirectUri,
  };
  const isJson = spec.oauth.authCodeBodyFormat === 'json';
  const body = isJson ? JSON.stringify(payload) : new URLSearchParams(payload).toString();
  const url = new URL(spec.oauth.tokenUrl);
  return new Promise((resolve) => {
    const req = httpsRequest(
      {
        hostname: url.hostname, port: url.port || 443, path: url.pathname, method: 'POST',
        headers: {
          'Content-Type': isJson ? 'application/json' : 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            resolve({
              accessToken: json.access_token,
              refreshToken: json.refresh_token,
              expiresIn: json.expires_in,
              account: extractAccountEmail(spec.id, json),
            });
          } catch { resolve(null); }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
};

/** Extract display-friendly account label per provider.
 *  Anthropic: top-level `account.email_address`.
 *  OpenAI: middle segment of `id_token` JWT, claim `email`.
 *  Both confirmed via smoke test 2026-05-17. */
function extractAccountEmail(providerId: string, tokenResponse: Record<string, unknown>): string | undefined {
  if (providerId === 'claude') {
    const account = tokenResponse.account as { email_address?: string } | undefined;
    return account?.email_address;
  }
  if (providerId === 'codex' && typeof tokenResponse.id_token === 'string') {
    const parts = tokenResponse.id_token.split('.');
    if (parts.length !== 3) return undefined;
    try {
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as { email?: string };
      return claims.email;
    } catch { return undefined; }
  }
  return undefined;
}

export function setTokenExchangerForTests(fn: TokenExchanger): void {
  tokenExchanger = fn;
}

export async function handleProviderAuthExchange(
  providerId: string,
  body: { code?: string; state?: string },
  session: { userId: string },
): Promise<ApiResult<unknown>> {
  const code = (body.code ?? '').trim();
  const state = (body.state ?? '').trim();
  if (!code || !state) return { status: 400, body: { error: 'code and state required' } };

  const entry = oauthStateStore.take(state);
  if (!entry) return { status: 400, body: { error: 'invalid or expired state' } };
  if (entry.providerId !== providerId) return { status: 400, body: { error: 'state/provider mismatch' } };
  if (entry.userId !== session.userId) return { status: 403, body: { error: 'state bound to different session' } };

  const spec = getProviderSpec(providerId);
  if (!spec) return { status: 404, body: { error: 'unknown provider' } };

  const tokens = await tokenExchanger(spec, code, entry.pkceVerifier, entry.redirectUri);
  if (!tokens) {
    return { status: 502, body: { error: 'token exchange failed' } };
  }

  addOAuth(session.userId, providerId, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: Date.now() + tokens.expiresIn * 1000,
    account: tokens.account,
  });

  return { status: 200, body: { ok: true, account: tokens.account } };
}
```

`TtlMap.take` should exist in trunk; if not, add it before this task (single-use map semantics).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/channels/playground/api/provider-auth.test.ts`
Expected: PASS — 4 callback tests + 4 start tests = 8 total.

- [ ] **Step 5: Build cleanly**

Run: `pnpm run build`
Expected: clean exit.

- [ ] **Step 6: Commit**

```bash
git add src/channels/playground/api/provider-auth.ts src/channels/playground/api/provider-auth.test.ts
git commit -m "$(cat <<'EOF'
feat(classroom): provider-auth /exchange handler with PKCE token exchange

Paste-back flow: POST { code, state }. State token single-use enforced
via TtlMap.take. Cross-session state binding rejected with 403. Provider
mismatch rejected with 400. Exchange failure returns 502.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: `/api/me/providers` CRUD endpoints

**Files:**
- Modify: `src/channels/playground/api/provider-auth.ts` — add 4 CRUD handlers
- Modify: `src/channels/playground/api/provider-auth.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/channels/playground/api/provider-auth.test.ts`:

```ts
import { handleGetProviderStatus, handlePostApiKey, handleSetActive, handleDisconnect } from './provider-auth.js';
import { addOAuth, clearMethod } from '../../../student-provider-auth.js';

describe('GET /api/me/providers/:id', () => {
  it('returns connected:false when no creds', () => {
    const r = handleGetProviderStatus('claude', { userId: 'fresh@x.edu' });
    expect(r.body).toEqual({ hasApiKey: false, hasOAuth: false, active: null });
  });

  it('returns connection details including active method', () => {
    addOAuth('alice@x.edu', 'claude', {
      accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 1000, account: 'alice',
    });
    const r = handleGetProviderStatus('claude', { userId: 'alice@x.edu' });
    expect(r.body).toMatchObject({
      hasApiKey: false,
      hasOAuth: true,
      active: 'oauth',
      oauth: { account: 'alice' },
    });
  });
});

describe('POST /api/me/providers/:id/api-key', () => {
  it('rejects empty key', () => {
    const r = handlePostApiKey('claude', { apiKey: '' }, { userId: 'alice@x.edu' });
    expect(r.status).toBe(400);
  });

  it('stores key and sets active=apiKey when no oauth present', () => {
    const r = handlePostApiKey('claude', { apiKey: 'sk-ant-test' }, { userId: 'alice@x.edu' });
    expect(r.status).toBe(200);
    const status = handleGetProviderStatus('claude', { userId: 'alice@x.edu' });
    expect(status.body).toMatchObject({ hasApiKey: true, active: 'apiKey' });
  });
});

describe('POST /api/me/providers/:id/active', () => {
  it('switches active when both methods present', () => {
    handlePostApiKey('claude', { apiKey: 'sk-1' }, { userId: 'alice@x.edu' });
    addOAuth('alice@x.edu', 'claude', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 1000 });
    const r = handleSetActive('claude', { active: 'oauth' }, { userId: 'alice@x.edu' });
    expect(r.status).toBe(200);
    expect((handleGetProviderStatus('claude', { userId: 'alice@x.edu' }).body as { active: string }).active).toBe('oauth');
  });

  it('rejects activating a method that isnt set', () => {
    handlePostApiKey('claude', { apiKey: 'sk-1' }, { userId: 'alice@x.edu' });
    const r = handleSetActive('claude', { active: 'oauth' }, { userId: 'alice@x.edu' });
    expect(r.status).toBe(400);
  });
});

describe('DELETE /api/me/providers/:id', () => {
  it('clears named method', () => {
    handlePostApiKey('claude', { apiKey: 'sk-1' }, { userId: 'alice@x.edu' });
    addOAuth('alice@x.edu', 'claude', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 1000 });
    const r = handleDisconnect('claude', { which: 'oauth' }, { userId: 'alice@x.edu' });
    expect(r.status).toBe(200);
    expect((handleGetProviderStatus('claude', { userId: 'alice@x.edu' }).body as { hasOAuth: boolean }).hasOAuth).toBe(false);
  });

  it('removes file when both methods cleared', () => {
    handlePostApiKey('claude', { apiKey: 'sk-1' }, { userId: 'alice@x.edu' });
    handleDisconnect('claude', { which: 'apiKey' }, { userId: 'alice@x.edu' });
    const status = handleGetProviderStatus('claude', { userId: 'alice@x.edu' });
    expect(status.body).toMatchObject({ hasApiKey: false, hasOAuth: false, active: null });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/channels/playground/api/provider-auth.test.ts`
Expected: FAIL — handlers not exported.

- [ ] **Step 3: Implement CRUD handlers**

Append to `src/channels/playground/api/provider-auth.ts`:

```ts
import { addApiKey, clearMethod, loadStudentProviderCreds, setActiveMethod } from '../../../student-provider-auth.js';

export function handleGetProviderStatus(providerId: string, session: { userId: string }): ApiResult<unknown> {
  const creds = loadStudentProviderCreds(session.userId, providerId);
  if (!creds) return { status: 200, body: { hasApiKey: false, hasOAuth: false, active: null } };
  return {
    status: 200,
    body: {
      hasApiKey: Boolean(creds.apiKey),
      hasOAuth: Boolean(creds.oauth),
      active: creds.active,
      oauth: creds.oauth ? { account: creds.oauth.account } : undefined,
    },
  };
}

export function handlePostApiKey(
  providerId: string,
  body: { apiKey?: string },
  session: { userId: string },
): ApiResult<unknown> {
  const spec = getProviderSpec(providerId);
  if (!spec) return { status: 404, body: { error: `unknown provider: ${providerId}` } };
  const apiKey = (body.apiKey ?? '').trim();
  if (!apiKey) return { status: 400, body: { error: 'apiKey required' } };
  if (spec.apiKey?.validatePrefix && !apiKey.startsWith(spec.apiKey.validatePrefix)) {
    return { status: 400, body: { error: `apiKey must start with ${spec.apiKey.validatePrefix}` } };
  }
  addApiKey(session.userId, providerId, apiKey);
  return { status: 200, body: { ok: true } };
}

export function handleSetActive(
  providerId: string,
  body: { active?: 'apiKey' | 'oauth' },
  session: { userId: string },
): ApiResult<unknown> {
  if (!body.active || (body.active !== 'apiKey' && body.active !== 'oauth')) {
    return { status: 400, body: { error: 'active must be apiKey or oauth' } };
  }
  try {
    setActiveMethod(session.userId, providerId, body.active);
    return { status: 200, body: { ok: true } };
  } catch (e) {
    return { status: 400, body: { error: (e as Error).message } };
  }
}

export function handleDisconnect(
  providerId: string,
  body: { which?: 'apiKey' | 'oauth' },
  session: { userId: string },
): ApiResult<unknown> {
  if (!body.which || (body.which !== 'apiKey' && body.which !== 'oauth')) {
    return { status: 400, body: { error: 'which must be apiKey or oauth' } };
  }
  clearMethod(session.userId, providerId, body.which);
  return { status: 200, body: { ok: true } };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/channels/playground/api/provider-auth.test.ts`
Expected: PASS — 8 CRUD tests + 8 prior = 16 total.

- [ ] **Step 5: Build cleanly**

Run: `pnpm run build`
Expected: clean exit.

- [ ] **Step 6: Commit**

```bash
git add src/channels/playground/api/provider-auth.ts src/channels/playground/api/provider-auth.test.ts
git commit -m "$(cat <<'EOF'
feat(classroom): /api/me/providers CRUD endpoints

GET status, POST api-key, POST set-active, DELETE method. All enforce
session-scoped user_id; validatePrefix checked when set on the spec.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Home — Providers card (with active-method radio)

**Files:**
- Modify: `src/channels/playground/public/tabs/home.js`

Adds a `renderProvidersCard(body)` function and wires it into `mountHome` next to the existing `renderTelegramCard` / `renderGoogleCard` calls. Sentinel-bounded so the install/uninstall is reversible.

- [ ] **Step 1: Locate the insertion points in home.js**

```bash
grep -n "renderTelegramCard\|renderGoogleCard\|telegram-card\|google-card" src/channels/playground/public/tabs/home.js
```

Note the line numbers where the Telegram and Google cards' HTML is built and the line where `renderGoogleCard(el.querySelector('#google-card-body'))` is called.

- [ ] **Step 2: Insert the Providers card section markup**

In the `el.innerHTML = ...` template, find the Google card section and add immediately after it:

```js
      <!-- classroom-provider-auth:providers-card START -->
      <section class="home-card" id="providers-card">
        <h2>LLM Providers</h2>
        <div id="providers-card-body"><p class="muted">Loading…</p></div>
      </section>
      <!-- classroom-provider-auth:providers-card END -->
```

- [ ] **Step 3: Add `renderProvidersCard` function**

Append to the end of `home.js` (before the closing of any module-level scope):

```js
// ── classroom-provider-auth:providers-card-impl START ─────────────────────

const PROVIDERS = [
  { id: 'codex',  displayName: 'OpenAI'    },
  { id: 'claude', displayName: 'Anthropic' },
];

async function renderProvidersCard(body) {
  if (!body) return;
  try {
    const ccRes = await fetch('/api/class-controls', { credentials: 'same-origin' });
    const cc = await ccRes.json();
    const policies = cc.classes?.default?.providers || {};

    const rows = [];
    for (const p of PROVIDERS) {
      const policy = policies[p.id];
      if (!policy || policy.allow === false) continue;
      const statusRes = await fetch(`/api/me/providers/${p.id}`, { credentials: 'same-origin' });
      const status = await statusRes.json();
      rows.push(renderProviderRow(p, policy, status));
    }
    body.innerHTML = rows.length
      ? rows.join('')
      : `<p class="muted">No providers enabled by your instructor.</p>`;

    PROVIDERS.forEach((p) => wireProviderRow(body, p));
  } catch (err) {
    body.innerHTML = `<p class="muted">Couldn't load providers: ${escapeHtml(String(err))}</p>`;
  }
}

function renderProviderRow(p, policy, status) {
  const { hasApiKey, hasOAuth, active, oauth } = status;
  const displayName = escapeHtml(p.displayName);

  if (hasOAuth && hasApiKey) {
    return `
      <div class="provider-row" data-provider="${p.id}">
        <strong>✅ ${displayName}</strong>
        <div class="provider-active">
          Active:
          <label><input type="radio" name="active-${p.id}" value="oauth" ${active === 'oauth' ? 'checked' : ''}> Subscription (${escapeHtml(oauth?.account || '')})</label>
          <label><input type="radio" name="active-${p.id}" value="apiKey" ${active === 'apiKey' ? 'checked' : ''}> API key</label>
        </div>
        <div class="home-actions">
          <button class="btn btn-danger" data-disconnect="${active}">Disconnect ${active === 'oauth' ? 'subscription' : 'API key'}</button>
        </div>
      </div>`;
  }
  if (hasOAuth) {
    return `
      <div class="provider-row" data-provider="${p.id}">
        <strong>✅ ${displayName}</strong> · Subscription (${escapeHtml(oauth?.account || '')})
        <div class="home-actions">
          <button class="btn" data-add="apiKey">Add API key</button>
          <button class="btn btn-danger" data-disconnect="oauth">Disconnect</button>
        </div>
      </div>`;
  }
  if (hasApiKey) {
    return `
      <div class="provider-row" data-provider="${p.id}">
        <strong>✅ ${displayName}</strong> · API key set
        <div class="home-actions">
          <button class="btn" data-add="oauth">Add subscription</button>
          <button class="btn btn-danger" data-disconnect="apiKey">Disconnect</button>
        </div>
      </div>`;
  }
  // No creds
  if (policy.provideDefault) {
    return `
      <div class="provider-row" data-provider="${p.id}">
        <strong>✅ ${displayName}</strong> · Provided by instructor
        ${policy.allowByo ? `<div class="home-actions"><button class="btn" data-add="oauth">Use my own</button></div>` : ''}
      </div>`;
  }
  if (policy.allowByo) {
    return `
      <div class="provider-row" data-provider="${p.id}">
        <strong>⚠ ${displayName}</strong> · Not connected
        <div class="home-actions">
          <button class="btn" data-add="oauth">Connect</button>
        </div>
      </div>`;
  }
  return ''; // hidden
}

function wireProviderRow(body, p) {
  const row = body.querySelector(`.provider-row[data-provider="${p.id}"]`);
  if (!row) return;

  row.querySelectorAll(`input[name="active-${p.id}"]`).forEach((input) => {
    input.addEventListener('change', async () => {
      const res = await fetch(`/api/me/providers/${p.id}/active`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ active: input.value }),
      });
      if (!res.ok) alert(`Couldn't switch active method for ${p.displayName} (${res.status}).`);
      renderProvidersCard(body);
    });
  });

  row.querySelectorAll('[data-add]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const which = btn.dataset.add;
      if (which === 'oauth') {
        // Paste-back flow: fetch authorize URL + state, open vendor in new tab,
        // render an inline paste form. State is the lookup key for the verifier
        // server-side; we hold it in JS closure until the user pastes the code.
        const res = await fetch(`/provider-auth/${p.id}/start`, { credentials: 'same-origin' });
        if (!res.ok) { alert(`Couldn't start ${p.displayName} sign-in (${res.status}).`); return; }
        const { authorizeUrl, state, instructions } = await res.json();
        window.open(authorizeUrl, '_blank', 'noopener,noreferrer');
        showPasteForm(row, state, instructions);
      } else {
        const apiKey = prompt(`Paste your ${p.displayName} API key:`);
        if (!apiKey) return;
        const res = await fetch(`/api/me/providers/${p.id}/api-key`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ apiKey }),
        });
        if (!res.ok) alert(`Couldn't save API key for ${p.displayName} (${res.status}).`);
        renderProvidersCard(body);
      }
    });
  });

  // showPasteForm closes over the outer `body` and `p` of wireProviderRow —
  // do NOT take them as parameters again. Passing `body.parentElement` (the
  // <section>) here would overwrite the section's innerHTML, destroying the
  // <h2> and the inner div on re-render.
  function showPasteForm(rowEl, state, instructions) {
    const form = document.createElement('div');
    form.className = 'provider-paste-form';
    const instructionsHtml = (instructions || `Sign in to ${escapeHtml(p.displayName)} in the new tab. Paste the authorization code here:`)
      .split('\n')
      .map((line) => `<div>${escapeHtml(line)}</div>`)
      .join('');
    form.innerHTML = `
      <div class="paste-instructions">${instructionsHtml}</div>
      <input type="text" class="paste-code" placeholder="Paste code or URL here" autocomplete="off">
      <div class="home-actions">
        <button class="btn btn-primary">Submit</button>
        <button class="btn">Cancel</button>
      </div>
      <p class="paste-err muted" hidden></p>
    `;
    rowEl.appendChild(form);
    const codeInput = form.querySelector('.paste-code');
    const errLine = form.querySelector('.paste-err');
    codeInput.focus();
    form.querySelector('.btn-primary').addEventListener('click', async () => {
      const code = parsePastedCode(codeInput.value.trim());
      if (!code) { errLine.textContent = 'Code could not be parsed from the pasted value.'; errLine.hidden = false; return; }
      const r = await fetch(`/provider-auth/${p.id}/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ code, state }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        errLine.textContent = `Failed: ${err.error || r.status}`;
        errLine.hidden = false;
        return;
      }
      renderProvidersCard(body);
    });
    form.querySelector('.btn:not(.btn-primary)').addEventListener('click', () => form.remove());
  }

  /** Lenient paste parsing — accepts raw code, code#state, or full callback URL. */
  function parsePastedCode(raw) {
    if (!raw) return '';
    // Full URL with ?code= (OpenAI's failed-loopback case)
    try {
      const url = new URL(raw);
      const c = url.searchParams.get('code');
      if (c) return c;
    } catch { /* not a URL */ }
    // Anthropic's combined code#state form
    if (raw.includes('#')) return raw.split('#')[0];
    return raw;
  }

  row.querySelectorAll('[data-disconnect]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const which = btn.dataset.disconnect;
      if (!confirm(`Disconnect your ${p.displayName} ${which === 'oauth' ? 'subscription' : 'API key'}?`)) return;
      await fetch(`/api/me/providers/${p.id}?which=${which}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      renderProvidersCard(body);
    });
  });
}

// ── classroom-provider-auth:providers-card-impl END ───────────────────────
```

- [ ] **Step 4: Wire `renderProvidersCard` into `mountHome`**

In the section where `renderTelegramCard(...)`, `renderGoogleCard(...)`, `renderUsageCard(...)` are called, add:

```js
  renderProvidersCard(el.querySelector('#providers-card-body'));
```

Also handle the transient banner — extend the existing `googleConnected`/`googleDenied` block at the top of `mountHome` to also recognize `provider_connected=<id>` and `provider_auth_error=denied`:

```js
  const providerConnected = params.get('provider_connected');
  const providerAuthError = params.get('provider_auth_error');
  if (providerConnected || providerAuthError) {
    cleaned.searchParams.delete('provider_connected');
    cleaned.searchParams.delete('provider_auth_error');
    history.replaceState({}, '', cleaned.pathname + (cleaned.search === '?' ? '' : cleaned.search));
  }
```

- [ ] **Step 5: Build cleanly + smoke test in browser**

```bash
pnpm run build
pnpm run dev
```

Open http://localhost:3002, sign in via PIN, observe a "LLM Providers" card on Home with `OpenAI · Provided by instructor` (assuming defaults) and `Anthropic · Not connected · Connect`.

- [ ] **Step 6: Commit**

```bash
git add src/channels/playground/public/tabs/home.js
git commit -m "$(cat <<'EOF'
feat(classroom): Home — Providers card with active-method radio

Sentinel-bounded patch to home.js. Iterates registered providers,
renders per-row state (oauth-only / apikey-only / both / pool / unconnected
/ hidden). Active radio PUTs to /api/me/providers/:id/active.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Home — Class Controls per-provider table

**Files:**
- Modify: `src/channels/playground/public/tabs/home.js` (extend `renderClassControlsForm`)

- [ ] **Step 1: Locate `renderClassControlsForm`**

```bash
grep -n "renderClassControlsForm\|providersChecks" src/channels/playground/public/tabs/home.js
```

- [ ] **Step 2: Replace the flat `providersChecks` block with a per-provider table**

Inside `renderClassControlsForm`, find the line that builds `providersChecks` and the corresponding `<div class="cc-group">` for providers. Replace with:

```js
  // ── classroom-provider-auth:class-controls-providers START ────────────
  const policies = cfg.classes?.default?.providers || {};
  const providerRows = PROVIDERS.concat([{ id: 'local', displayName: 'Local' }])
    .map((p) => {
      const pol = policies[p.id] || { allow: false, provideDefault: false, allowByo: false };
      return `
        <tr>
          <td>${escapeHtml(p.displayName)}</td>
          <td><input type="checkbox" data-cc-provider-allow="${p.id}" ${pol.allow ? 'checked' : ''}></td>
          <td><input type="checkbox" data-cc-provider-default="${p.id}" ${pol.provideDefault ? 'checked' : ''}></td>
          <td><input type="checkbox" data-cc-provider-byo="${p.id}" ${pol.allowByo ? 'checked' : ''}></td>
        </tr>`;
    })
    .join('');
  const providersBlock = `
    <table class="cc-providers-table">
      <thead><tr><th>Provider</th><th>Allow?</th><th>Provide default?</th><th>Let students BYO?</th></tr></thead>
      <tbody>${providerRows}</tbody>
    </table>
  `;
  // ── classroom-provider-auth:class-controls-providers END ──────────────
```

And substitute `${providersBlock}` where the old `${providersChecks}` substitution was.

- [ ] **Step 3: Update the save handler to build the new shape**

Find the `#cc-save` click handler in `renderClassControlsForm`. Replace the `providersAvailable` collection with:

```js
    const providers = {};
    for (const p of PROVIDERS.concat([{ id: 'local' }])) {
      providers[p.id] = {
        allow:          body.querySelector(`[data-cc-provider-allow="${p.id}"]`)?.checked || false,
        provideDefault: body.querySelector(`[data-cc-provider-default="${p.id}"]`)?.checked || false,
        allowByo:       body.querySelector(`[data-cc-provider-byo="${p.id}"]`)?.checked || false,
      };
    }
    const next = {
      classes: {
        default: {
          tabsVisibleToStudents: [...body.querySelectorAll('[data-cc-tab]')].filter((i) => i.checked).map((i) => i.dataset.ccTab),
          authModesAvailable:    [...body.querySelectorAll('[data-cc-auth]')].filter((i) => i.checked).map((i) => i.dataset.ccAuth),
          providers,
        },
      },
    };
```

- [ ] **Step 4: Add minimal CSS for the table**

Append to `src/channels/playground/public/style.css` (near the existing `.cc-group` rules):

```css
.cc-providers-table { width: 100%; border-collapse: collapse; font-size: 12px; margin: 4px 0; }
.cc-providers-table th, .cc-providers-table td { padding: 4px 8px; border-bottom: 1px solid #eee; text-align: left; }
.cc-providers-table th { color: #555; font-weight: 600; font-size: 11px; }
.provider-row { padding: 8px 0; border-bottom: 1px solid #eee; }
.provider-row:last-child { border-bottom: none; }
.provider-active { font-size: 12px; color: #555; margin-top: 4px; }
.provider-active label { margin-right: 12px; }
.provider-paste-form { margin-top: 8px; padding: 8px; background: #f8fafe; border: 1px solid #d6e2f5; border-radius: 6px; }
.provider-paste-form .paste-instructions { font-size: 12px; color: #444; margin-bottom: 6px; line-height: 1.5; }
.provider-paste-form .paste-instructions > div { margin-bottom: 2px; }
.provider-paste-form .paste-code { width: 100%; font-family: ui-monospace, monospace; padding: 4px 6px; margin: 4px 0; }
.provider-paste-form .paste-err { color: #c8482a; font-size: 12px; margin-top: 4px; }
```

- [ ] **Step 5: Smoke test**

```bash
pnpm run build && pnpm run dev
```

As owner, open Home → Class controls. The Providers section should show a 4-column table. Toggle a value, click Save, reload — value persists.

- [ ] **Step 6: Commit**

```bash
git add src/channels/playground/public/tabs/home.js src/channels/playground/public/style.css
git commit -m "$(cat <<'EOF'
feat(classroom): Class Controls per-provider table

Replaces the flat providersAvailable checkbox row with a 4-column
allow/default/byo table per registered provider. Save handler emits
the wrapped classes shape.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Models tab — status pill + section visibility

**Files:**
- Modify: `src/channels/playground/public/tabs/models.js`

- [ ] **Step 1: Locate the per-provider section rendering**

```bash
grep -n "provider\|section\|claude\|codex" src/channels/playground/public/tabs/models.js | head -20
```

Identify where each provider's section header is rendered.

- [ ] **Step 2: Insert a status-pill render helper**

Append to `models.js`:

```js
// ── classroom-provider-auth:models-status-pill START ──────────────────────

async function providerStatusPill(providerId) {
  try {
    const [statusRes, ccRes] = await Promise.all([
      fetch(`/api/me/providers/${providerId}`, { credentials: 'same-origin' }),
      fetch('/api/class-controls', { credentials: 'same-origin' }),
    ]);
    const status = await statusRes.json();
    const cc = await ccRes.json();
    const policy = cc.classes?.default?.providers?.[providerId] || {};

    if (status.active === 'oauth') return { label: 'Your subscription', tone: 'good' };
    if (status.active === 'apiKey') return { label: 'Your API key', tone: 'good' };
    if (policy.provideDefault) return { label: 'Provided by instructor', tone: 'subtle' };
    if (policy.allowByo) return { label: 'Connect to use', tone: 'warn', href: '#tab=home' };
    return { label: 'Unavailable', tone: 'forbidden' };
  } catch {
    return { label: 'Unknown', tone: 'subtle' };
  }
}

function renderPill(pill) {
  const cls = `pill pill-${pill.tone}`;
  if (pill.href) return `<a class="${cls}" href="${pill.href}">${escapeHtml(pill.label)} →</a>`;
  return `<span class="${cls}">${escapeHtml(pill.label)}</span>`;
}

// ── classroom-provider-auth:models-status-pill END ────────────────────────
```

Reuse the existing `escapeHtml` from `home.js` (or duplicate locally — same one-liner). If `models.js` already has a helper file, import from there.

- [ ] **Step 3: Wire the pill into the section header**

For each provider section header rendered in `models.js`, before the section's model list, fetch and render the pill:

```js
  const claudePill = await providerStatusPill('claude');
  const codexPill = await providerStatusPill('codex');
  // …in the template…
  `<h3>Anthropic ${renderPill(claudePill)}</h3>`
  `<h3>OpenAI ${renderPill(codexPill)}</h3>`
```

- [ ] **Step 4: Hide forbidden sections**

After computing the pill, skip rendering the section if the pill tone is `forbidden`:

```js
  if (claudePill.tone === 'forbidden') { /* skip section */ }
```

- [ ] **Step 5: Add pill CSS**

Append to `style.css`:

```css
.pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 500; margin-left: 8px; }
.pill-good    { background: #e6f5ee; color: #2f7d50; }
.pill-subtle  { background: #f1efeb; color: #777; }
.pill-warn    { background: #fff7e6; color: #b8741a; }
.pill-forbidden { background: #fbeae5; color: #c8482a; }
```

- [ ] **Step 6: Smoke test**

```bash
pnpm run build && pnpm run dev
```

Open Models tab. Each provider section shows a pill matching its current state (connect to use, or whatever applies). Click "Connect to use" → navigates to Home tab.

- [ ] **Step 7: Commit**

```bash
git add src/channels/playground/public/tabs/models.js src/channels/playground/public/style.css
git commit -m "$(cat <<'EOF'
feat(classroom): Models tab — provider status pill

Pill per provider section: 'Your subscription' / 'Your API key' /
'Provided by instructor' / 'Connect to use'. Forbidden sections are
hidden entirely.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Wire routes + hook registration into the playground

**Files:**
- Modify: `src/channels/playground/server.ts` — register routes (sentinel-bounded)
- Modify: `src/index.ts` (or wherever playground startup lives) — call `setStudentCredsHook(resolveStudentCreds)` at startup

- [ ] **Step 1: Register OAuth + CRUD routes**

```bash
grep -n "google-auth/start\|google-auth/callback\|/api/me/google" src/channels/playground/server.ts
```

Mirror those route registrations. Inside `server.ts`'s router setup, add (sentinel-bounded):

```ts
// ── classroom-provider-auth:routes START ───────────────────────────────────
if (pathname.startsWith('/provider-auth/')) {
  const m = pathname.match(/^\/provider-auth\/([^/]+)\/(start|exchange)$/);
  if (m) {
    const [, providerId, kind] = m;
    if (kind === 'start' && method === 'GET') {
      const result = handleProviderAuthStart(providerId, requireSession(req, res));
      return sendApiResult(res, result);
    }
    if (kind === 'exchange' && method === 'POST') {
      const body = await readJson(req);
      const result = await handleProviderAuthExchange(providerId, body, requireSession(req, res));
      return sendApiResult(res, result);
    }
  }
}
if (pathname.startsWith('/api/me/providers/')) {
  const m = pathname.match(/^\/api\/me\/providers\/([^/]+)(?:\/(api-key|active))?$/);
  if (m) {
    const [, providerId, action] = m;
    const session = requireSession(req, res);
    if (method === 'GET' && !action) return sendApiResult(res, handleGetProviderStatus(providerId, session));
    if (method === 'POST' && action === 'api-key') {
      const body = await readJson(req);
      return sendApiResult(res, handlePostApiKey(providerId, body, session));
    }
    if (method === 'POST' && action === 'active') {
      const body = await readJson(req);
      return sendApiResult(res, handleSetActive(providerId, body, session));
    }
    if (method === 'DELETE' && !action) {
      const url = new URL(req.url ?? '', 'http://localhost');
      return sendApiResult(res, handleDisconnect(providerId, { which: url.searchParams.get('which') as 'apiKey' | 'oauth' }, session));
    }
  }
}
// ── classroom-provider-auth:routes END ─────────────────────────────────────
```

Imports at top of file (skip if already present):

```ts
import {
  handleProviderAuthStart, handleProviderAuthExchange,
  handleGetProviderStatus, handlePostApiKey, handleSetActive, handleDisconnect,
} from './api/provider-auth.js';
```

- [ ] **Step 2: Register the resolver as the studentCredsHook**

Find `src/index.ts` and the section that initializes the playground / credential-proxy. Add (sentinel-bounded):

```ts
// ── classroom-provider-auth:hook-registration START ───────────────────────
import { setStudentCredsHook } from './credential-proxy.js';
import { resolveStudentCreds } from './classroom-provider-resolver.js';
import './providers/claude-spec.js'; // registers claude
import './providers/codex-spec.js';  // registers codex
setStudentCredsHook(resolveStudentCreds);
// ── classroom-provider-auth:hook-registration END ─────────────────────────
```

- [ ] **Step 3: Wire the per-request hook call in credential-proxy.ts**

In `src/credential-proxy.ts`, find the request handler that resolves Anthropic / OpenAI credentials. Before the existing `.env` / file / keychain chain, insert:

```ts
const hookResult = await studentCredsHook(agentGroupId, providerId);
if (hookResult) {
  if (hookResult.kind === 'apiKey' || hookResult.kind === 'oauth') {
    // proceed with hookResult for upstream auth
  } else {
    const err = serializeResolvedCredsError(hookResult);
    res.writeHead(err.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(err.body));
    return;
  }
}
// else: fall through to existing resolution chain
```

Adapt the variable names to the actual proxy handler. Identify `providerId` from the URL path prefix (e.g., `/openai/*` → `codex`, default → `claude`).

- [ ] **Step 4: Run the full test suite**

```bash
pnpm test
```

Expected: all tests pass, including new provider-auth, resolver, class-controls, and credential-proxy tests.

- [ ] **Step 5: Build cleanly**

```bash
pnpm run build
```

Expected: clean exit.

- [ ] **Step 6: Smoke test end-to-end**

```bash
pnpm run dev
```

1. Sign in as owner via PIN.
2. Class Controls → enable Claude (allow=true, provideDefault=false, allowByo=true). Save.
3. Home → Providers card shows "⚠ Anthropic · Not connected · [Connect]".
4. Click Connect → a new tab opens to `https://claude.com/cai/oauth/authorize?...` with correct client_id, code_challenge, state, and the vendor's own redirect_uri (`https://platform.claude.com/oauth/code/callback`). An inline paste form appears on the original tab. (Token exchange will only succeed when the student completes the vendor flow with a real Anthropic account; verifying the URL/form shape is enough to confirm wiring.)

- [ ] **Step 7: Commit**

```bash
git add src/channels/playground/server.ts src/index.ts src/credential-proxy.ts
git commit -m "$(cat <<'EOF'
feat(classroom): wire provider-auth routes + hook registration

server.ts routes for /provider-auth/*/start|callback and
/api/me/providers/* CRUD. index.ts registers resolveStudentCreds as
the trunk studentCredsHook at startup; credential-proxy calls the
hook on every per-request resolution and serializes
connect_required/forbidden sentinels to 402/403.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: `/add-classroom-provider-auth` install skill

**Files:**
- Create: `.claude/skills/add-classroom-provider-auth/SKILL.md` (on `main`, not classroom)

This task happens in the original `main` worktree (`/Users/admin/projects/nanoclaw`), not the classroom worktree.

- [ ] **Step 1: Push the classroom feature branch**

In the classroom worktree:

```bash
cd /Users/admin/projects/nanoclaw-classroom-x7
git push -u origin classroom-x7-provider-auth
```

Verify all commits from Tasks 5-14 are on the remote branch. This becomes the long-lived source-of-truth branch the skill fetches from (same pattern as `add-gws-tool` uses for `origin/gws-mcp`).

- [ ] **Step 2: Write the skill SKILL.md (in `main` worktree)**

```bash
cd /Users/admin/projects/nanoclaw
mkdir -p .claude/skills/add-classroom-provider-auth
```

Create `.claude/skills/add-classroom-provider-auth/SKILL.md`:

````markdown
---
name: add-classroom-provider-auth
description: Per-student LLM provider auth (Anthropic + OpenAI) with active-method toggle (subscription/API key), instructor-controlled class-pool fallback, and a class_id seam for future multi-class. Installs the resolver, OAuth routes, storage, Home Providers card, Models status pill, and Class Controls per-provider table by copying from origin/classroom-x7-provider-auth.
---

# Add Classroom — Per-Student Provider Auth

Layers on top of `/add-classroom`. Lets each student bring their own Anthropic / OpenAI credentials (paste API key OR OAuth via the vendor's CLI client) and explicitly toggle which method is active. Instructor's host `.env` keys remain as configurable fallback per Class Controls toggles.

## What it adds

- `src/student-provider-auth.ts` — per-student credential storage (apiKey / oauth / active toggle).
- `src/classroom-provider-resolver.ts` — resolver that implements the trunk `studentCredsHook`.
- `src/channels/playground/api/provider-auth.ts` — OAuth start / callback + `/api/me/providers/:id` CRUD.
- Class Controls extension: per-provider `allow` / `provideDefault` / `allowByo` toggles, wrapped in a `classes.default` namespace for future multi-class.
- Home tab "LLM Providers" card with active-method radio control.
- Models tab status pill (`Your subscription` / `Your API key` / `Provided by instructor` / `Connect to use`).

## Prerequisites

- `/add-classroom` installed (provides `classroom_roster` + agent_group mapping).
- The trunk-side provider auth registry + `studentCredsHook` extension point (lands on `main` independently; verify with `grep -l "studentCredsHook" src/credential-proxy.ts`).
- `origin/classroom-x7-provider-auth` remote branch has Tasks 5-14 from `docs/superpowers/plans/2026-05-17-per-student-provider-auth.md` merged in.

## Install

### Pre-flight (idempotent — skip if all true)

- `src/student-provider-auth.ts` exists
- `src/classroom-provider-resolver.ts` exists
- `src/channels/playground/api/provider-auth.ts` exists
- `src/channels/playground/server.ts` contains the `classroom-provider-auth:routes START` sentinel
- `src/channels/playground/public/tabs/home.js` contains the `classroom-provider-auth:providers-card START` sentinel
- `src/index.ts` contains the `classroom-provider-auth:hook-registration START` sentinel

### 1. Fetch the classroom branch

```bash
git fetch origin classroom
```

### 2. Copy the new source files

```bash
git show origin/classroom-x7-provider-auth:src/student-provider-auth.ts                              > src/student-provider-auth.ts
git show origin/classroom-x7-provider-auth:src/student-provider-auth.test.ts                         > src/student-provider-auth.test.ts
git show origin/classroom-x7-provider-auth:src/classroom-provider-resolver.ts                        > src/classroom-provider-resolver.ts
git show origin/classroom-x7-provider-auth:src/classroom-provider-resolver.test.ts                   > src/classroom-provider-resolver.test.ts
git show origin/classroom-x7-provider-auth:src/channels/playground/api/provider-auth.ts              > src/channels/playground/api/provider-auth.ts
git show origin/classroom-x7-provider-auth:src/channels/playground/api/provider-auth.test.ts         > src/channels/playground/api/provider-auth.test.ts
```

### 3. Replace `class-controls.ts` with the wrapped+per-provider version

```bash
git show origin/classroom-x7-provider-auth:src/channels/playground/api/class-controls.ts            > src/channels/playground/api/class-controls.ts
git show origin/classroom-x7-provider-auth:src/channels/playground/api/class-controls.test.ts       > src/channels/playground/api/class-controls.test.ts
```

The v2 loader is backwards-compat — existing flat `config/class-controls.json` is auto-migrated on first read.

### 4. Apply the sentinel-bounded patches

Three files get small additions inside sentinel markers. Each block is idempotent: re-running checks for the sentinel and skips if present.

**`src/channels/playground/server.ts`** — add the routes block from `origin/classroom-x7-provider-auth`:

```bash
if ! grep -q 'classroom-provider-auth:routes START' src/channels/playground/server.ts; then
  echo "Apply the routes block manually from origin/classroom-x7-provider-auth: $(git show --stat origin/classroom-x7-provider-auth -- src/channels/playground/server.ts | head -5)"
fi
```

**`src/index.ts`** — add the hook-registration block:

```bash
if ! grep -q 'classroom-provider-auth:hook-registration START' src/index.ts; then
  echo "Apply the hook-registration block manually from origin/classroom-x7-provider-auth"
fi
```

**`src/channels/playground/public/tabs/home.js`** + **`src/channels/playground/public/tabs/models.js`** + **`src/channels/playground/public/style.css`** — copy the patched files directly:

```bash
git show origin/classroom-x7-provider-auth:src/channels/playground/public/tabs/home.js   > src/channels/playground/public/tabs/home.js
git show origin/classroom-x7-provider-auth:src/channels/playground/public/tabs/models.js > src/channels/playground/public/tabs/models.js
git show origin/classroom-x7-provider-auth:src/channels/playground/public/style.css      > src/channels/playground/public/style.css
```

### 5. Build + test

```bash
pnpm run build
pnpm test
```

Both must be clean.

### 6. Restart the service

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
# systemctl --user restart nanoclaw                # Linux
```

## Verify

1. Open the playground, sign in as owner.
2. Home → Class controls should now show a "Providers" table with allow / provide-default / let-students-byo columns per provider.
3. Home → "LLM Providers" card visible for any provider with `allow=true`.
4. Models tab → each provider section header has a status pill.
5. (Real OAuth: requires vendor authorize URLs to be valid; see `docs/providers/oauth-endpoints.md`.)

## Removal

To uninstall: delete the files added in Step 2-3, remove sentinel-bounded blocks from `server.ts` / `index.ts`, restore `class-controls.ts` to its pre-skill flat shape (or just delete it — defaults rebuild on read). Build + restart.
````

- [ ] **Step 3: Commit the skill on main**

```bash
git add .claude/skills/add-classroom-provider-auth/SKILL.md
git commit -m "$(cat <<'EOF'
feat(skills): /add-classroom-provider-auth install skill

Idempotent install: fetches from origin/classroom-x7-provider-auth and copies the
per-student LLM provider auth subsystem. Layers on /add-classroom.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: Integration test — end-to-end mock OAuth + per-call attribution

**Files:**
- Create: `src/integration/x7-end-to-end.test.ts` (on classroom branch worktree)

This verifies the entire stack: registry → routes → state → token exchange (mocked) → storage → resolver → proxy hook → outbound auth header.

- [ ] **Step 1: Write the integration test**

```ts
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { createServer } from 'http';

import './providers/claude-spec.js';
import { handleProviderAuthStart, handleProviderAuthExchange, setTokenExchangerForTests } from './channels/playground/api/provider-auth.js';
import { setStudentCredsHook } from './credential-proxy.js';
import { resolveStudentCreds, setRosterLookupForTests } from './classroom-provider-resolver.js';
import { loadStudentProviderCreds } from './student-provider-auth.js';

beforeAll(() => {
  setRosterLookupForTests((gid) => gid === 'alice-gid' ? { userId: 'alice@x.edu', classId: 'default' } : null);
  setStudentCredsHook(resolveStudentCreds);
  setTokenExchangerForTests(async () => ({
    accessToken: 'integration-at', refreshToken: 'integration-rt', expiresIn: 3600, account: 'alice',
  }));
});

describe('end-to-end provider auth', () => {
  it('start → exchange → resolver → proxy hook returns student OAuth token', async () => {
    const start = handleProviderAuthStart('claude', { userId: 'alice@x.edu' });
    const { state } = start.body as { state: string };
    await handleProviderAuthExchange('claude', { code: 'good', state }, { userId: 'alice@x.edu' });

    expect(loadStudentProviderCreds('alice@x.edu', 'claude')?.oauth?.accessToken).toBe('integration-at');

    // Now ask the proxy hook for this student's creds
    const { studentCredsHook } = await import('./credential-proxy.js');
    const result = await studentCredsHook('alice-gid', 'claude');
    expect(result).toEqual({ kind: 'oauth', accessToken: 'integration-at' });
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `pnpm exec vitest run src/integration/x7-end-to-end.test.ts`
Expected: PASS — 1 test.

- [ ] **Step 3: Commit**

```bash
git add src/integration/x7-end-to-end.test.ts
git commit -m "$(cat <<'EOF'
test(classroom): end-to-end provider auth integration test

Walks the full stack: OAuth start → callback → storage → resolver →
trunk proxy hook → returns the student's access token. Mocked token
exchanger; real handler chain.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: Final docs — Phase 14 tech debt note

**Files:**
- Modify: `docs/superpowers/plans/2026-05-15-classroom-per-person-mode.md`

- [ ] **Step 1: Append a follow-up bullet under the X.7 section**

In `docs/superpowers/plans/2026-05-15-classroom-per-person-mode.md`, find the X.7 bullet (around line 222) and append at the bottom of its body (before the `Detail:` link):

```markdown
      **Phase 14 asymmetry (follow-up):** `src/student-google-auth.ts`,
      `src/channels/playground/api/google-auth.ts`, and the Home/Models
      UI patches for Google currently live in trunk. X.7's classroom-
      branch split exposes this asymmetry; the clean state would
      migrate Phase 14 to `origin/classroom-x7-provider-auth` and install via
      `/add-classroom-google-auth`. Not blocking, tracked separately.
```

- [ ] **Step 2: Commit**

```bash
cd /Users/admin/projects/nanoclaw  # main worktree
git add docs/superpowers/plans/2026-05-15-classroom-per-person-mode.md
git commit -m "$(cat <<'EOF'
docs(plan): note Phase 14 asymmetry as follow-up tech debt for X.7

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Acceptance Criteria (whole plan)

- All 17 tasks complete with their commits landed:
  - Trunk commits on `main` (Tasks 1, 2, 3, 15, 17)
  - Classroom-branch commits on `classroom-x7-provider-auth` (Tasks 5-14, 16)
- `pnpm test` clean on both branches.
- `pnpm run build` clean on both branches.
- Smoke flow works (Task 14 step 6): signing in as owner, configuring Class Controls, seeing the Providers card on Home, clicking Connect generates a properly-formed authorize URL.
- Integration test passes (Task 16).
- Skill SKILL.md installed and the install steps are idempotent (re-running has no effect on a fresh fork).
- `docs/providers/oauth-endpoints.md` reflects real discovered values (no `<fill in>` placeholders).
