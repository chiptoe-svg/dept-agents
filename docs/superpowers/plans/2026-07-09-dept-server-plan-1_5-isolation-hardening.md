# Plan 1.5: Isolation Hardening

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make per-user isolation actually enforced — no user (or their prompt-injected agent) can read or modify another user's agent group, credentials, or data — before any pilot colleague is invited.

**Architecture:** The review (`docs/superpowers/reviews/2026-07-09-full-code-review.md`) found one defect repeated in three subsystems: **identity is asserted by a caller-supplied value, never bound server-side.** This plan fixes it in three places with the same shape. (1) Web API: a single `requireGroupAccess` helper on every mutation route, guarded by a table-driven regression test written *first*. (2) Host services (`:3001` credential proxy, `:3007` GWS relay): a per-container secret minted at spawn and resolved to a group id server-side; the `x-nanoclaw-agent-group` header becomes advisory. (3) `ncl`: reads scoped to the caller group the host already stamps. Then the money/availability items that gate a pilot.

**Tech Stack:** Node 22 + TypeScript host (`pnpm run build` = tsc; `pnpm test` = vitest, `better-sqlite3`); Bun agent-runner under `container/agent-runner/` (`bun test`, `bun:sqlite`); Apple Container runtime; launchd service `com.nanoclaw-v2-581fefa4`.

## Global Constraints

- Working directory `/Users/admin/projects/nanoclaw`. **Never** touch `/Users/admin/projects/nanoclaw_personal` (separate live install sharing the container binary/daemon).
- Run `pnpm run build` (tsc) yourself after every code change and read the output — **vitest tolerates TS errors that tsc rejects**; a green vitest alone is not evidence.
- Host tests: `import { describe, it, expect } from 'vitest'`. Container tests (`container/agent-runner/src/`): `import { describe, it, expect } from 'bun:test'`. Never mix — vitest cannot load `bun:sqlite`.
- Container typecheck is separate: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`.
- **Vitest writes fixture dirs into the live `groups/`.** Before running the suite, note `ls groups/`; after, delete any dir that appeared and is not `_default_participant`, `owner_01`, `user_01`.
- The dept OpenAI key and per-user OAuth tokens are real money and real accounts. Never print a secret into a log, test fixture, commit, or terminal.
- `PLAYGROUND_AUTH_BYPASS=1` is currently set in `.env`. Several helpers **early-return allow** when it is on. Every gate you write must be tested with bypass **off**, and Task 9 turns it off for good.
- Ad-hoc DB queries: `pnpm exec tsx scripts/q.ts <db> "<sql>"` — never the `sqlite3` CLI.
- Every commit message ends, after a blank line, with:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01WXUAU8TQduy8SMSVWoNYvn
  ```
  A husky pre-commit hook regenerates `state.md`'s volatile section; if it stages `state.md`, include it.
- Do **not** rename any `class-*` / `classroom-*` file in this plan. Renames are Plans 3–5. Judge and fix behavior only.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/channels/playground/require-group-access.ts` | **New.** The single authorization helper for folder-addressed routes. One export, one job. | 1 |
| `src/channels/playground/api-routes.authz.test.ts` | **New.** Table-driven regression test: user A gets 403 on every folder-addressed route targeting user B. This is the artifact that prevents a fourth recurrence. | 1, 2 |
| `src/channels/playground/api-routes.ts` | Apply `requireGroupAccess` to every mutation route. No other change. | 2 |
| `src/container-identity.ts` | **New.** In-memory `token → { agentGroupId, sessionId }` registry: `mintContainerToken`, `resolveContainerToken`, `revokeContainerToken`, `_resetForTest`. Sole owner of container identity. | 3 |
| `src/container-identity.test.ts` | **New.** Registry unit tests. | 3 |
| `src/container-runner.ts` | Mint a token per spawn, inject `X_NANOCLAW_AGENT_TOKEN`, revoke on exit. | 4 |
| `container/agent-runner/src/proxy-fetch.ts` | Stamp the token header on proxied fetches. | 4 |
| `container/agent-runner/src/mcp-tools/gws.ts` | Stamp the token header on relay calls; correct the false doc comment. | 4 |
| `src/credential-proxy.ts` | Derive the agent group from the token, not the header. Fail closed for non-loopback callers. | 5 |
| `src/gws-mcp-relay.ts` | Same, plus the `canAccessAgentGroup` check its comment already promises. | 6 |
| `src/cli/crud.ts`, `src/cli/dispatch.ts` | Scope `list`/`get` to the caller's group when the caller is an agent. | 7 |
| `src/channels/playground/api/direct-chat.ts` | Enforce the model allowlist and the existing budget. | 8 |
| `src/modules/budgets/enforce.ts` | **New.** `assertWithinBudget(agentGroupId)` — the one enforcement call site the budgets have always lacked. | 8 |

---

### Task 1: The authorization helper + the failing regression test

Write the test **first**. It must fail against today's code — that failure is the proof the vulnerability is real, and the test is the deliverable that outlives this plan.

**Files:**
- Create: `src/channels/playground/require-group-access.ts`
- Create: `src/channels/playground/api-routes.authz.test.ts`

**Interfaces:**
- Produces: `requireGroupAccess(folder: string, userId: string | null | undefined): string | null` — returns `null` when access is allowed, or a denial reason string when not. Later tasks call it as `const denied = requireGroupAccess(f, session.userId); if (denied) return send(res, 403, { error: 'Forbidden' });`
- Produces: the exported const `MUTATION_ROUTES` from the test file is **not** exported — the table lives inside the test.
- Consumes: `canAccessAgentGroup(userId, agentGroupId): { allowed: boolean; reason: string }` from `src/modules/permissions/access.ts`; `getAgentGroupByFolder(folder)` from `src/db/agent-groups.js`.

**Why not reuse `canReadDraft`:** it fails **open** for folders with no `agent_groups` row (`draft-read-gate.ts:31`) and returns `true` whenever `PLAYGROUND_AUTH_BYPASS` is set. For mutations both behaviors are wrong: an unknown folder must be denied (a write would create it), and bypass must never authorize cross-tenant writes. `requireGroupAccess` fails **closed** on both.

- [ ] **Step 1: Write the helper's own unit test**

Create `src/channels/playground/require-group-access.ts` later; first the test file `src/channels/playground/api-routes.authz.test.ts`:

```ts
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-authz',
    GROUPS_DIR: '/tmp/nanoclaw-test-authz/groups',
    PLAYGROUND_AUTH_BYPASS: false,
  };
});

import { initTestDb, closeDb, runMigrations, getDb } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createUser } from '../../modules/permissions/db/users.js';
import { addMember } from '../../modules/permissions/db/agent-group-members.js';
import { requireGroupAccess } from './require-group-access.js';

const TMP = '/tmp/nanoclaw-test-authz';
const GROUPS = path.join(TMP, 'groups');
const NOW = '2026-07-09T00:00:00Z';

function seed(): void {
  createUser({ id: 'playground:alice', kind: 'playground', display_name: 'Alice', created_at: NOW });
  createUser({ id: 'playground:bob', kind: 'playground', display_name: 'Bob', created_at: NOW });
  createAgentGroup({ id: 'ag_alice', name: 'Alice', folder: 'user_alice', agent_provider: 'pi', created_at: NOW, metadata: '{}' });
  createAgentGroup({ id: 'ag_bob', name: 'Bob', folder: 'user_bob', agent_provider: 'pi', created_at: NOW, metadata: '{}' });
  addMember({ user_id: 'playground:alice', agent_group_id: 'ag_alice', added_by: null, added_at: NOW });
  addMember({ user_id: 'playground:bob', agent_group_id: 'ag_bob', added_by: null, added_at: NOW });
  fs.mkdirSync(path.join(GROUPS, 'user_alice'), { recursive: true });
  fs.mkdirSync(path.join(GROUPS, 'user_bob'), { recursive: true });
}

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(GROUPS, { recursive: true });
  initTestDb();
  runMigrations(getDb());
  seed();
});

afterEach(() => {
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('requireGroupAccess', () => {
  it('allows a member on their own group', () => {
    expect(requireGroupAccess('user_alice', 'playground:alice')).toBeNull();
  });

  it('denies a member on another user group', () => {
    expect(requireGroupAccess('user_bob', 'playground:alice')).toBe('not_member');
  });

  it('denies an anonymous caller', () => {
    expect(requireGroupAccess('user_alice', null)).toBe('no_session');
  });

  it('fails closed on an unknown folder', () => {
    expect(requireGroupAccess('user_nonexistent', 'playground:alice')).toBe('unknown_group');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run src/channels/playground/api-routes.authz.test.ts`
Expected: FAIL — `Failed to resolve import "./require-group-access.js"`.

- [ ] **Step 3: Write the helper**

Create `src/channels/playground/require-group-access.ts`:

```ts
/**
 * Authorization for folder-addressed playground routes.
 *
 * Every `/api/drafts/:folder/...` route takes its target from the URL, so
 * without a per-request check any authenticated user can address any other
 * user's agent group. This is that check, and it is the ONLY thing routes
 * should use to authorize a mutation.
 *
 * Deliberately different from `canReadDraft`:
 *   - unknown folder → DENY (a write would materialize it)
 *   - PLAYGROUND_AUTH_BYPASS → still enforced (bypass authenticates a seat;
 *     it must never authorize one user to act on another's group)
 *
 * Do NOT use `checkDraftMutation` for authorization. It is a class-lockdown
 * hook that default-allows with an empty gate chain.
 */
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { canAccessAgentGroup } from '../../modules/permissions/access.js';

/** `null` when allowed; a short reason string when denied. */
export function requireGroupAccess(folder: string, userId: string | null | undefined): string | null {
  const group = getAgentGroupByFolder(folder);
  if (!group) return 'unknown_group';
  if (!userId) return 'no_session';
  const decision = canAccessAgentGroup(userId, group.id);
  return decision.allowed ? null : decision.reason;
}
```

- [ ] **Step 4: Run the test again**

Run: `pnpm exec vitest run src/channels/playground/api-routes.authz.test.ts`
Expected: PASS, 4/4.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm run build
git add src/channels/playground/require-group-access.ts src/channels/playground/api-routes.authz.test.ts
git commit -m "feat(authz): requireGroupAccess — fail-closed folder authorization helper"
```

### Task 2: Gate every mutation route (fixes C1, C2, C3, C4)

**Files:**
- Modify: `src/channels/playground/api-routes.ts` (routes listed below)
- Modify: `src/channels/playground/api-routes.authz.test.ts` (append the route-table test)

**Interfaces:**
- Consumes: `requireGroupAccess(folder, userId) → string | null` (Task 1).
- Produces: every folder-addressed mutation route returns **403** for a non-member. Later plans adding routes to this file must add them to the table in `api-routes.authz.test.ts`.

**The routes to gate.** Each currently has either no check or only `checkDraftMutation` (which default-allows). Line numbers are from the review; confirm by reading — do not trust them blindly if the file has shifted.

| Method | Path | Current state | Line |
|---|---|---|---|
| POST | `/api/drafts` (body `targetFolder`) | none | ~176 |
| DELETE | `/api/drafts/:folder` | none | ~190 |
| POST | `/api/drafts/:folder/apply` | none | ~203 |
| POST | `/api/drafts/:folder/messages` | none (comment falsely claims a gate) | ~229 |
| PUT | `/api/drafts/:folder/persona` | none | ~359 |
| PUT | `/api/drafts/:folder/skills` | `checkDraftMutation` only | ~555 |
| PUT | `/api/drafts/:folder/custom-skills/:name/file` | `checkDraftMutation` only | ~605 |
| DELETE | `/api/drafts/:folder/custom-skills/:name` | `checkDraftMutation` only | ~630 |
| PUT | `/api/drafts/:folder/models` | `checkDraftMutation` only | ~646 |
| PUT | `/api/drafts/:folder/active-model` | `checkDraftMutation` only | ~659 |
| PUT | `/api/drafts/:folder/name` | `checkDraftMutation` only | ~684 |
| POST | `/api/drafts/:folder/knowledge/corpora` | `checkDraftMutation` only | ~1044 |
| DELETE | `/api/drafts/:folder/knowledge/corpora/:id` | `checkDraftMutation` only | ~1066 |
| PUT | `/api/drafts/:folder/knowledge/corpora/:id/upload` | `checkDraftMutation` only | ~1085 |
| POST | `/api/drafts/:folder/knowledge/corpora/:id/ingest` | `checkDraftMutation` only | ~1110 |
| PUT/DELETE | `/api/drafts/:folder/knowledge/benchmarks/:id` | `canReadDraft` only (read-level gate on a write) | ~1169 |

`POST /api/drafts` addresses its target via `body.targetFolder`, not the URL — gate that value, after `readJsonBody`.

Keep existing `checkDraftMutation` calls where present (they encode the separate class-lockdown policy); add `requireGroupAccess` **in addition**, before them. Leave `GET` routes alone — they already use `canReadDraft`.

- [ ] **Step 1: Write the failing route-table test**

Append to `src/channels/playground/api-routes.authz.test.ts` (the imports and `seed()` from Task 1 stay):

```ts
import http from 'http';
import { route } from './api-routes.js';
import type { PlaygroundSession } from './auth-store.js';

function aliceSession(): PlaygroundSession {
  return { cookieValue: 'c', userId: 'playground:alice', createdAt: Date.now(), lastActivityAt: Date.now() };
}

/** Minimal req/res doubles: we assert only on the status code. */
function fakeReqRes(method: string, body: unknown) {
  const req = Object.assign(new http.IncomingMessage(null as never), { method });
  // readJsonBody() reads the stream; push the body then EOF.
  req.push(body === undefined ? null : JSON.stringify(body));
  req.push(null);
  let status = 0;
  const res = {
    statusCode: 0,
    writeHead(s: number) { status = s; return this; },
    end() { return this; },
    setHeader() { return this; },
  } as unknown as http.ServerResponse;
  return { req, res, getStatus: () => status || (res as { statusCode: number }).statusCode };
}

/** Every folder-addressed MUTATION route. Add a row here when you add a route. */
const MUTATION_ROUTES: Array<{ method: string; path: string; body?: unknown }> = [
  { method: 'POST', path: '/api/drafts', body: { targetFolder: 'user_bob' } },
  { method: 'DELETE', path: '/api/drafts/draft_user_bob' },
  { method: 'POST', path: '/api/drafts/draft_user_bob/apply' },
  { method: 'POST', path: '/api/drafts/user_bob/messages', body: { text: 'pwn' } },
  { method: 'PUT', path: '/api/drafts/user_bob/persona', body: { text: 'pwn' } },
  { method: 'PUT', path: '/api/drafts/user_bob/skills', body: { skills: [] } },
  { method: 'PUT', path: '/api/drafts/user_bob/custom-skills/s/file', body: { name: 'a', text: 'x' } },
  { method: 'DELETE', path: '/api/drafts/user_bob/custom-skills/s' },
  { method: 'PUT', path: '/api/drafts/user_bob/models', body: { models: [] } },
  { method: 'PUT', path: '/api/drafts/user_bob/active-model', body: { model: 'x' } },
  { method: 'PUT', path: '/api/drafts/user_bob/name', body: { name: 'x' } },
  { method: 'POST', path: '/api/drafts/user_bob/knowledge/corpora', body: { name: 'x' } },
  { method: 'DELETE', path: '/api/drafts/user_bob/knowledge/corpora/c1' },
  { method: 'PUT', path: '/api/drafts/user_bob/knowledge/corpora/c1/upload', body: {} },
  { method: 'POST', path: '/api/drafts/user_bob/knowledge/corpora/c1/ingest', body: {} },
  { method: 'PUT', path: '/api/drafts/user_bob/knowledge/benchmarks/b1', body: {} },
];

describe('cross-tenant mutation routes are denied', () => {
  for (const r of MUTATION_ROUTES) {
    it(`${r.method} ${r.path} → 403 for a non-member`, async () => {
      const { req, res, getStatus } = fakeReqRes(r.method, r.body);
      const url = new URL(r.path, 'http://localhost');
      await route(req, res, url, r.method, aliceSession());
      expect(getStatus()).toBe(403);
    });
  }
});

describe('own-group mutation still works', () => {
  it('PUT /api/drafts/user_alice/persona → not 403', async () => {
    const { req, res, getStatus } = fakeReqRes('PUT', { text: 'my persona' });
    const url = new URL('/api/drafts/user_alice/persona', 'http://localhost');
    await route(req, res, url, 'PUT', aliceSession());
    expect(getStatus()).not.toBe(403);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run src/channels/playground/api-routes.authz.test.ts`
Expected: FAIL — most `MUTATION_ROUTES` cases return 200/400/500, not 403. **Record the exact list of failures in your report**: that list is the vulnerability inventory, and Step 4 must turn every one green.

If a case fails for an unrelated reason (e.g. a 500 from a missing fixture file rather than a 200), fix the fixture in `seed()` so the case genuinely exercises authorization — a route that 500s before reaching the gate proves nothing. Do **not** weaken the assertion to accept 500.

- [ ] **Step 3: Add the gate to every route in the table**

For each URL-addressed route, immediately after the folder is extracted from the regex match and before any filesystem or DB work:

```ts
    const denied = requireGroupAccess(draftFolder, session.userId);
    if (denied) return send(res, 403, { error: 'Forbidden' });
```

For `POST /api/drafts`, after `const body = await readJsonBody(req);`:

```ts
    const denied = requireGroupAccess(String(body.targetFolder ?? ''), session.userId);
    if (denied) return send(res, 403, { error: 'Forbidden' });
```

Add the import at the top of `api-routes.ts`:

```ts
import { requireGroupAccess } from './require-group-access.js';
```

For `DELETE /api/drafts/:folder` and `POST /api/drafts/:folder/apply` the folder is a `draft_<target>` name. Gate the **target**, which is what the draft writes to:

```ts
    const target = draftFolder.startsWith('draft_') ? draftFolder.slice('draft_'.length) : draftFolder;
    const denied = requireGroupAccess(target, session.userId);
    if (denied) return send(res, 403, { error: 'Forbidden' });
```

Delete the false comment at `api-routes.ts:215-220` claiming membership "is enforced in `getPlaygroundAgentForUser` at sign-in time" — it is not, and it is why this route went ungated.

- [ ] **Step 4: Run the test until every case is green**

Run: `pnpm exec vitest run src/channels/playground/api-routes.authz.test.ts`
Expected: PASS — all 16 cross-tenant cases 403, and the own-group case not 403.

- [ ] **Step 5: Run the full suite, typecheck, clean fixtures, commit**

```bash
pnpm test
pnpm run build
ls groups/    # delete any dir that is not _default_participant, owner_01, user_01
git add -A
git commit -m "fix(authz): gate every folder-addressed mutation route (C1-C4)

Cross-tenant writes were possible on 16 routes: PUT persona and POST
messages had no check at all, and checkDraftMutation — which the rest
relied on — default-allows. Adds requireGroupAccess plus a table-driven
regression test that fails if a future route forgets the gate."
```

### Task 3: Container identity registry

**Files:**
- Create: `src/container-identity.ts`
- Create: `src/container-identity.test.ts`

**Interfaces:**
- Produces:
  - `mintContainerToken(agentGroupId: string, sessionId: string): string` — 256-bit hex from `crypto.randomBytes(32)`.
  - `resolveContainerToken(token: string | undefined | null): { agentGroupId: string; sessionId: string } | null`
  - `revokeContainerToken(token: string): void`
  - `_resetForTest(): void`
- Consumed by Tasks 4 (mint/revoke), 5 and 6 (resolve).

In-memory is correct and sufficient: tokens are per-container-process, and a host restart kills every container anyway (`cleanupOrphans` at boot). Do not persist them.

- [ ] **Step 1: Write the failing test**

Create `src/container-identity.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { mintContainerToken, resolveContainerToken, revokeContainerToken, _resetForTest } from './container-identity.js';

beforeEach(() => _resetForTest());

describe('container identity registry', () => {
  it('resolves a minted token to its group and session', () => {
    const t = mintContainerToken('ag_alice', 'sess_1');
    expect(resolveContainerToken(t)).toEqual({ agentGroupId: 'ag_alice', sessionId: 'sess_1' });
  });

  it('returns null for an unknown, empty, or undefined token', () => {
    expect(resolveContainerToken('deadbeef')).toBeNull();
    expect(resolveContainerToken('')).toBeNull();
    expect(resolveContainerToken(undefined)).toBeNull();
  });

  it('returns null after revocation', () => {
    const t = mintContainerToken('ag_alice', 'sess_1');
    revokeContainerToken(t);
    expect(resolveContainerToken(t)).toBeNull();
  });

  it('mints unpredictable, distinct tokens', () => {
    const a = mintContainerToken('ag_alice', 'sess_1');
    const b = mintContainerToken('ag_alice', 'sess_1');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not let one group resolve another group token', () => {
    const alice = mintContainerToken('ag_alice', 'sess_1');
    const bob = mintContainerToken('ag_bob', 'sess_2');
    expect(resolveContainerToken(alice)!.agentGroupId).toBe('ag_alice');
    expect(resolveContainerToken(bob)!.agentGroupId).toBe('ag_bob');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run src/container-identity.test.ts`
Expected: FAIL — cannot resolve `./container-identity.js`.

- [ ] **Step 3: Implement**

Create `src/container-identity.ts`:

```ts
/**
 * Per-container identity.
 *
 * Host services (credential proxy, GWS MCP relay) must know WHICH agent
 * group is calling. Before this module they trusted an `x-nanoclaw-agent-group`
 * request header that the container itself set — so any container could
 * claim to be any group and have another user's credentials attached to its
 * upstream calls.
 *
 * Instead: the host mints an unguessable token per container at spawn, passes
 * it in as an env var, and resolves token → group server-side. The token is
 * the capability; the group header is advisory (logging) at most.
 *
 * In-memory by design — a token's lifetime is its container's, and a host
 * restart reaps every container (see cleanupOrphans).
 */
import crypto from 'crypto';

export interface ContainerIdentity {
  agentGroupId: string;
  sessionId: string;
}

const tokens = new Map<string, ContainerIdentity>();

export function mintContainerToken(agentGroupId: string, sessionId: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  tokens.set(token, { agentGroupId, sessionId });
  return token;
}

export function resolveContainerToken(token: string | undefined | null): ContainerIdentity | null {
  if (!token) return null;
  return tokens.get(token) ?? null;
}

export function revokeContainerToken(token: string): void {
  tokens.delete(token);
}

/** Test hook — drop every token. */
export function _resetForTest(): void {
  tokens.clear();
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm exec vitest run src/container-identity.test.ts`
Expected: PASS, 5/5.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm run build
git add src/container-identity.ts src/container-identity.test.ts
git commit -m "feat(identity): per-container token registry"
```

### Task 4: Mint the token at spawn; stamp it container-side

**Files:**
- Modify: `src/container-runner.ts` (~line 562, where `X_NANOCLAW_AGENT_GROUP` is injected; and the container-exit path)
- Modify: `container/agent-runner/src/proxy-fetch.ts` (~lines 54-72)
- Modify: `container/agent-runner/src/mcp-tools/gws.ts` (~lines 43-56, and the false comment at line 8)

**Interfaces:**
- Consumes: `mintContainerToken(agentGroupId, sessionId) → string`, `revokeContainerToken(token)` (Task 3).
- Produces: containers receive env `X_NANOCLAW_AGENT_TOKEN=<64 hex chars>` and send header `x-nanoclaw-agent-token` on every request to the credential proxy and the GWS relay. Tasks 5 and 6 require that header.

**Ordering matters:** this task must land *before* Tasks 5 and 6, or running containers lose access. It is backward-compatible on its own — it only *adds* an env var and a header that nothing yet requires.

- [ ] **Step 1: Mint and inject in `container-runner.ts`**

Add the import:

```ts
import { mintContainerToken, revokeContainerToken } from './container-identity.js';
```

Immediately before the existing `args.push('-e', `X_NANOCLAW_AGENT_GROUP=${agentGroup.id}`);` (~line 562):

```ts
  const containerToken = mintContainerToken(agentGroup.id, sessionId);
  args.push('-e', `X_NANOCLAW_AGENT_TOKEN=${containerToken}`);
```

Keep the `X_NANOCLAW_AGENT_GROUP` line — Tasks 5/6 demote it to advisory rather than removing it, so the container-side code and logs keep working.

- [ ] **Step 2: Revoke on container exit**

Find where the spawned container process's exit is handled in `container-runner.ts` (the `close`/`exit` handler that already cleans up the session's bookkeeping). Add, inside it:

```ts
    revokeContainerToken(containerToken);
```

If several exit paths exist (normal exit, kill, spawn failure), revoke in each — a token outliving its container is a standing credential. Read the file and enumerate them; do not assume there is only one.

- [ ] **Step 3: Stamp the header in `proxy-fetch.ts`**

In `container/agent-runner/src/proxy-fetch.ts`, alongside the existing `agentGroupId`/`sessionId` reads (~line 54):

```ts
  const agentToken = process.env.X_NANOCLAW_AGENT_TOKEN;
```

Add the header constant next to the existing ones:

```ts
const AGENT_TOKEN_HEADER = 'x-nanoclaw-agent-token';
```

and inside the wrapped fetch, next to the existing header sets:

```ts
    if (agentToken && !headers.has(AGENT_TOKEN_HEADER)) headers.set(AGENT_TOKEN_HEADER, agentToken);
```

Leave the existing `if (!agentGroupId || !proxyOrigin) return;` no-op guard as-is.

- [ ] **Step 4: Stamp the header in `gws.ts` and fix its false comment**

In `container/agent-runner/src/mcp-tools/gws.ts`, add next to the `agentGroupId` read (~line 43):

```ts
  const agentToken = process.env.X_NANOCLAW_AGENT_TOKEN;
```

and in the headers object (~line 56), alongside `'x-nanoclaw-agent-group': agentGroupId`:

```ts
        'x-nanoclaw-agent-token': agentToken ?? '',
```

Replace the comment at line 8 — it currently claims the relay "applies role-based scoping (`canAccessAgentGroup`)", which was false. Write what is true after Task 6:

```ts
 * The relay resolves the caller's agent group from the per-container token
 * (X_NANOCLAW_AGENT_TOKEN) and applies canAccessAgentGroup before dispatch.
```

- [ ] **Step 5: Typecheck both trees, test, commit**

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
pnpm test
cd container/agent-runner && bun test && cd ../..
git add -A
git commit -m "feat(identity): mint per-container token at spawn, stamp on proxy + relay calls"
```

### Task 5: Credential proxy resolves identity from the token (fixes C5)

**Files:**
- Modify: `src/credential-proxy.ts` (~lines 171, 540-541, 602-604)
- Create: test cases appended to the existing `src/credential-proxy.test.ts`

**Interfaces:**
- Consumes: `resolveContainerToken(token) → { agentGroupId, sessionId } | null` (Task 3); the `x-nanoclaw-agent-token` header (Task 4).
- Produces: `agentGroupId` used for credential resolution is derived **only** from the token. Non-loopback requests without a valid token are rejected 401.

**The loopback rule.** The proxy today also serves host-internal callers (e.g. `api/direct-chat.ts` dispatches to `127.0.0.1:3001` with no headers and expects the department `.env` credential). Preserve that, and only that:

- request from `127.0.0.1` / `::1` → trusted host caller; no token needed; `agentGroupId = null` → department `.env` fallback (unchanged behavior).
- request from any other source (i.e. a container over the bridge, or anything on the LAN) → **must** present a valid `x-nanoclaw-agent-token`, else 401.

This closes both the spoofing hole and the open-proxy hole without depending on the bind address, which cannot safely be narrowed at startup (`bridge100` does not exist until a container runs — see `src/container-runtime.ts:52-60`).

- [ ] **Step 1: Write the failing tests**

A test cannot easily fake a non-loopback `socket.remoteAddress` against a real local server, so split the logic: a **pure exported classifier** covered exhaustively, plus a **real-server test** for the 401 path (the existing `credential-proxy.test.ts` already starts a real server for the egress-allowlist tests — reuse that harness), plus a **pure attribution test** proving the token beats the header.

Append to `src/credential-proxy.test.ts`:

```ts
import { isLoopbackSource, resolveProxyIdentity } from './credential-proxy.js';
import { mintContainerToken, _resetForTest } from './container-identity.js';

describe('isLoopbackSource', () => {
  it.each([
    ['127.0.0.1', true],
    ['::1', true],
    ['::ffff:127.0.0.1', true],
    ['192.168.64.7', false],
    ['130.127.162.99', false],
    [undefined, false],
  ])('isLoopbackSource(%s) === %s', (addr, expected) => {
    expect(isLoopbackSource(addr as string | undefined)).toBe(expected);
  });
});

describe('resolveProxyIdentity', () => {
  beforeEach(() => _resetForTest());

  it('resolves the group from the token', () => {
    const t = mintContainerToken('ag_alice', 'sess_1');
    expect(resolveProxyIdentity({ 'x-nanoclaw-agent-token': t })).toEqual({
      agentGroupId: 'ag_alice',
      sessionId: 'sess_1',
    });
  });

  it('ignores a spoofed agent-group header — the token wins', () => {
    const t = mintContainerToken('ag_alice', 'sess_1');
    const id = resolveProxyIdentity({ 'x-nanoclaw-agent-token': t, 'x-nanoclaw-agent-group': 'ag_bob' });
    expect(id!.agentGroupId).toBe('ag_alice'); // NOT ag_bob
  });

  it('returns null with no token, even when a group header is present', () => {
    expect(resolveProxyIdentity({ 'x-nanoclaw-agent-group': 'ag_bob' })).toBeNull();
  });

  it('returns null for an unknown token', () => {
    expect(resolveProxyIdentity({ 'x-nanoclaw-agent-token': 'deadbeef' })).toBeNull();
  });
});
```

And one real-server case, written in the style of the existing egress tests in that file (which already know how to start the proxy and issue a request against it). A request over loopback with no token must **not** 401 — that is the host-internal `direct-chat` path, and it is the regression this plan is most likely to cause:

```ts
it('allows a loopback request with no token (host-internal caller)', async () => {
  const res = await postToProxy('/openai/v1/chat/completions', {});   // existing helper in this file
  expect(res.status).not.toBe(401);
});
```

If the existing file names that helper differently, use its name — do not add a second harness.

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm exec vitest run src/credential-proxy.test.ts`
Expected: FAIL — `isLoopbackSource` not exported; no 401 path exists.

- [ ] **Step 3: Implement**

In `src/credential-proxy.ts`, add next to `AGENT_GROUP_HEADER` (~line 171):

```ts
const AGENT_TOKEN_HEADER = 'x-nanoclaw-agent-token';
```

Add the import:

```ts
import { resolveContainerToken, type ContainerIdentity } from './container-identity.js';
```

Add the two exported pure functions the tests call:

```ts
/** True for host-internal callers (e.g. direct-chat dispatching to 127.0.0.1). */
export function isLoopbackSource(remoteAddress: string | undefined): boolean {
  return remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1';
}

/** The calling container's identity, from its token only. Never from the group header. */
export function resolveProxyIdentity(
  headers: Record<string, string | string[] | undefined>,
): ContainerIdentity | null {
  const raw = headers[AGENT_TOKEN_HEADER];
  return resolveContainerToken(typeof raw === 'string' ? raw : null);
}
```

Replace the attribution block (~lines 535-541) — the comment there still describes the old, trusting design, so replace it too:

```ts
        // Per-call attribution. The agent group is derived from the
        // per-container token, never from a caller-supplied group header:
        // any container can set a header, so trusting it let one user's
        // agent spend another user's credentials.
        //
        // Loopback callers are host-internal (e.g. direct-chat) and get the
        // department .env credential, as before. Everything else — every
        // container, and anything on the LAN — must present a valid token.
        const identity = resolveProxyIdentity(req.headers);
        const loopback = isLoopbackSource(req.socket.remoteAddress);

        if (!identity && !loopback) {
          log.warn('credential-proxy: rejected unauthenticated non-loopback request', {
            src: req.socket.remoteAddress,
            hasToken: !!req.headers[AGENT_TOKEN_HEADER],
          });
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'container token required' }));
          return;
        }

        const agentGroupId = identity?.agentGroupId ?? null;
```

Derive the payload-log session id from the token too, replacing the `SESSION_ID_HEADER` read (~line 570):

```ts
        const sessionId = identity?.sessionId ?? 'unattributed';
```

Keep stripping both internal headers before forwarding upstream (~lines 602-604) and add the token to that list:

```ts
        delete headers[AGENT_TOKEN_HEADER];
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run src/credential-proxy.test.ts`
Expected: PASS, including the pre-existing egress-allowlist tests.

- [ ] **Step 5: Full suite, typecheck, commit**

```bash
pnpm test && pnpm run build
git add -A
git commit -m "fix(proxy): derive agent group from container token, reject unauthenticated non-loopback (C5)

The x-nanoclaw-agent-group header was set by the container itself, so any
agent could have another user's OAuth token attached to its upstream call;
with no header at all, any host on the LAN could spend the department key."
```

### Task 6: GWS relay resolves identity from the token and authorizes (fixes C7)

**Files:**
- Modify: `src/gws-mcp-relay.ts` (`readAgentGroupHeader` ~line 63; the handler ~lines 78-107)
- Create: `src/gws-mcp-relay.authz.test.ts`

**Interfaces:**
- Consumes: `resolveContainerToken(token)` (Task 3); the `x-nanoclaw-agent-token` header (Task 4); `canAccessAgentGroup(userId, agentGroupId)`.
- Produces: the relay dispatches only with a token-derived `ctx.agentGroupId`.

**On the `canAccessAgentGroup` check.** The relay's caller is a *container*, not a user, so there is no `userId` to pass. The correct control here is simply that the group id is token-derived and therefore unforgeable — which is what makes the existing per-group token lookup in `gws-token.ts` safe. Do **not** invent a synthetic user id to satisfy the old comment. Task 4 already rewrote that comment to describe this design.

- [ ] **Step 1: Write the failing test**

Create `src/gws-mcp-relay.authz.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveRelayIdentity } from './gws-mcp-relay.js';
import { mintContainerToken, _resetForTest } from './container-identity.js';

beforeEach(() => _resetForTest());

describe('relay identity resolution', () => {
  it('resolves the group from the token', () => {
    const t = mintContainerToken('ag_alice', 'sess_1');
    expect(resolveRelayIdentity({ 'x-nanoclaw-agent-token': t })).toBe('ag_alice');
  });

  it('ignores a spoofed group header', () => {
    const t = mintContainerToken('ag_alice', 'sess_1');
    expect(resolveRelayIdentity({ 'x-nanoclaw-agent-token': t, 'x-nanoclaw-agent-group': 'ag_bob' })).toBe('ag_alice');
  });

  it('returns null with no token, even when a group header is present', () => {
    expect(resolveRelayIdentity({ 'x-nanoclaw-agent-group': 'ag_bob' })).toBeNull();
  });

  it('returns null for an unknown token', () => {
    expect(resolveRelayIdentity({ 'x-nanoclaw-agent-token': 'deadbeef' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm exec vitest run src/gws-mcp-relay.authz.test.ts`
Expected: FAIL — `resolveRelayIdentity` is not exported.

- [ ] **Step 3: Implement**

In `src/gws-mcp-relay.ts`, replace `readAgentGroupHeader` with an exported, token-based resolver:

```ts
import { resolveContainerToken } from './container-identity.js';

/**
 * The calling container's agent group, derived from its per-container token.
 * The `x-nanoclaw-agent-group` header is NOT trusted: the container sets it
 * itself, so honoring it let any agent operate on any other user's Google
 * account. Exported for tests.
 */
export function resolveRelayIdentity(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers['x-nanoclaw-agent-token'];
  const token = typeof raw === 'string' ? raw : null;
  return resolveContainerToken(token)?.agentGroupId ?? null;
}
```

In the handler (~line 81), replace the header read and its 401:

```ts
    const agentGroupId = resolveRelayIdentity(req.headers);
    if (!agentGroupId) {
      return send(res, 401, { ok: false, error: 'Missing or invalid X-NanoClaw-Agent-Token.' });
    }
```

Keep the existing `getAgentGroup(agentGroupId)` existence check that follows it.

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run src/gws-mcp-relay.authz.test.ts`
Expected: PASS, 4/4.

- [ ] **Step 5: Full suite, typecheck, commit**

```bash
pnpm test && pnpm run build
git add -A
git commit -m "fix(gws-relay): derive agent group from container token (C7)

The relay authenticated by a container-set header, so a prompt-injected
agent could read another user's Gmail/Drive by naming their group id."
```

### Task 7: Scope `ncl` reads to the caller's group (fixes C6)

**Files:**
- Modify: `src/cli/crud.ts` (`genericList` ~lines 101-132, `genericGet`)
- Modify: `src/cli/dispatch.ts` (~line 21, where `ctx.caller` is checked)
- Create: `src/cli/scope.test.ts`

**Interfaces:**
- Consumes: the dispatch context, which already carries a trustworthy `caller: 'host' | 'agent'` and `agentGroupId` stamped host-side from the session the request arrived on (`src/cli/delivery-action.ts:29-32`) — a container **cannot** forge which group it is.
- Produces: when `ctx.caller === 'agent'`, `list`/`get` return only rows belonging to `ctx.agentGroupId`. Host callers (the `ncl` Unix socket) are unrestricted.

**Why this is the linchpin.** `ncl groups list` from inside any container returns every group's random `ag_<hex>` id. That is the discovery primitive that makes the (now-fixed) proxy and relay spoofs *targeted* rather than blind. Fixing it also stops cross-tenant disclosure of user handles, phone numbers, emails, and sessions in its own right.

Also: `container_configs.cli_scope` (migration `018-cli-scope.ts`, default `'group'`) is stored, displayed, and settable, but **never read**. This task gives it its meaning: `'group'` (default) → scoped as above; `'all'` → unrestricted, for a future trusted admin agent. Read it in `dispatch.ts`; do not add a new column.

- [ ] **Step 1: Write the failing test**

Create `src/cli/scope.test.ts`:

```ts
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { initTestDb, closeDb, runMigrations, getDb } from '../db/index.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { scopeRowsToCaller } from './crud.js';

const NOW = '2026-07-09T00:00:00Z';

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
  createAgentGroup({ id: 'ag_alice', name: 'Alice', folder: 'user_alice', agent_provider: 'pi', created_at: NOW, metadata: '{}' });
  createAgentGroup({ id: 'ag_bob', name: 'Bob', folder: 'user_bob', agent_provider: 'pi', created_at: NOW, metadata: '{}' });
});
afterEach(() => closeDb());

const rows = [{ id: 'ag_alice' }, { id: 'ag_bob' }];

describe('scopeRowsToCaller', () => {
  it('returns every row for a host caller', () => {
    expect(scopeRowsToCaller(rows, { caller: 'host', agentGroupId: null }, 'id')).toHaveLength(2);
  });

  it('returns only the caller group row for an agent caller', () => {
    const out = scopeRowsToCaller(rows, { caller: 'agent', agentGroupId: 'ag_alice' }, 'id');
    expect(out).toEqual([{ id: 'ag_alice' }]);
  });

  it('returns nothing for an agent caller with no group', () => {
    expect(scopeRowsToCaller(rows, { caller: 'agent', agentGroupId: null }, 'id')).toEqual([]);
  });

  it('scopes by the named column when it is not "id"', () => {
    const wirings = [{ agent_group_id: 'ag_alice' }, { agent_group_id: 'ag_bob' }];
    const out = scopeRowsToCaller(wirings, { caller: 'agent', agentGroupId: 'ag_bob' }, 'agent_group_id');
    expect(out).toEqual([{ agent_group_id: 'ag_bob' }]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm exec vitest run src/cli/scope.test.ts`
Expected: FAIL — `scopeRowsToCaller` not exported from `crud.ts`.

- [ ] **Step 3: Implement the filter and apply it**

Add to `src/cli/crud.ts`:

```ts
/**
 * Restrict CRUD read results to what the caller may see.
 *
 * `ncl` runs at host authority. An agent caller reaches it from inside a
 * container, so an unscoped `list` handed every tenant's group ids, user
 * handles, and sessions to any agent — including the group ids needed to
 * target other users elsewhere. The host stamps the true caller group
 * (delivery-action.ts), so scoping here is sound.
 *
 * `scopeColumn` is the property on each row that names its agent group.
 */
export function scopeRowsToCaller<T extends Record<string, unknown>>(
  rows: T[],
  ctx: { caller: 'host' | 'agent'; agentGroupId: string | null },
  scopeColumn: string,
): T[] {
  if (ctx.caller === 'host') return rows;
  if (!ctx.agentGroupId) return [];
  return rows.filter((r) => r[scopeColumn] === ctx.agentGroupId);
}
```

Apply it at the end of `genericList` and, for `genericGet`, return `null`/not-found when the single row fails the same predicate.

Each resource must declare its scope column. In `src/cli/resources/*.ts`, add a `scopeColumn` field to the resource definition: `'id'` for `groups`, `'agent_group_id'` for `wirings`, `members`, `destinations`, `sessions`. For resources with **no** agent-group column — `users`, `messaging-groups`, `user-dms`, `dropped-messages`, `roles`, `approvals` — an agent caller has no legitimate cross-tenant read: mark them `scopeColumn: null` and have `genericList`/`genericGet` return `[]` / not-found for `caller === 'agent'` (host `ncl` is unaffected). Read each resource file and set this explicitly; do not guess.

In `src/cli/dispatch.ts`, read `cli_scope` from the caller group's `container_configs` row and skip scoping when it is `'all'`:

```ts
  const scope = ctx.caller === 'agent' ? (getContainerConfig(ctx.agentGroupId!)?.cli_scope ?? 'group') : 'all';
```

Pass `scope` down so `scopeRowsToCaller` is bypassed when `scope === 'all'`.

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run src/cli/scope.test.ts`
Expected: PASS, 4/4.

- [ ] **Step 5: Verify the real path end-to-end**

The unit test does not prove the wiring. Confirm the host `ncl` still sees everything:

```bash
./bin/ncl groups list
```
Expected: all three groups (`_default_participant`, `owner_01`, `user_01`) — host callers are unrestricted.

- [ ] **Step 6: Full suite, typecheck, commit**

```bash
pnpm test && pnpm run build
git add -A
git commit -m "fix(cli): scope ncl reads to the caller agent group (C6)

Any container could run 'ncl groups list' at host authority and enumerate
every tenant's group ids, users, and sessions — the discovery primitive for
the proxy and relay spoofs. Gives the stored-but-unread cli_scope its meaning."
```

### Task 8: Enforce spend limits on `direct-chat` (fixes H1, H2)

**Files:**
- Create: `src/modules/budgets/enforce.ts`
- Create: `src/modules/budgets/enforce.test.ts`
- Modify: `src/channels/playground/api/direct-chat.ts` (~line 284)
- Modify: `src/channels/playground/api-routes.ts` (the `/api/direct-chat` route, ~lines 774, 780)

**Interfaces:**
- Consumes, with these exact real signatures (verified against the file — do not guess):
  - `readCostBudgets(): CostBudgets` — `cost-budgets.ts:22`
  - `budgetForAgent(folder: string, cfg: CostBudgets): number | null` — `:43` (note: keyed by **folder**, not group id)
  - `evaluateBudget(costUsd: number, budgetUsd: number | null, warnFraction: number): { status: 'none' | 'ok' | 'warn' | 'over'; costUsd: number; budgetUsd: number | null; fraction: number | null }` — `:48`
  - `aggregateAgentUsage(agentGroupId: string): { thisMonth: UsageBucket; total: UsageBucket }` — `usage.ts:71`. Read `UsageBucket` and use its dollar field; do not assume its name.
  Today none of these has an enforcement caller — that is the bug.
- Produces: `assertWithinBudget(folder: string, agentGroupId: string): { ok: true } | { ok: false; reason: string }`.

Two independent holes on one route: the `model` parameter is never checked against the allowlist, and `agentFolder` is optional so `canReadDraft` is skipped entirely. Either lets a signed-in user drain the department key.

- [ ] **Step 1: Write the failing test**

Create `src/modules/budgets/enforce.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../channels/playground/api/cost-budgets.js', () => ({
  readCostBudgets: () => ({ defaultMonthlyUsd: 10, perAgent: { user_free: null }, warnFraction: 0.8 }),
  budgetForAgent: (folder: string, cfg: { perAgent: Record<string, number | null>; defaultMonthlyUsd: number | null }) =>
    folder in cfg.perAgent ? cfg.perAgent[folder] : cfg.defaultMonthlyUsd,
  evaluateBudget: (costUsd: number, budgetUsd: number | null) =>
    budgetUsd == null
      ? { status: 'none' as const, costUsd, budgetUsd, fraction: null }
      : { status: (costUsd >= budgetUsd ? 'over' : 'ok') as 'over' | 'ok', costUsd, budgetUsd, fraction: costUsd / budgetUsd },
}));

vi.mock('../../channels/playground/api/usage.js', () => ({
  aggregateAgentUsage: (agentGroupId: string) => ({
    thisMonth: { costUsd: agentGroupId === 'ag_over' ? 99 : 1 },
    total: { costUsd: 0 },
  }),
}));

import { assertWithinBudget } from './enforce.js';

describe('assertWithinBudget', () => {
  it('allows a group with no configured budget', () => {
    expect(assertWithinBudget('user_free', 'ag_free')).toEqual({ ok: true });
  });

  it('allows a group under its limit', () => {
    expect(assertWithinBudget('user_alice', 'ag_alice')).toEqual({ ok: true });
  });

  it('denies a group over its limit', () => {
    const r = assertWithinBudget('user_over', 'ag_over');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/budget/i);
  });
});
```

Before running: open `usage.ts` and confirm `UsageBucket`'s dollar field really is `costUsd`. If it is named differently, fix the mock **and** the implementation — a mock that invents a field name produces a false green, which is exactly the failure mode the review flagged in this codebase.

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm exec vitest run src/modules/budgets/enforce.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `assertWithinBudget`**

Create `src/modules/budgets/enforce.ts`:

```ts
/**
 * The enforcement call site that cost budgets never had.
 *
 * `readCostBudgets` / `budgetForAgent` / `evaluateBudget` existed and were
 * rendered in the UI, but nothing ever *stopped* a turn — a configured cap
 * enforced nothing. This is that check. Budgets are keyed by folder; spend
 * is aggregated by agent group id, so both are needed.
 */
import { readCostBudgets, budgetForAgent, evaluateBudget } from '../../channels/playground/api/cost-budgets.js';
import { aggregateAgentUsage } from '../../channels/playground/api/usage.js';

export type BudgetVerdict = { ok: true } | { ok: false; reason: string };

export function assertWithinBudget(folder: string, agentGroupId: string): BudgetVerdict {
  const cfg = readCostBudgets();
  const budgetUsd = budgetForAgent(folder, cfg);
  if (budgetUsd == null) return { ok: true };

  const spentUsd = aggregateAgentUsage(agentGroupId).thisMonth.costUsd;
  const verdict = evaluateBudget(spentUsd, budgetUsd, cfg.warnFraction);
  if (verdict.status === 'over') {
    return { ok: false, reason: `Monthly budget exceeded ($${spentUsd.toFixed(2)} of $${budgetUsd.toFixed(2)}).` };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Enforce on the route**

In `src/channels/playground/api-routes.ts`, in the `/api/direct-chat` handler, before dispatching:

```ts
    const folder = String(body.agentFolder ?? '');
    const denied = requireGroupAccess(folder, session.userId);
    if (denied) return send(res, 403, { error: 'Forbidden' });

    const group = getAgentGroupByFolder(folder)!;   // requireGroupAccess proved it exists
    const budget = assertWithinBudget(folder, group.id);
    if (!budget.ok) return send(res, 429, { error: budget.reason });
```

`agentFolder` becomes **required** — if it is absent, return 400. That is the fix for the "optional folder skips the check" hole; a chat turn always belongs to some group.

In `src/channels/playground/api/direct-chat.ts` (~line 284), validate the requested model against the allowlist the UI already reads (`api/models.ts` / `allowed_models` on the group's `container_configs`), returning an error for anything not on it. Read those modules and reuse their accessor; do not duplicate the list.

- [ ] **Step 5: Run the tests**

Run: `pnpm exec vitest run src/modules/budgets/enforce.test.ts && pnpm test`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm run build
git add -A
git commit -m "fix(direct-chat): require agentFolder, enforce model allowlist and budget (H1, H2)

Budgets were display-only: evaluateBudget had no enforcement caller. The
model parameter bypassed the allowlist and the optional agentFolder skipped
authorization, so any signed-in user could drain the department key."
```

### Task 9: Close the deployment posture (fixes H6; retires the auth bypass)

**Files:**
- Modify: `.env` (mode + two values) — **not** committed; `.env` is gitignored.
- Modify: `config/playground-seats.json` (seat password)
- Modify: `docs/superpowers/plans/2026-07-09-dept-server-plan-1-freeze-and-clean-base.md` (Plan 3 line: the auth-posture item moves here, done)
- Modify: `state.md` (Current arc + Decision log)

**Interfaces:**
- Consumes: Tasks 1–8 landed and green. Turning the bypass off with C1–C4 unfixed would only *hide* them behind authentication.

The bypass masks nothing after Task 2 — `requireGroupAccess` ignores it by design — but it is still an unauthenticated admin seat on a campus network.

- [ ] **Step 1: Tighten `.env` permissions**

```bash
chmod 600 .env
stat -f '%A %N' .env
```
Expected: `600 .env`.

- [ ] **Step 2: Turn off the bypass and set a real seat password**

In `.env`, set `PLAYGROUND_AUTH_BYPASS=0`.

In `config/playground-seats.json`, replace `"password": ""` with a strong random value:

```bash
openssl rand -base64 24
```
Paste the output as the `password` value. **Do not** paste it into any commit message, log, or chat.

- [ ] **Step 3: Rebuild, restart, verify the gates hold live**

```bash
pnpm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-581fefa4
sleep 5
tail -20 logs/nanoclaw.error.log
```
Expected: clean boot, no errors.

Then, in a browser at `http://gcworkflow.clemson.edu:8088` (never `127.0.0.1` — the playground binds localhost-only and this box is headless):
1. The seat picker now demands the password. Enter it; claim the Owner seat.
2. Send one chat message; a reply arrives. **This proves Tasks 4–6 did not break the container's access to the proxy** — the single most likely regression in this plan.
3. Open devtools; confirm no 401/403 storm on normal use.

If the container cannot reach the proxy, the token is not flowing: check `container inspect` for `X_NANOCLAW_AGENT_TOKEN` in the env, and `logs/nanoclaw.log` for `rejected unauthenticated non-loopback request`.

- [ ] **Step 4: Enable the host firewall (defense in depth)**

The proxy and relay now fail closed for unauthenticated non-loopback callers, so the wide bind is no longer exploitable. Close the port anyway:

```bash
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate on
/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate
```
Expected: `Firewall is enabled. (State = 1)`.

Re-run the Step 3 chat check afterward — the firewall must not block the bridge. If it does, revert with `--setglobalstate off` and record it as a follow-up rather than leaving the box unusable.

- [ ] **Step 5: Update the plan docs and state.md, then commit**

In the Plan 1 roadmap, strike the "revert dev auth posture" clause from the Plan 3 line and note it landed in Plan 1.5. In `state.md`, replace the tracked auth-posture item under **Current arc** with a completion note, and append one **Decision log** entry dated 2026-07-09: identity is now server-derived (per-container token) at the proxy, the relay, and `ncl`; every folder-addressed mutation route is gated by `requireGroupAccess`; auth bypass retired.

```bash
git add config/playground-seats.json state.md docs/superpowers/plans/2026-07-09-dept-server-plan-1-freeze-and-clean-base.md
git commit -m "chore(security): retire auth bypass, seat password, .env 0600, firewall on"
git push origin main
```

### Task 10: Verify the whole isolation story end-to-end

A green unit suite is not proof that a *user* cannot reach another user's data. Exercise it.

**Files:**
- Create: `docs/superpowers/reviews/2026-07-09-isolation-verification.md` (the evidence record)

**Interfaces:**
- Consumes: everything above, deployed and running.

- [ ] **Step 1: Create a second real user and agent group**

Use `./bin/ncl` (NOT the global `ncl`, which points at the personal install):

```bash
./bin/ncl groups create --name "Test Bob" --folder user_bob
./bin/ncl users create --id playground:bob --kind playground --display-name Bob
./bin/ncl members add --user-id playground:bob --agent-group-id <ag_bob_id>
```

Add a `user_bob` seat to `config/playground-seats.json`, and set `container_configs.provider = 'pi'` for the new group — **the fresh-group footgun from Plan 1**: without it the container dies at startup with a misleading `Module not found /app/src/index.ts`.

- [ ] **Step 2: Prove the web gate holds**

Sign in as Bob (his seat). With his session cookie, attempt each of these against the **owner's** folder, and record the status:

```
PUT    /api/drafts/owner_01/persona
POST   /api/drafts/owner_01/messages
PUT    /api/drafts/owner_01/active-model
POST   /api/drafts  {"targetFolder":"owner_01"}
```
Expected: **403** on all four. Before this plan, all four succeeded.

Then confirm Bob can still do each of those against `user_bob`. A gate that blocks everything is not a fix.

- [ ] **Step 3: Prove the proxy gate holds**

From the host, unauthenticated, simulating a LAN attacker (this is your own box; do not point it at anything else):

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://192.168.64.1:3001/openai/v1/chat/completions \
  -H 'content-type: application/json' -H 'authorization: Bearer placeholder' \
  -d '{"model":"gpt-5.4-mini","messages":[{"role":"user","content":"hi"}],"max_completion_tokens":4}'
```
Expected: **401**. (Before this plan: 200 with a completion, billed to the department key.)

- [ ] **Step 4: Prove the `ncl` gate holds**

From inside a running container (`container exec <name> bash`), run:

```bash
ncl groups list
```
Expected: only that container's own group. Before this plan: every group, with ids.

- [ ] **Step 5: Record the evidence and commit**

Write `docs/superpowers/reviews/2026-07-09-isolation-verification.md` with, for each of Steps 2–4, the exact command/request, the observed result, and the pre-fix behavior from the review. This file is what lets a future session trust that the fixes are real rather than merely committed.

Delete the `user_bob` test group and seat afterward (or keep it as the first pilot seat — say which in the doc).

```bash
git add docs/superpowers/reviews/2026-07-09-isolation-verification.md config/playground-seats.json
git commit -m "docs(review): isolation verification evidence — web, proxy, and ncl gates confirmed live"
git push origin main
```

---

## On C8 (no container network isolation) — mitigated here, not fixed

The review's C8 is that `buildContainerArgs` passes no `--network` restriction, so every container can reach the host gateway, peer containers, and the LAN; the agent's shell bypasses `fetch_url`'s SSRF guard entirely.

This plan **removes C8's value as an attack enabler** without restricting the network: after Tasks 5–7, reaching `:3001` and `:3007` buys nothing without a valid per-container token, and `ncl` no longer discloses other groups. What remains is container→container and container→LAN reachability, which matters only if some *other* service on this box or network trusts an unauthenticated caller. That is worth closing, but it is a runtime/networking change (Apple Container network modes) that risks breaking the agent's legitimate egress, and it should be done deliberately — **schedule it with the Apple Container 0.12.3 → 1.1.0 upgrade in Plan 2**, where the runtime is already being touched and can be re-verified in one window. Task 9's firewall step covers the LAN direction in the meantime.

Do not attempt a network-mode change inside this plan. It would couple a security fix that can be verified by unit tests to a runtime change that can only be verified by live container traffic.

## Out of scope (deliberately deferred)

- **Renames** of `class-*` / `classroom-*` files — Plans 3–5.
- **Architectural splits** (`api-routes.ts` 1,205 LOC / 72 routes; `credential-proxy.ts` 871 LOC; identity unified on the `users` table) — these are real, and the review recommends doing them *before* Plans 3–5 land new routes and auth flows in the same files. They are refactors, not security fixes; keeping them out keeps this plan reviewable.
- **Correctness bugs H3/H4/H5** (pi errors never reaching users; follow-ups acked before processing; `writeOutboundDirect` seq-parity violation) — Plan 2, alongside the pi-harness reconciliation that touches the same files.
- **Performance** (pi transcript rotation, usage-aggregation caching, per-open `PRAGMA`, container CPU caps) — post-pilot; none of it gates a colleague using the system.
- **Medium security items** (magic-link 1h replay + missing `Secure` cookie; shared `/var/www/sites` RW mount; PIN email bomb) — fold into Plan 3, which rewrites the auth and invite surface anyway. Note the magic-link finding matters *more* once the bypass is off, so it should not slip past Plan 3.
- `container/agent-runner`'s Bun dependencies have no release-age policy and were never pin-audited; `pnpm audit --prod` was never run to completion. Worth one task in Plan 2.
