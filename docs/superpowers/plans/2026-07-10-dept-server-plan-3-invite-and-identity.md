# Plan 3: Invite & Identity

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire `PLAYGROUND_AUTH_BYPASS` safely — so every web session is a real authenticated user, not the owner — by provisioning each person into the already-live durable-login-token system and handing them a bookmarkable magic URL, with the operator bootstrapped first so nobody is locked out.

**Architecture:** The bookmarkable-token → session login path already exists and is wired (`src/index.ts:79` imports `class-login-tokens.ts`, which registers a redeemer; `GET /?token=<t>` → `redeemClassToken` → session cookie). Plan 3 does **not** build auth. It (1) hardens the agent-group resolver so an unprovisioned user can't land in someone else's agent, (2) builds one provisioning primitive that creates the full per-user stack and mints the login token, (3) bootstraps the operator's own token, (4) provisions one pilot colleague as a canary and live-verifies isolation, then (5) flips the bypass off and live-verifies nobody is locked out and nothing is anonymously reachable.

**Tech Stack:** Node 22 + TypeScript host (`pnpm run build` = tsc, `pnpm test` = vitest, `better-sqlite3`); launchd service `com.nanoclaw-v2-581fefa4`; playground at `http://gcworkflow.clemson.edu:8088`.

## Decisions (settled 2026-07-10, do not relitigate)

| Decision | Choice |
|---|---|
| Invite delivery | **Manual link distribution.** Provisioning prints the magic URL to the operator; the operator sends it (Slack, email, in person). No email transport is configured on this box, and automated email is a later add-on. |
| Renames | **Deferred.** The `class-*`/`classroom-*` filenames stay; Plan 3 changes behavior only. A cosmetic rename pass comes later. |
| PIN 2FA | **Deferred** — it needs email to deliver the code, which this box lacks. For the pilot the bookmarkable URL is a bearer credential (see Security note). PIN becomes a tracked follow-up gated on email transport. |
| Email-based self-recovery | **Deferred.** `/login/recover` depends on `classroom_roster` (which Plan 4 deletes); the dept flow does not write there. Recovery for the pilot is operator-mediated (re-mint via `ncl`). |

## Security note — carry into state.md

With bypass off and no PIN, a login-token URL is a **bearer credential**: whoever holds the URL is that user. For 2–3 trusted colleagues on a campus network this is acceptable, and it is a strict improvement over today (every session is the owner). Two residual limits, both tracked, neither blocking the pilot: (a) the playground is served over plain HTTP (`:8088`), so the URL and cookie are observable to a network MITM — the cookie is `HttpOnly; SameSite=Lax` but not `Secure` (adding `Secure` would break plain-HTTP serving); (b) a forwarded URL is reusable until revoked — PIN 2FA closes this once email exists. Revoke a compromised URL with `ncl class-tokens rotate --user-id <id>`.

## Global Constraints

- Working directory `/Users/admin/projects/nanoclaw`. Never touch `/Users/admin/projects/nanoclaw_personal`.
- Run `pnpm run build` (tsc) after every change and read the output — vitest tolerates TS errors tsc rejects. Run `pnpm test` (green at HEAD — keep it).
- **Do not regress the Plan 1.5 isolation contract or the Plan 2 work.** Identity for routes comes from the session (`session.userId`); host services derive the group from the per-container token, never a header. `requireGroupAccess` is the only authorization helper for folder-addressed routes.
- **The `getPlaygroundAgentForUser` fallback is a live cross-tenant hazard** (Task 1) — a signed-in user with no membership currently resolves to the *first* agent group in the DB. Fix it before provisioning real colleagues.
- Repo-local CLI is `./bin/ncl`. The global `ncl` targets the OTHER install.
- `.env` is mode 0600 and gitignored — keep it that way. Never read, print, echo, or copy `.env` contents. **Never print a login-token value into a commit, log, or the ledger** — a token is a live credential; print it only to the operator via the provisioning command's stdout, and refer to it elsewhere as `<token>`.
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
| `src/db/agent-groups.ts` | `getPlaygroundAgentForUser` — fix the cross-tenant fallback. | 1 |
| `src/provisioning/provision-user.ts` | **New.** One reusable primitive: name+email → user + agent group + container config (pi + curated MCP) + filesystem scaffold + membership + messaging group + wiring + durable login token. Returns the token URL. Extracted from `scripts/init-first-agent.ts`'s logic. | 2 |
| `src/provisioning/provision-user.test.ts` | **New.** Provisioning unit tests against a temp DB. | 2 |
| `src/cli/resources/users.ts` | Add a `provision` verb exposing the primitive via `ncl`. | 3 |
| `.env`, `config/playground-seats.json` | Flip `PLAYGROUND_AUTH_BYPASS=0`; the seat picker is retired. | 5 |
| `docs/superpowers/reviews/2026-07-10-auth-cutover-verification.md` | Live evidence for the cutover. | 5 |
| `state.md` | Arc + decision-log entry. | 6 |

---

### Task 1: Fix the `getPlaygroundAgentForUser` cross-tenant fallback

**Why first:** `src/db/agent-groups.ts:84-101` returns the **first** non-draft agent group in the DB when the caller's `userId` has no `agent_group_members` row. Today bypass masks this (every session is the owner, who is a member of `owner_01`). The moment real users exist with bypass off, a user whose provisioning is incomplete — or any timing gap — lands in *another user's* agent. That is the exact cross-tenant leak this whole arc exists to prevent.

**Files:**
- Modify: `src/db/agent-groups.ts:84-101`
- Test: `src/db/agent-groups.test.ts` (create if absent)

**Interfaces:**
- Produces: `getPlaygroundAgentForUser(userId: string | null): AgentGroup | null` — returns the caller's **own** group (via `agent_group_members`) or `null`. The anonymous/no-userId case keeps a fallback ONLY when `PLAYGROUND_AUTH_BYPASS` is on (bypass wants a default seat); with bypass off, no membership → `null`.

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, PLAYGROUND_AUTH_BYPASS: false };
});

import { initTestDb, closeDb, runMigrations, getDb } from './index.js';
import { createAgentGroup, getPlaygroundAgentForUser } from './agent-groups.js';
import { createUser } from '../modules/permissions/db/users.js';
import { addMember } from '../modules/permissions/db/agent-group-members.js';

const NOW = '2026-07-10T00:00:00Z';
beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
  createUser({ id: 'playground:alice', kind: 'playground', display_name: 'Alice', created_at: NOW });
  createUser({ id: 'playground:bob', kind: 'playground', display_name: 'Bob', created_at: NOW });
  createAgentGroup({ id: 'ag_alice', name: 'Alice', folder: 'user_alice', agent_provider: 'pi', created_at: NOW, metadata: '{}' });
  createAgentGroup({ id: 'ag_bob', name: 'Bob', folder: 'user_bob', agent_provider: 'pi', created_at: '2026-07-10T00:00:01Z', metadata: '{}' });
  addMember({ user_id: 'playground:alice', agent_group_id: 'ag_alice', added_by: null, added_at: NOW });
});
afterEach(() => closeDb());

describe('getPlaygroundAgentForUser (bypass off)', () => {
  it('returns the user’s own group', () => {
    expect(getPlaygroundAgentForUser('playground:alice')?.id).toBe('ag_alice');
  });
  it('returns null for a signed-in user with no membership (no first-group leak)', () => {
    // bob is a real user but a member of nothing → must NOT get ag_alice
    expect(getPlaygroundAgentForUser('playground:bob')).toBeNull();
  });
  it('returns null for an anonymous caller when bypass is off', () => {
    expect(getPlaygroundAgentForUser(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it, watch it fail**

Run: `pnpm exec vitest run src/db/agent-groups.test.ts`
Expected: FAIL — the no-membership and anonymous cases return `ag_alice`/first-group, not `null`.

- [ ] **Step 3: Implement**

Replace the body of `getPlaygroundAgentForUser`:

```ts
import { PLAYGROUND_AUTH_BYPASS } from '../config.js';

export function getPlaygroundAgentForUser(userId: string | null): AgentGroup | null {
  if (userId) {
    const row = getDb()
      .prepare(
        `SELECT ag.* FROM agent_groups ag
           INNER JOIN agent_group_members agm ON agm.agent_group_id = ag.id
           WHERE agm.user_id = ?
           ORDER BY agm.added_at ASC
           LIMIT 1`,
      )
      .get(userId) as AgentGroup | undefined;
    // A signed-in user resolves to their OWN group or nothing. Never fall
    // through to "first group in the DB" — that hands one user another
    // user's agent (cross-tenant). The default-seat fallback below is only
    // for the anonymous bypass session.
    return row ?? null;
  }
  // Anonymous caller. Only bypass mode wants a default seat; with real auth
  // an unauthenticated caller has no agent group.
  if (!PLAYGROUND_AUTH_BYPASS) return null;
  const fallback = getDb()
    .prepare(`SELECT * FROM agent_groups WHERE folder NOT LIKE 'draft_%' ORDER BY created_at ASC LIMIT 1`)
    .get() as AgentGroup | undefined;
  return fallback ?? null;
}
```

Check the `config.js` import doesn't create a cycle (`agent-groups.ts` is low-level). If it does, thread `PLAYGROUND_AUTH_BYPASS` in as a parameter from the single caller (`api/me.ts:77`) instead, and adjust the test. State which you did.

- [ ] **Step 4: Run tests + full suite**

Run: `pnpm exec vitest run src/db/agent-groups.test.ts && pnpm test`
Expected: the three cases pass; suite green. **Watch for existing tests that assumed the old fallback** — if any fail, they were encoding the leak; fix them to seed membership and report which.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm run build
git add -A
git commit -m "fix(auth): getPlaygroundAgentForUser returns own-group-or-null, no first-group leak"
```

### Task 2: The provisioning primitive

**Why:** Retiring bypass requires a real user with a real, isolated agent and a login token. `scripts/init-first-agent.ts` already does the full stack (createAgentGroup → createMessagingGroup → createMessagingGroupAgent → addMember → initGroupFilesystem); this task extracts that into one reusable, tested function and adds token minting. The seats.json hand-editing gap (a Plan-1 deferral) closes here.

**Files:**
- Create: `src/provisioning/provision-user.ts`
- Create: `src/provisioning/provision-user.test.ts`

**Interfaces:**
- Consumes (verified real signatures — confirm by reading):
  - `createUser(user: { id; kind; display_name; created_at })` — `src/modules/permissions/db/users.ts`
  - `createAgentGroup(group: { id; name; folder; agent_provider; created_at; metadata })` — `src/db/agent-groups.ts:4`
  - `initGroupFilesystem(group: AgentGroup, opts?): void` — `src/group-init.ts:70` (calls `ensureContainerConfig`, which seeds `container_configs` including the curated MCP default set from Plan 2's `readDefaultMcpServers()`)
  - `addMember(row: { user_id; agent_group_id; added_by; added_at })` — `src/modules/permissions/db/agent-group-members.ts`
  - `createMessagingGroup`, `createMessagingGroupAgent` — `src/db/messaging-groups.ts`
  - `issueClassLoginToken(userId: string): string` — `src/class-login-tokens.ts:55` (the durable, bookmarkable token; do NOT rename it — renames are deferred)
  - **The URL base helper already exists**: `publicPlaygroundBaseUrl()` in `src/class-login-tokens.ts:150` reads `PUBLIC_PLAYGROUND_URL` from env/`.env` (currently set to the real `http://gcworkflow.clemson.edu:8088`), falling back to `http://localhost:3002`. It is module-private — **export it** and reuse it; do NOT hardcode a host/port or invent `PLAYGROUND_PUBLIC_HOST`. The login URL is `${publicPlaygroundBaseUrl()}/?token=${token}` (the same shape `ncl class-tokens issue` prints — read `src/cli/resources/class-tokens.ts` to match it exactly).
- Produces:
  - `provisionUser(input: { displayName: string; email: string }): ProvisionResult`
  - `interface ProvisionResult { userId: string; agentGroupId: string; folder: string; loginUrl: string }`
  - Idempotency: if a user with the derived id already exists, throw a clear error naming the existing user (do NOT silently re-provision or double-mint).

**Read `scripts/init-first-agent.ts` fully first** — mirror its messaging-group + wiring shape exactly so a provisioned agent actually receives playground messages. Deviating there produces a user who can log in but whose messages route nowhere.

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const TMP = '/tmp/nanoclaw-test-provision';
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: TMP, GROUPS_DIR: path.join(TMP, 'groups') };
});
// publicPlaygroundBaseUrl() reads PUBLIC_PLAYGROUND_URL from env; set it for the test.
vi.stubEnv('PUBLIC_PLAYGROUND_URL', 'http://example.test:8088');

import { initTestDb, closeDb, runMigrations, getDb } from '../db/index.js';
import { getAgentGroupByFolder, getPlaygroundAgentForUser } from '../db/agent-groups.js';
import { isMember } from '../modules/permissions/db/agent-group-members.js';
import { provisionUser } from './provision-user.js';

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'groups'), { recursive: true });
  initTestDb();
  runMigrations(getDb());
});
afterEach(() => { closeDb(); fs.rmSync(TMP, { recursive: true, force: true }); });

describe('provisionUser', () => {
  it('creates a fully-wired, isolated user with a login URL', () => {
    const r = provisionUser({ displayName: 'Dana Faculty', email: 'dana@clemson.edu' });
    expect(r.userId).toMatch(/^playground:/);
    expect(r.loginUrl).toContain('example.test');
    expect(r.loginUrl).toMatch(/\?token=[A-Za-z0-9_-]+$/);
    // own group resolves via membership (Task 1)
    expect(getPlaygroundAgentForUser(r.userId)?.id).toBe(r.agentGroupId);
    expect(isMember(r.userId, r.agentGroupId)).toBe(true);
    // container_configs seeded with provider=pi (the Plan-1 footgun)
    const cfg = getDb().prepare('SELECT provider FROM container_configs WHERE agent_group_id=?').get(r.agentGroupId) as { provider: string };
    expect(cfg.provider).toBe('pi');
    // filesystem scaffolded
    expect(fs.existsSync(path.join(TMP, 'groups', r.folder))).toBe(true);
  });

  it('refuses to double-provision the same identity', () => {
    provisionUser({ displayName: 'Dana', email: 'dana@clemson.edu' });
    expect(() => provisionUser({ displayName: 'Dana', email: 'dana@clemson.edu' })).toThrow(/exists/i);
  });

  it('does not leak another user’s agent', () => {
    const a = provisionUser({ displayName: 'A', email: 'a@clemson.edu' });
    const b = provisionUser({ displayName: 'B', email: 'b@clemson.edu' });
    expect(getPlaygroundAgentForUser(a.userId)?.id).toBe(a.agentGroupId);
    expect(getPlaygroundAgentForUser(b.userId)?.id).toBe(b.agentGroupId);
    expect(a.agentGroupId).not.toBe(b.agentGroupId);
  });
});
```

- [ ] **Step 2: Run it, watch it fail**

Run: `pnpm exec vitest run src/provisioning/provision-user.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `provisionUser`**

Write `src/provisioning/provision-user.ts`. Derive a filesystem-safe, unique slug from the display name (lowercase, `[a-z0-9_]`, collision-suffix if `getAgentGroupByFolder(slug)` exists); id = `playground:<slug>`. Then, **in the order `init-first-agent.ts` uses**: createUser → createAgentGroup(`agent_provider:'pi'`) → initGroupFilesystem → addMember → createMessagingGroup(`platform_id: 'playground:'+folder`) → createMessagingGroupAgent(wiring) → `const token = issueClassLoginToken(userId)`. Return `{ userId, agentGroupId, folder, loginUrl: `${publicPlaygroundBaseUrl()}/?token=${token}` }` (import the now-exported helper from `../class-login-tokens.js`).

Store the `email` where the entity model keeps it — check `init-first-agent.ts` and the `users`/`user_dms` schema; if there is no email column, put it in the agent-group `metadata` JSON (`{"email": "..."}`) so a future email-recovery task can find it. Do NOT write to `classroom_roster` (Plan 4 deletes it). State where you stored email.

Wrap the whole sequence in a single DB transaction (`getDb().transaction(...)`) EXCEPT `initGroupFilesystem` (filesystem, not DB) and `issueClassLoginToken` — order it so a failure can't leave a half-provisioned user with a live token. If the filesystem scaffold throws, the DB rows must roll back. State how you sequenced it.

- [ ] **Step 4: Run tests + full suite + typecheck**

```bash
pnpm exec vitest run src/provisioning/provision-user.test.ts && pnpm test && pnpm run build
```
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(provisioning): provisionUser — full per-user stack + durable login URL"
```

### Task 3: Expose `provisionUser` as `ncl users provision`

**Files:**
- Modify: `src/cli/resources/users.ts` (add the `provision` operation)
- Test: extend `src/provisioning/provision-user.test.ts` or a CLI-dispatch test in the `src/cli/scope.test.ts` style

**Interfaces:**
- Consumes: `provisionUser` (Task 2).
- Produces: `ncl users provision --display-name "<name>" --email <email>` prints the login URL (and userId, agentGroupId) to stdout. **`access: 'approval'`** — provisioning creates entities and mints a credential; it must go through the host approval gate, and it must NOT be reachable at `access:'open'` from inside a container (Plan 1.5 scoped `ncl` reads; this is a mutation).

- [ ] **Step 1: Read the `class-tokens.ts` resource** (`src/cli/resources/class-tokens.ts`) for how a custom verb with a handler + `access` is registered, and how `issue`/`rotate` print a URL. Mirror that shape.

- [ ] **Step 2: Add the `provision` verb**

In `src/cli/resources/users.ts`, register a `provision` operation (`access: 'approval'`) whose handler calls `provisionUser({ displayName, email })` and returns/prints the `loginUrl`. Follow the file's existing operation-handler signature exactly.

- [ ] **Step 3: Test the dispatch path**

Add a test that invokes the `provision` verb through the CLI dispatcher (as `caller: 'host'`) and asserts a URL comes back and the user now exists. If a same-tree unit test is simpler and still exercises the registered handler, do that — but it must exercise the registered verb, not just `provisionUser` again.

- [ ] **Step 4: Build, test, and a real host run**

```bash
pnpm run build && pnpm test
```
Then, against the live DB, provision nobody yet — just confirm help renders:
```bash
./bin/ncl users help
```
Expected: `provision` listed as an approval verb.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(cli): ncl users provision — one-command invite that prints the login URL"
```

### Task 4: Bootstrap the operator's durable login token

**Why:** With bypass off, the operator logs in via a token URL like everyone else. `owner_01` already exists as a user+group+membership, so it needs only a token — no full provision. This task mints it and **verifies login works while bypass is still on** (zero lockout risk), so Task 5's flip is safe.

**Files:** none committed (runtime action + evidence in the report).

**Interfaces:**
- Consumes: `issueClassLoginToken('playground:owner_01')` via `./bin/ncl class-tokens issue` (approval verb) or a one-off `scripts/q.ts`-adjacent call. Prefer the `ncl` verb if it accepts a raw user id; the operator user is `playground:owner_01`.

- [ ] **Step 1: Confirm the operator user + membership exist**

```bash
./bin/ncl users list | grep owner_01
pnpm exec tsx scripts/q.ts data/v2.db "SELECT user_id, agent_group_id FROM agent_group_members WHERE user_id='playground:owner_01'"
```
Expected: the user exists and is a member of the owner agent group. If the membership row is missing (bypass never needed it), add it: find the owner agent group id, then `./bin/ncl members add --user-id playground:owner_01 --agent-group-id <id>`.

- [ ] **Step 2: Mint the operator's durable token**

```bash
./bin/ncl class-tokens issue --user-id playground:owner_01   # or --email if the verb requires it; read `ncl class-tokens help`
```
This prints a URL. **Do not paste the token anywhere.** The operator bookmarks `http://gcworkflow.clemson.edu:8088/?token=<token>`.

- [ ] **Step 3: Verify the token logs in — WHILE BYPASS IS STILL ON**

In a browser (a private window, so the bypass session doesn't mask it), open the operator's `/?token=<token>` URL. Expected: it sets a cookie and lands on `/playground/` as the owner. Send one chat message; expect a reply. This proves the durable-token path works before you remove the safety net.

If it does NOT log in: the redeemer may not be resolving `owner_01`. Check `logs/nanoclaw.log` and `redeemClassToken`/`lookupActiveToken`. Do not proceed to Task 5 until the operator can log in by token.

- [ ] **Step 4: Record the evidence** (no commit yet — folded into Task 5's report): operator token issued, login verified with bypass on.

### Task 5: Provision a canary colleague, then retire the bypass

**This is the cutover. Do Task 4 first — the operator must be able to log in by token before the net comes off.**

**Files:**
- Modify: `.env` (`PLAYGROUND_AUTH_BYPASS=0`) — not committed, gitignored.
- Modify: `config/playground-seats.json` if the seat picker needs neutralizing (it is bypass-gated already; confirm).
- Create: `docs/superpowers/reviews/2026-07-10-auth-cutover-verification.md`

**Interfaces:**
- Consumes: Tasks 1–4 landed; operator token verified.

- [ ] **Step 1: Provision one real pilot colleague as a canary**

```bash
./bin/ncl users provision --display-name "Canary Colleague" --email canary@clemson.edu
```
Record the printed `loginUrl` (as `<canary-url>`, never the raw token). Rebuild the image only if provisioning changed container config defaults (it shouldn't — `initGroupFilesystem` seeds from existing config): `./container/build.sh` only if a live turn later shows a stale config.

- [ ] **Step 2: Flip bypass off and restart**

In `.env` set `PLAYGROUND_AUTH_BYPASS=0`. Then:
```bash
pnpm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-581fefa4
sleep 6
tail -20 logs/nanoclaw.error.log
```
Expected: clean boot, `authMode="magic-link"` in `logs/nanoclaw.log`.

- [ ] **Step 3: The four cutover checks (this IS the deliverable)**

At `http://gcworkflow.clemson.edu:8088`, in fresh private windows:
1. **Operator logs in** via the Task-4 token URL → lands as owner, can chat. *(No lockout — the thing that failed the first attempt.)*
2. **Canary logs in** via `<canary-url>` → lands in **their own** agent (`getPlaygroundAgentForUser` returns the canary's group, Task 1), can chat, and the reply comes from a container for the canary's group (check `logs/nanoclaw.log` for the canary's `agentGroup`).
3. **Anonymous is refused:** open `http://gcworkflow.clemson.edu:8088/playground/` with no cookie and no token → redirected to `/login`, NOT given owner access. Then `curl -s -o /dev/null -w '%{http_code}' http://gcworkflow.clemson.edu:8088/api/me/agent` with no cookie → **401**, not 200. *(Before this cutover, this returned the owner.)*
4. **Cross-tenant is refused:** as the canary session, attempt `PUT /api/drafts/owner_01/persona` (Plan 1.5's gate) → **403**. Confirms the canary is a distinct principal, not the owner.

- [ ] **Step 4: If any check fails, ROLL BACK**

Set `PLAYGROUND_AUTH_BYPASS=1` in `.env`, `pnpm run build`, restart, confirm the playground loads. Report BLOCKED with exactly which check failed and the evidence. A working box with bypass on beats a locked-out or leaking one. Do not leave bypass off if the operator or canary cannot log in.

- [ ] **Step 5: Record evidence and commit the doc**

Write `docs/superpowers/reviews/2026-07-10-auth-cutover-verification.md` with, for each of the four checks, the exact request and observed result, and the pre-cutover behavior. **No token values in the doc.**

```bash
git add docs/superpowers/reviews/2026-07-10-auth-cutover-verification.md config/playground-seats.json
git commit -m "docs(auth): bypass retired — operator+canary login and anonymous-refused verified live"
```

### Task 6: state.md, memory, and the pilot-ready summary

**Files:**
- Modify: `state.md` (Current arc + Decision log)

- [ ] **Step 1: Update state.md**

Mark Plan 3 complete; move `PLAYGROUND_AUTH_BYPASS` from "tracked blocker" to "retired (2026-07-10)". Append one Decision-log entry: the durable login-token path is the department's auth mechanism; identity is now a real per-user session; provisioning is `ncl users provision` (manual URL distribution); PIN 2FA + automated email + the `class-*` renames remain deferred (name Plan 4/later). Note the two residual security limits from the Security note (plain-HTTP transport; bearer-URL reuse until revoked).

- [ ] **Step 2: Commit and push**

```bash
git add state.md
git commit -m "docs(state): Plan 3 complete — bypass retired, per-user login live"
git push origin main
```

---

## Success criteria

1. A signed-in user with no membership resolves to `null`, never another user's agent (Task 1, tested).
2. `ncl users provision` creates a fully-wired, isolated user and prints a working login URL (Task 3, live-verified).
3. The operator can log in by token URL with bypass **off** (Task 4 → Task 5, live).
4. A provisioned colleague logs in to **their own** agent, can chat, and cannot touch the owner's group (Task 5, live).
5. Anonymous access returns 401 / redirect-to-login, not owner authority (Task 5, live).
6. `PLAYGROUND_AUTH_BYPASS=0` in `.env` on the running box, boot clean, `authMode="magic-link"`.

## Out of scope (deliberately deferred)

- **Automated email invites** (Resend/Gmail) — manual URL distribution for the pilot; revisit when scaling toward 15.
- **Email PIN 2FA** — needs email; the bearer-URL limitation is documented and tracked.
- **Email-based self-recovery** — operator re-mints via `ncl class-tokens rotate` for the pilot.
- **Renaming `class-*`/`classroom-*` files** and deleting `classroom_roster` — a later low-risk pass / Plan 4.
- **Homepage reorganization, admin roster UI, Telegram self-serve linking** — Plan 5.
- **Adding `Secure` to the session cookie** — blocked on serving the playground over HTTPS; tracked.
- **The `:10255` cross-install exposure and the host firewall** — carried from Plan 2's review; operator/network actions, not code.
