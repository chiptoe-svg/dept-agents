# Plan 4: Provider Auth & Backstop

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each department colleague connect their own ChatGPT (Codex OAuth) so their agent's usage bills to *them*, with the department OpenAI key as an automatic backstop — and record when a turn runs on the backstop so the operator can see it.

**Architecture:** The per-user credential + Codex OAuth + paste-back infrastructure already exists and has a live stored credential (`data/user-provider-creds/*/codex.json`); the credential proxy already calls a `userCredsHook` (`resolveUserCreds`) per request. Plan 4 (1) rewires `resolveUserCreds` off the empty `classroom_roster` onto the real entity model (`agent_group_members` → user), (2) simplifies the policy to "the user's own creds if present, else the department `.env` key" — connect is *optional*, never a hard block, (3) records each backstop fallback, and (4) mounts the session-gated "connect your ChatGPT" endpoints that already exist but aren't wired into the router. Because the Codex OAuth flow piggybacks on OpenAI's public Codex CLI OAuth client (localhost-ephemeral redirect), there is **no external OAuth-app registration to do**.

**Tech Stack:** Node 22 + TypeScript host (`pnpm run build` = tsc, `pnpm test` = vitest); the credential proxy (`src/credential-proxy.ts`) with its `userCredsHook`; `@earendil-works/pi-ai/oauth` (container-side Codex OAuth); launchd service `com.nanoclaw-v2-581fefa4`.

## Decisions (settled 2026-07-10, do not relitigate)

| Decision | Choice |
|---|---|
| Connect method | **Full ChatGPT/Codex OAuth.** A colleague clicks "Connect ChatGPT", does the OAuth flow, and their subscription covers their usage. The flow + storage already exist (`provider-auth.ts`, `data/user-provider-creds/`); no external OAuth-app registration (uses OpenAI's Codex CLI client). |
| Backstop warning | **Emit the event now; homepage banner is Plan 5.** Plan 4 records when a turn falls back to the department key (a queryable per-group signal + structured log). The user-facing "running on the department account — connect your ChatGPT" banner is built with the rest of the homepage in Plan 5. |
| Connect is optional | The department key is an automatic backstop; an unconnected user's agent works immediately. The old classroom `connect_required` / `forbidden` hard-block is removed — there is no class-controls policy on the department server. |

## Scope boundary — what this plan does NOT do

- **The full `classroom_roster` table drop is deferred to Plan 5's cleanup pass.** `classroom_roster` is referenced in 15 files, several in the login/PIN/Telegram auth paths that Plan 3 just stabilized. Plan 4 stops the *credential resolver* from using it (Task 1) but does not delete the table or sweep the other 14 references — that risky churn belongs with the `class-*` renames in Plan 5, not adjacent to this auth-critical rewire. `class-controls` (Task 4) IS removed here because it is cleanly decoupled and only the resolver + `pi.ts` + `owner-creds-ready.ts` touch it.

## Global Constraints

- Working directory `/Users/admin/projects/nanoclaw`. Never touch `/Users/admin/projects/nanoclaw_personal`.
- Run `pnpm run build` (tsc) after every change and read the output — vitest tolerates TS errors tsc rejects. Run `pnpm test` (green at HEAD — keep it).
- **Do not regress Plan 1.5 / 2 / 3.** The credential proxy derives the caller's agent group from the per-container token (`resolveProxyIdentity`), never a header; the proxy budget gate (Plan 2) and `requireGroupAccess` (Plan 1.5) stay intact; per-user login (Plan 3) stays working. `PLAYGROUND_AUTH_BYPASS=0` — do not re-enable it.
- **Never read, print, echo, or copy `.env` contents. Never print an OAuth token, refresh token, or API key** — into a commit, a log, the ledger, or a test fixture. Per-user creds live in `data/user-provider-creds/<userId>/<provider>.json`; treat them as secrets.
- The credential proxy's identity is token-derived: `resolveUserCreds(agentGroupId, providerId)` receives the **agent group id**, and must resolve the owning user from it server-side. Never trust a user id from the request.
- Repo-local CLI is `./bin/ncl`. The global `ncl` targets the OTHER install.
- Ad-hoc DB queries: `pnpm exec tsx scripts/q.ts <db> "<sql>"` — never the `sqlite3` CLI.
- Vitest writes fixture dirs into the live `groups/`. Compare `ls groups/` before/after; delete anything new that is not `_default_participant`, `owner_01`, `user_01`.
- Every commit message ends, after a blank line, with:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01WXUAU8TQduy8SMSVWoNYvn
  ```

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/user-provider-resolver.ts` | Rewire `resolveUserCreds`: agent-group→user via the entity model; drop `classId`/class-controls; connect-optional; signal backstop fallback. | 1 |
| `src/provisioning/agent-group-user.ts` | **New (small).** `userIdForAgentGroup(agentGroupId): string | null` — the group's member, via `agent_group_members`. Shared, testable. | 1 |
| `src/backstop-usage.ts` | **New.** Record + read "this group's last request ran on the department backstop" (a small DB table or `container_configs`/metadata field). | 2 |
| `src/channels/playground/api-routes.ts` | Mount the session-gated provider-auth connect/exchange/status routes. | 3 |
| `src/owner-creds-ready.ts`, `src/providers/pi.ts` | Rewire off `readClassControls`. | 4 |
| `src/channels/playground/api/class-controls.ts`, `config/class-controls.json` | Delete. | 4 |

---

### Task 1: Rewire `resolveUserCreds` to the entity model, connect-optional

**Why:** `resolveUserCreds` (`src/user-provider-resolver.ts:165`) resolves the user via `rosterLookup(agentGroupId)`, which queries the empty `classroom_roster` — so it returns `null` for every department agent and everyone silently runs on the department `.env` key. It also consults `class-controls` for a per-class allow/connect_required/provideDefault policy the department server has no use for. This task makes it resolve the real user (so a connected colleague's own creds are actually used) and reduces the policy to "own creds, else backstop."

**Files:**
- Create: `src/provisioning/agent-group-user.ts` + `.test.ts`
- Modify: `src/user-provider-resolver.ts`
- Test: `src/user-provider-resolver.test.ts`

**Interfaces:**
- Produces: `userIdForAgentGroup(agentGroupId: string): string | null` — the `user_id` from `agent_group_members` for this group (a provisioned group has exactly one member; if several, the earliest by `added_at`). `null` if none.
- Produces: `resolveUserCreds(agentGroupId, providerId)` unchanged **signature**, but new behavior: resolve user via `userIdForAgentGroup`; if the user has valid own creds for `providerId` (apiKey or OAuth, refreshing OAuth as today), return them; otherwise return `null` (the proxy's existing fallback attaches the department `.env` credential) **and** record the backstop (Task 2 wires the recorder — in this task, call a hook that defaults to a no-op so this task stands alone). **No** `class-controls` read, **no** `forbidden`/`connect_required`/`provideDefault` branches.

- [ ] **Step 1: `userIdForAgentGroup` — failing test first**

Create `src/provisioning/agent-group-user.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initTestDb, closeDb, runMigrations, getDb } from '../db/index.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { createUser } from '../modules/permissions/db/users.js';
import { addMember } from '../modules/permissions/db/agent-group-members.js';
import { userIdForAgentGroup } from './agent-group-user.js';

const NOW = '2026-07-10T00:00:00Z';
beforeEach(() => {
  initTestDb(); runMigrations(getDb());
  createUser({ id: 'playground:alice', kind: 'playground', display_name: 'Alice', created_at: NOW });
  createAgentGroup({ id: 'ag_alice', name: 'Alice', folder: 'user_alice', agent_provider: 'pi', created_at: NOW, metadata: '{}' });
  addMember({ user_id: 'playground:alice', agent_group_id: 'ag_alice', added_by: null, added_at: NOW });
  createAgentGroup({ id: 'ag_empty', name: 'Empty', folder: 'user_empty', agent_provider: 'pi', created_at: NOW, metadata: '{}' });
});
afterEach(() => closeDb());

describe('userIdForAgentGroup', () => {
  it('returns the group’s member', () => { expect(userIdForAgentGroup('ag_alice')).toBe('playground:alice'); });
  it('returns null for a group with no member', () => { expect(userIdForAgentGroup('ag_empty')).toBeNull(); });
  it('returns null for an unknown group', () => { expect(userIdForAgentGroup('ag_nope')).toBeNull(); });
});
```

- [ ] **Step 2: Run it, watch it fail; implement**

Run: `pnpm exec vitest run src/provisioning/agent-group-user.test.ts` → FAIL (module not found).

Create `src/provisioning/agent-group-user.ts`:

```ts
import { getDb } from '../db/connection.js';

/**
 * The user who owns a playground agent group — the department entity model's
 * answer to "whose credentials should this group's requests use". A provisioned
 * group (see provisionUser) has exactly one member; if there are several, the
 * earliest-added wins. Returns null for a memberless or unknown group.
 */
export function userIdForAgentGroup(agentGroupId: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT user_id FROM agent_group_members WHERE agent_group_id = ? ORDER BY added_at ASC LIMIT 1`,
    )
    .get(agentGroupId) as { user_id: string } | undefined;
  return row?.user_id ?? null;
}
```

Run again → PASS.

- [ ] **Step 3: Rewire `resolveUserCreds` — failing test first**

Read `src/user-provider-resolver.ts:120-210` fully — note there is a **"sibling creds" branch (~line 130-160)** before the main path that lets a user's stored API key for one provider satisfy a request for a sibling provider (e.g. an OpenAI key covering `openai-codex`). Decide deliberately: keep the sibling-creds behavior (it still helps a user who pasted one key), but it must key off `userIdForAgentGroup`, not `rosterLookup`. Do NOT silently drop it. State what you did with the sibling branch. Also note: the proxy still *understands* `forbidden`/`connect_required` shapes (`credential-proxy.ts:60-71`) — after this task the resolver simply never returns them, so the proxy's handling becomes harmless dead branches; do NOT delete them (out of scope).

Then in `src/user-provider-resolver.test.ts` add cases (mock `loadUserProviderCreds` / the OAuth refresher per the file's existing test setup, and seed a real `agent_group_members` row):

```ts
// a user WITH valid own creds → returns them (kind 'apiKey' or 'oauth')
// a user with NO own creds → returns null (proxy will use the .env backstop)
// a memberless group → returns null (backstop)
// NO branch ever returns { kind: 'forbidden' } or { kind: 'connect_required' }
```
Assert explicitly that the result is never `forbidden`/`connect_required` for any input, and that a no-creds user yields `null` (not a policy object).

- [ ] **Step 4: Run it, watch the class-controls behavior fail; implement**

Rewrite `resolveUserCreds`:

```ts
import { userIdForAgentGroup } from './provisioning/agent-group-user.js';

// Recorder hook — Task 2 installs the real one; defaults to no-op so this
// module has no hard dependency on the backstop store.
let recordBackstop: (agentGroupId: string, providerId: string) => void = () => {};
export function setBackstopRecorder(fn: (agentGroupId: string, providerId: string) => void): void {
  recordBackstop = fn;
}

export async function resolveUserCreds(agentGroupId: string, providerId: string): Promise<ResolvedCreds> {
  const userId = userIdForAgentGroup(agentGroupId);
  if (userId) {
    const creds = loadUserProviderCreds(userId, providerId);
    if (creds) {
      if (creds.active === 'apiKey' && creds.apiKey) {
        return { kind: 'apiKey', value: creds.apiKey.value };
      }
      if (creds.active === 'oauth' && creds.oauth) {
        const needsRefresh = creds.oauth.expiresAt - Date.now() < REFRESH_BUFFER_MS;
        if (needsRefresh) {
          const refreshed = await oauthRefresher(creds.oauth.refreshToken, providerId);
          if (refreshed) {
            addOAuth(userId, providerId, { ...refreshed, account: creds.oauth.account });
            return { kind: 'oauth', accessToken: refreshed.accessToken };
          }
          // refresh failed → fall through to the department backstop
        } else {
          return { kind: 'oauth', accessToken: creds.oauth.accessToken };
        }
      }
    }
  }
  // No usable per-user credential → the credential proxy attaches the
  // department .env credential (the backstop). Record it so the operator can
  // see who is running on the department account. Connect is OPTIONAL: there is
  // no class-controls policy and no forbidden/connect_required branch here.
  recordBackstop(agentGroupId, providerId);
  return null;
}
```

Delete the now-dead `rosterLookup` registrar, `classPoolCreds`, `readClassControls` import, and the `classId` type usage from this file. `loadUserProviderCreds`, `oauthRefresher`, `addOAuth`, `REFRESH_BUFFER_MS` stay. Run the tests → PASS.

- [ ] **Step 5: Confirm the proxy fallback is unchanged and full suite green**

`resolveUserCreds` returning `null` must still make the proxy attach the `.env` credential exactly as before (Plan 1.5/2 behavior). Read `src/credential-proxy.ts`'s `userCredsHook` call site to confirm `null` → `.env` chain is untouched by this change. Then:

```bash
pnpm test && pnpm run build
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(provider-auth): resolve creds by the entity model, connect-optional backstop

resolveUserCreds resolved users via the empty classroom_roster (so everyone
silently ran on the .env key) and enforced a class-controls policy the dept
server has no use for. Now: the group's member's own creds if present, else
the department key — connect is optional, never a hard block."
```

### Task 2: Record backstop usage

**Why:** The operator needs to see who is running on the department key (real money, and the signal that a colleague hasn't connected yet). Decision: record the event now; the homepage banner is Plan 5. This task installs the recorder the Task-1 hook calls.

**Files:**
- Create: `src/backstop-usage.ts` + `.test.ts`
- Modify: `src/index.ts` (install the recorder via `setBackstopRecorder` at startup, next to `setUserCredsHook`)

**Interfaces:**
- Consumes: `setBackstopRecorder(fn)` (Task 1).
- Produces:
  - `recordBackstopUse(agentGroupId: string, providerId: string): void` — persist "this group last used the department backstop at <now> for <provider>".
  - `getBackstopUse(agentGroupId: string): { providerId: string; at: string } | null` — read it back.
  Store it in a dedicated tiny table `backstop_usage(agent_group_id TEXT PRIMARY KEY, provider_id TEXT, at TEXT)` via a new migration, OR in the agent group's `metadata` JSON — pick the table (cleaner to query for a future roster view; a memberless/system group simply never gets a row). A new migration is the department server's own schema, not classroom scaffolding, so it does not conflict with the deferred `classroom_roster` drop.

- [ ] **Step 1: Migration + failing test**

Add a migration under `src/db/migrations/` (follow the numbered-migration pattern; read `src/db/migrations/index.ts` and a recent numbered migration for the exact registration shape) creating `backstop_usage`. Then `src/backstop-usage.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initTestDb, closeDb, runMigrations, getDb } from './db/index.js';
import { recordBackstopUse, getBackstopUse } from './backstop-usage.js';

beforeEach(() => { initTestDb(); runMigrations(getDb()); });
afterEach(() => closeDb());

describe('backstop usage', () => {
  it('records and reads back the latest backstop use', () => {
    recordBackstopUse('ag_x', 'openai');
    const r = getBackstopUse('ag_x');
    expect(r?.providerId).toBe('openai');
    expect(typeof r?.at).toBe('string');
  });
  it('upserts — the latest use wins', () => {
    recordBackstopUse('ag_x', 'openai');
    recordBackstopUse('ag_x', 'anthropic');
    expect(getBackstopUse('ag_x')?.providerId).toBe('anthropic');
  });
  it('returns null for a group that never used the backstop', () => {
    expect(getBackstopUse('ag_never')).toBeNull();
  });
});
```

Because `at` must be deterministic-free of `Date.now()` in tests only if you assert its value — here we only assert its type, so real `new Date().toISOString()` in the impl is fine.

- [ ] **Step 2: Run, fail, implement**

Run → FAIL. Implement `recordBackstopUse` (UPSERT: `INSERT ... ON CONFLICT(agent_group_id) DO UPDATE SET provider_id=excluded.provider_id, at=excluded.at`) and `getBackstopUse`. Run → PASS.

- [ ] **Step 3: Wire it in at startup**

In `src/index.ts`, next to `setUserCredsHook(resolveUserCreds)` (~line 169), add:

```ts
import { setBackstopRecorder } from './user-provider-resolver.js';
import { recordBackstopUse } from './backstop-usage.js';
setBackstopRecorder(recordBackstopUse);
```

- [ ] **Step 4: Guard against a hot-path write storm**

`resolveUserCreds` runs on **every** proxied LLM request; `recordBackstopUse` must not write on every one. Make `recordBackstopUse` debounce: only write if the last recorded `at` for the group is older than 60s (read-then-conditional-write, or a small in-memory `Map<agentGroupId, lastWriteMs>`). Add a test: two calls within the debounce window produce one DB write (spy on the prepared-statement `run`, or assert the `at` value is unchanged across a rapid second call). State how you debounced.

- [ ] **Step 5: Full suite, typecheck, commit**

```bash
pnpm test && pnpm run build
git add -A
git commit -m "feat(backstop): record when a group's turn runs on the department key (debounced)"
```

### Task 3: Mount the session-gated "Connect ChatGPT" endpoints

**Why:** The OAuth connect handlers exist and are session-scoped (`handleProviderAuthStart`, `handleProviderAuthExchange`, `handleGetProviderStatus` in `src/channels/playground/api/provider-auth.ts` — each takes `session: { userId }`, binds OAuth state to the session, and 403s if the state is redeemed by a different session) but they are **not mounted** in the router. Without them, a colleague cannot connect their own account. This task wires them, authenticated.

**Files:**
- Modify: `src/channels/playground/api-routes.ts`
- Test: a route-level test in the `api-routes.authz.test.ts` style

**Interfaces:**
- Consumes: `handleProviderAuthStart(providerId, session)`, `handleProviderAuthExchange(body, providerId, session)`, `handleGetProviderStatus(providerId, session)` from `../api/provider-auth.js`.
- Produces: `GET /provider-auth/:provider/start`, `POST /provider-auth/:provider/exchange`, `GET /provider-auth/:provider/status` — each requiring an authenticated session (`session.userId`); a caller with no session gets 401. The user id is taken from `session.userId`, never from the path or body.

- [ ] **Step 1: Read the handlers and the routing conventions**

```bash
sed -n '1,60p' src/channels/playground/api/provider-auth.ts
grep -n "session\b" src/channels/playground/api-routes.ts | head
```
Confirm how `route()` receives the `session` and how other authenticated routes read `session.userId`. Confirm the exact exported handler names and their return shape (`ApiResult`).

- [ ] **Step 2: Failing test — unauthenticated is refused, authenticated reaches the handler**

In a route test (reuse the `api-routes.authz.test.ts` harness — the `route(req,res,url,method,session)` + fake req/res pattern):

```ts
// GET /provider-auth/openai-codex/status with a null-userId session → 401
// GET /provider-auth/openai-codex/status with a real session → 200 (reaches handleGetProviderStatus)
```
Assert the unauthenticated case is 401 and cannot start an OAuth flow.

- [ ] **Step 3: Run, fail, mount**

Add the three routes in `route()`, each: if `!session.userId` → `send(res, 401, { error: 'auth required' })`, else call the corresponding handler with `session` and send its `ApiResult`. Extract `providerId` from the path segment. For `exchange`, read the JSON body first. Do **not** invent a new auth mechanism — reuse the same `session` the other routes use.

Run the test → PASS.

- [ ] **Step 4: Full suite, typecheck, commit**

```bash
pnpm test && pnpm run build
git add -A
git commit -m "feat(provider-auth): mount session-gated connect/exchange/status routes"
```

### Task 4: Remove `class-controls` (cleanly decoupled)

**Why:** `class-controls` is the classroom per-class provider policy. Task 1 removed the resolver's use of it; only `owner-creds-ready.ts` and `pi.ts` still read it, and it has no meaning on the department server (no classes, connect is optional). Removing it is safe and self-contained. **The `classroom_roster` table is NOT dropped here — see the Scope boundary.**

**Files:**
- Modify: `src/owner-creds-ready.ts`, `src/providers/pi.ts`
- Delete: `src/channels/playground/api/class-controls.ts`, `config/class-controls.json`
- Modify: `src/channels/playground/api-routes.ts` (remove the class-controls route mounts if present)
- Test: whatever covers `pi.ts` / `owner-creds-ready.ts`

**Interfaces:**
- Produces: no `readClassControls` reference anywhere in `src/`.

- [ ] **Step 1: Map every reference, then read each site**

```bash
grep -rn "class-controls\|readClassControls\|classControls\|handleGetClassControls\|handlePutClassControls\|DEFAULT_CLASS_ID" src/ --include='*.ts' | grep -v test
```
For `pi.ts:100` (`readClassControls()`), read what it does with the result — if it was gating a model/provider on the class policy, that gate is now unconditional (department has no class policy); simplify accordingly. For `owner-creds-ready.ts`, read the `providedReady` usage and remove the class-controls dependency, keeping any genuinely-general "does the owner have creds" check. **State per file what the class-controls branch did and what you replaced it with.**

- [ ] **Step 2: Rewire `pi.ts` and `owner-creds-ready.ts` off class-controls**

Remove the imports and the class-controls branches. If a test asserted class-controls-gated behavior, it was testing classroom policy — update it to the new unconditional behavior and report which.

- [ ] **Step 3: Delete the module, config, and routes**

```bash
git rm src/channels/playground/api/class-controls.ts config/class-controls.json
```
Remove the class-controls imports and route blocks from `api-routes.ts` (the `GET/PUT /api/class-controls` handlers). Then confirm zero references:
```bash
grep -rn "class-controls\|readClassControls" src/ && echo "STILL REFERENCED — fix" || echo "clean"
```

- [ ] **Step 4: Full suite, typecheck, and a frontend-console check**

```bash
pnpm test && pnpm run build
```
The playground `home.js` / models tab may call `/api/class-controls`. Grep the frontend:
```bash
grep -rn "class-controls" src/channels/playground/public/
```
Remove any dead frontend fetch of that endpoint (its card was classroom-only). A 404 in the browser console for `/api/class-controls` after this is a dead call to clean up, not an error to leave.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove class-controls policy — dept server has no per-class provider gating"
```

### Task 5: Live verification

**Why:** The whole point is that a connected colleague's usage bills to them and an unconnected one falls back to the department key with the fallback recorded. Prove it against the running box.

**Files:** none committed (evidence goes in the report).

- [ ] **Step 1: Deploy**

```bash
pnpm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-581fefa4
sleep 6
tail -20 logs/nanoclaw.error.log
```
Expected: clean boot.

- [ ] **Step 2: Prove the backstop path (unconnected user) records the event**

Drive one agent turn for a group whose user has **no** connected creds (the `owner_01` group, unless the owner connected codex — check `ls data/user-provider-creds/`). Method: insert a message into the group's session `inbound.db` (columns `id, seq, kind, timestamp, status, tries, platform_id, channel_type, thread_id, content, on_wake`; host uses EVEN seq; `content` is JSON `{"text":"...","sender":"Owner","senderId":"..."}`; `pnpm exec tsx scripts/q.ts`, never `sqlite3`). Wait for a reply, then:
```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT agent_group_id, provider_id, at FROM backstop_usage"
```
Expected: a row for that group (it ran on the `.env` backstop, and Task 2 recorded it). Confirm the reply itself succeeded (the backstop must not break normal turns).

- [ ] **Step 3: Prove a connected user uses their OWN creds (not the backstop)**

There is a live per-user codex credential at `data/user-provider-creds/telegram_8731035088/codex.json`. If that user has a wired agent group, drive a turn for it and confirm **no** new `backstop_usage` row appears for that group (its own creds were used). If no such wired group exists, instead unit-verify at the resolver level: `resolveUserCreds(<that user's group>, 'openai-codex')` returns `{ kind: 'oauth', ... }`, not `null` — run a one-off `scripts/q.ts`-style check or a focused test with the real cred store path. **Do not print the token.** Report which method you used and the result (`own-creds` vs `backstop`), never the credential.

- [ ] **Step 4: Prove the connect endpoint is reachable + authenticated**

```bash
# unauthenticated → 401
curl -s -o /dev/null -w "no-session status=%{http_code}\n" http://gcworkflow.clemson.edu:8088/api/provider-auth/openai-codex/status
```
Expected: 401 (or the exact status the mounted route returns for no session — confirm it is NOT 200/data). A fuller authenticated check (redeem a login token → session cookie → `GET .../status` → 200) is optional; do it if the unauthenticated refusal alone doesn't convince.

- [ ] **Step 5: Record evidence**

Write `docs/superpowers/reviews/2026-07-10-provider-auth-verification.md`: the backstop-recorded turn, the own-creds-vs-backstop result (no token values), the endpoint auth check. Commit it.

```bash
git add docs/superpowers/reviews/2026-07-10-provider-auth-verification.md
git commit -m "docs(provider-auth): live verification — backstop recorded, own-creds used, endpoints gated"
```

### Task 6: state.md + push

- [ ] **Step 1: Update state.md**

Mark Plan 4 complete: per-user Codex OAuth resolves via the entity model; the department key is an automatic, recorded backstop; connect is optional; `class-controls` removed; **`classroom_roster` table drop + `class-*` renames remain for Plan 5**. Append one Decision-log entry (the resolver keys off the entity model, not a roster; connect is optional with a recorded backstop; class-controls has no place on a flat department server).

- [ ] **Step 2: Commit and push**

```bash
git add state.md
git commit -m "docs(state): Plan 4 complete — per-user OAuth + recorded dept-key backstop"
git push origin main
```

---

## Success criteria

1. `resolveUserCreds` resolves the user from `agent_group_members`, returns the user's own creds when present, and `null` (→ department backstop) otherwise — never a `forbidden`/`connect_required` policy object (Task 1, tested).
2. A turn that falls back to the department key records a `backstop_usage` row, debounced to at most one write/60s/group (Tasks 2 + 5, live).
3. The three `/api/provider-auth/:provider/*` routes are mounted and require an authenticated session; an unauthenticated caller cannot start an OAuth flow (Tasks 3 + 5).
4. A connected user's turn uses their own creds and records no backstop row (Task 5).
5. No `readClassControls` reference remains; `config/class-controls.json` and the module are gone; the box boots clean and normal turns still work (Tasks 4 + 5).

## Out of scope (deliberately deferred)

- **The `classroom_roster` table drop** and the sweep of its other ~14 references (login-token recovery, `list-for`, PIN, Telegram pairing, `usage`, `google-auth`, `me`) — Plan 5's cleanup pass, alongside the `class-*`→dept renames. Deferred to keep this auth-critical rewire away from the just-stabilized Plan 3 login paths.
- **The homepage "connect your ChatGPT / running on the department account" banner and usage/credits card** — Plan 5 (this plan emits the event; Plan 5 renders it).
- **Automated email invites, PIN 2FA, email self-recovery** — still gated on email transport.
- **API-key paste as an alternative to OAuth** — the storage supports it, but the chosen connect method is OAuth; not building a second UI path.
