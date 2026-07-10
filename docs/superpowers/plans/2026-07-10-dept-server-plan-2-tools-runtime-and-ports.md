# Plan 2: Tools, Runtime, and Ports

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give department agents a useful, bounded toolset — skills, a curated MCP server set, and Drive-without-the-owner's-token — on an upgraded container runtime, with the department key protected by a spend cap that actually applies to normal agent turns.

**Architecture:** Four independent strands, ordered by risk. (1) Money and blast radius first: enforce budgets on the *main* agent-turn path and strip the Google tools that reach the owner's account. (2) Runtime: land the dual-shape status fix, then upgrade Apple Container 0.12.3 → 1.1.0 in one coordinated window across both installs on this box. (3) Tools: a curated default MCP server set, `add_mcp_server` kept as the approval-gated path to more, and skills confined per group. (4) Ports from `~/projects/nanoclaw_personal` and the carry-over bug list.

**Tech Stack:** Node 22 + TypeScript host (`pnpm run build` = tsc, `pnpm test` = vitest, `better-sqlite3`); Bun agent-runner under `container/agent-runner/` (`bun test`, `bun:sqlite`); Apple Container runtime; launchd service `com.nanoclaw-v2-581fefa4`.

## Scope decisions (made 2026-07-10, do not relitigate)

| Decision | Choice |
|---|---|
| Self-learning | **Deferred to a later phase.** `hermes-selflearning` is NOT ported from the personal repo. |
| `self-customize` | **Kept.** Agents may write/edit their own skills, confined to their own group folder. |
| Google Workspace | **Keep Drive/Sheets/Docs/Slides; delete Gmail + Calendar; kill the owner-token fallback.** Drive-family tools must require the calling group's OWN Google token and fail closed without one. |
| MCP servers | **Curated default set** applied to every agent group, **plus** `add_mcp_server` retained as the admin-approved path to request more. |
| Default MCP set | `cuassistant-public`, `cuassistant-catalog`, `gc-alumni` (all unauthenticated), and `gc-wiki` (bearer token). |
| Approval-only MCP | `cuassistant-credentialed` and `procurement` — their bearer tokens would sit in every wired container's env, and procurement data is more sensitive than wiki content. |
| Skills to port | **The five skills associated with the chosen MCP servers** (Task 6c). The personal repo's *container* skills are already a subset of this repo's 16, except `hermes-selflearning` (deferred) and `whatsapp-formatting` (unwanted) — but its **per-group** skills teach agents how to use the MCP servers, and without them the servers are tools with no instructions. |
| Skills excluded | `clemson-email` and `email-taskfinder` — both drive Gmail/Outlook **and** depend on `cuassistant-credentialed`, which is not in the default set. |

## Global Constraints

- Working directory `/Users/admin/projects/nanoclaw`. **Never** touch `/Users/admin/projects/nanoclaw_personal` except to READ files for porting — it is a separate live install that shares this box's `container` binary and daemon.
- Run `pnpm run build` (host tsc) yourself after every change and read the output — **vitest tolerates TS errors tsc rejects**.
- Container tree has its own typecheck and runner: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`, and `cd container/agent-runner && bun test`. Container tests import from `bun:test`, never `vitest`. Host tests import from `vitest`, never `bun:test`.
- **Security invariant from Plan 1.5 — do not regress:** never authorize from a value the caller supplied. `requireGroupAccess` (fail-closed) is the only authorization helper for folder-addressed routes. `checkDraftMutation` default-allows and is NOT authorization. Host services derive the caller's agent group from the per-container token (`src/container-identity.ts`), never from a header.
- `PLAYGROUND_AUTH_BYPASS=1` is currently ON, which means **every web session is the owner**. Do not invite anyone, do not share the playground URL, and do not treat the seat password as access control. Retiring it is Plan 3.
- Vitest writes fixture dirs into the live `groups/`. Compare `ls groups/` before/after; delete anything new that is not `_default_participant`, `owner_01`, `user_01`.
- Never print a secret: API keys, container tokens, OAuth tokens, the seat password. `.env` is mode 0600 and gitignored — keep it that way. `config/playground-seats.json` is git-tracked and its `password` field must stay `""`.
- Ad-hoc DB queries: `pnpm exec tsx scripts/q.ts <db> "<sql>"` — never the `sqlite3` CLI.
- Use `./bin/ncl` (repo-local). The global `ncl` points at the OTHER install.
- Playground is `http://gcworkflow.clemson.edu:8088` (Caddy → 127.0.0.1:3002). Never `127.0.0.1:3002` (headless box), never plain `https://gcworkflow.clemson.edu` (different app).
- Every commit message ends, after a blank line, with:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01WXUAU8TQduy8SMSVWoNYvn
  ```

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/modules/budgets/enforce.ts` | Gains `assertGroupWithinBudget(agentGroupId)` — folder resolved internally, callable from the proxy path. | 1 |
| `src/credential-proxy.ts` | Consults the budget for token-identified callers before forwarding an LLM request. | 1 |
| `config/cost-budgets.json` | Gains a non-null `defaultMonthlyUsd` so enforcement is opt-out, not opt-in. | 1 |
| `src/gws-mcp-tools.ts` | Gmail + Calendar tool definitions deleted; Drive-family tools switched to `requirePersonal: true`. | 2 |
| `src/gws-token.ts` | `instructor-fallback` principal removed; no token → fail closed. | 2 |
| `src/container-runtime.ts` | Dual-shape `status` read (`string \| { state }`) for Apple Container 1.x. | 3 |
| `config/default-mcp-servers.json` | **New.** The curated MCP server set, applied at group init. | 5 |
| `src/group-init.ts` | Seeds `container_configs.mcp_servers` from the curated set; gains the persona size guard. | 5, 7 |
| `container/agent-runner/src/mcp-tools/files.ts` | Gains SSRF-safe `fetch_url_to_workspace` (ported). | 7 |
| `container/agent-runner/src/providers/pi*.ts` | Best-of-both reconciliation with the personal repo. | 8 |

---

### Task 1: Enforce a spend cap on the main agent-turn path

**Why first:** the review found budgets enforce **only** on `/api/direct-chat`. A normal turn (Telegram or playground chat → container → credential proxy → OpenAI) has **no cap**, and `assertWithinBudget` no-ops when no budget is configured. This is the biggest real-money gap and it gates the pilot.

**Files:**
- Modify: `src/modules/budgets/enforce.ts`
- Modify: `src/credential-proxy.ts` (the `userCredsHook` block, ~line 640)
- Modify: `config/cost-budgets.json` (create with a default if absent — check `readCostBudgets()` for the path and shape first)
- Test: `src/modules/budgets/enforce.test.ts`, `src/credential-proxy.test.ts`

**Interfaces:**
- Consumes: `resolveProxyIdentity(headers) → { agentGroupId, sessionId } | null` and `isLoopbackSource(remoteAddress)` (both exported from `src/credential-proxy.ts`); `assertWithinBudget(folder, agentGroupId)` (existing).
- Produces: `assertGroupWithinBudget(agentGroupId: string): { ok: true } | { ok: false; reason: string }` — resolves the folder from the group id internally (`getAgentGroup(agentGroupId).folder`) so proxy callers need not know it.

**Design decision, stated so the implementer does not improvise:** enforce at the **proxy**, not in the agent-runner. The proxy is the one chokepoint every LLM call crosses, it already knows the caller's group from the token, and it cannot be bypassed by a compromised container. Return **429** with a JSON body; the agent-runner surfaces upstream errors to the user already.

Loopback callers (host-internal, `agentGroupId === null`) are **not** budget-checked here — `direct-chat` already checks its own budget before dispatching (Plan 1.5 Task 8). Do not double-charge or double-block them.

- [ ] **Step 1: Write the failing test for the new helper**

Add to `src/modules/budgets/enforce.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: (id: string) => (id === 'ag_known' ? { id, folder: 'user_alice' } : undefined),
}));
vi.mock('../../channels/playground/api/cost-budgets.js', () => ({
  readCostBudgets: () => ({ defaultMonthlyUsd: 10, perAgent: {}, warnFraction: 0.8 }),
  budgetForAgent: (_folder: string, cfg: { defaultMonthlyUsd: number | null }) => cfg.defaultMonthlyUsd,
  evaluateBudget: (costUsd: number, budgetUsd: number | null) =>
    budgetUsd == null
      ? { status: 'none' as const, costUsd, budgetUsd, fraction: null }
      : { status: (costUsd >= budgetUsd ? 'over' : 'ok') as 'over' | 'ok', costUsd, budgetUsd, fraction: 0 },
}));
vi.mock('../../channels/playground/api/usage.js', () => ({
  aggregateAgentUsage: (id: string) => ({ thisMonth: { costUsd: id === 'ag_known' ? 99 : 0 }, total: { costUsd: 0 } }),
}));

import { assertGroupWithinBudget } from './enforce.js';

describe('assertGroupWithinBudget', () => {
  it('denies an over-budget group', () => {
    const r = assertGroupWithinBudget('ag_known');
    expect(r.ok).toBe(false);
  });

  it('fails closed for an unknown group id', () => {
    const r = assertGroupWithinBudget('ag_missing');
    expect(r.ok).toBe(false);
  });
});
```

Before running: open `src/channels/playground/api/usage.ts` and confirm `UsageBucket`'s dollar field really is `costUsd`. If it differs, fix the mock **and** the implementation. A mock that invents a field name is a false green; this codebase has shipped bugs that way.

- [ ] **Step 2: Run it, watch it fail**

Run: `pnpm exec vitest run src/modules/budgets/enforce.test.ts`
Expected: FAIL — `assertGroupWithinBudget` is not exported.

- [ ] **Step 3: Implement the helper**

Append to `src/modules/budgets/enforce.ts`:

```ts
import { getAgentGroup } from '../../db/agent-groups.js';

/**
 * Budget check for callers identified only by agent-group id — i.e. the
 * credential proxy, which is the one chokepoint every LLM call crosses.
 *
 * Fails CLOSED on an unknown group: a request we cannot attribute must not
 * spend the department's key.
 */
export function assertGroupWithinBudget(agentGroupId: string): BudgetVerdict {
  const group = getAgentGroup(agentGroupId);
  if (!group) return { ok: false, reason: 'Unknown agent group.' };
  return assertWithinBudget(group.folder, group.id);
}
```

- [ ] **Step 4: Enforce it in the proxy**

In `src/credential-proxy.ts`, inside the block that runs when `agentGroupId` is non-null (the `userCredsHook` branch, ~line 640), **before** the upstream request is made:

```ts
          const budget = assertGroupWithinBudget(agentGroupId);
          if (!budget.ok) {
            log.warn('credential-proxy: budget exceeded, refusing upstream call', { agentGroupId });
            res.writeHead(429, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: budget.reason }));
            return;
          }
```

Add the import. Do **not** apply this to loopback callers.

- [ ] **Step 5: Set a real default budget**

Read `readCostBudgets()` in `src/channels/playground/api/cost-budgets.ts` to find the config path and exact shape. Set `defaultMonthlyUsd` to **25** (a deliberate starting value: generous for one person's month of agent use, small enough that a runaway loop is capped at the cost of a dinner). The operator can raise it from the Budgets tab. Record the number and the reasoning in your report so it can be argued with.

- [ ] **Step 6: Pin the proxy enforcement with a real-server test**

Add to `src/credential-proxy.test.ts`, reusing its existing harness (do not add a second one). Mint a token for a group whose usage exceeds the budget, issue a request from a non-loopback source, assert **429** and that `userCredsHook` was never called (no credential was attached). Add a second case: an under-budget group gets through.

**Prove it:** delete the 429 block, confirm the test FAILS; revert, confirm it passes. Report the verbatim FAIL.

- [ ] **Step 7: Full suite, typecheck, commit**

```bash
pnpm test && pnpm run build
git add -A
git commit -m "fix(budgets): enforce spend cap on the main agent-turn path at the proxy

Budgets enforced only on /api/direct-chat; a normal turn through the
container had no cap, and assertWithinBudget no-opped with no budget set."
```

### Task 2: Google Workspace — delete Gmail + Calendar, kill the owner-token fallback

**Why:** `src/gws-token.ts` resolves a `'instructor-fallback'` principal — Drive/Sheets/Docs/Slides silently use the **owner's** Google token when the calling group has none. Gmail and Calendar already pass `requirePersonal: true` and fail closed; they are being removed because the department server has no use for agents reading anyone's mail or calendar.

**Files:**
- Modify: `src/gws-mcp-tools.ts` (delete Gmail + Calendar tool definitions and handlers; switch Drive-family to `requirePersonal: true`)
- Modify: `src/gws-token.ts` (remove the `'instructor-fallback'` principal and its code path)
- Modify: `container/agent-runner/src/mcp-tools/gws.ts` (drop removed tools from the exposed list)
- Modify: `container/skills/google-workspace/SKILL.md` (describe reality)
- Test: `src/gws-mcp-tools.test.ts`, `src/gws-token.test.ts`

**Interfaces:**
- Produces: `getGoogleAccessTokenForAgentGroup(agentGroupId)` returns the group's OWN token or `null` — never the owner's. `GwsPrincipal` collapses to `'self'`; delete the type if it becomes a single-member union.

- [ ] **Step 1: Write the failing tests**

In `src/gws-token.test.ts`, assert that a group with **no** personal Google credentials resolves to `null` (not the owner's token), and that a group **with** credentials resolves to its own. Read the existing test file's fixtures for how credential paths are faked; reuse them.

In `src/gws-mcp-tools.test.ts`, assert the exported tool list contains **no** tool whose name starts with `gmail_` or `calendar_`, and that every remaining tool resolves its token with `requirePersonal: true`.

- [ ] **Step 2: Run, watch fail**

Run: `pnpm exec vitest run src/gws-token.test.ts src/gws-mcp-tools.test.ts`
Expected: FAIL — the fallback still returns the owner's token; Gmail/Calendar tools still present.

- [ ] **Step 3: Delete Gmail + Calendar**

```bash
grep -n "gmail_\|calendar_" src/gws-mcp-tools.ts container/agent-runner/src/mcp-tools/gws.ts
```
Remove each tool definition, its handler, and its registration. Then `grep -rn "gmail_\|calendar_" src/ container/` must return nothing outside tests you also removed.

- [ ] **Step 4: Kill the fallback**

In `src/gws-token.ts`, remove the `'instructor-fallback'` branch (the code paths noted around lines 15-17, 161, 178-194). Every remaining caller passes through the personal-token path; a missing token returns `null` and the tool returns a clear error to the agent ("Connect your Google account first"). Remove the now-dead `options.requirePersonal` parameter **only if** every call site now requires personal — otherwise leave the parameter and set it `true` at each Drive-family call site. Read `src/gws-mcp-tools.ts` lines ~600-1000 and decide; state which you did and why.

- [ ] **Step 5: Run tests, then verify nothing else consumed the fallback**

```bash
pnpm exec vitest run src/gws-token.test.ts src/gws-mcp-tools.test.ts
grep -rn "instructor-fallback\|GwsPrincipal" src/ container/
pnpm test && pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```
Expected: tests pass; the greps return nothing (or only a comment you then delete); both typechecks clean.

- [ ] **Step 6: Update the skill doc and commit**

`container/skills/google-workspace/SKILL.md` must say: Drive/Sheets/Docs/Slides only, requires the user's own connected Google account, no mail or calendar access. Delete any Gmail/Calendar examples.

```bash
git add -A
git commit -m "fix(gws): drop Gmail+Calendar tools, require the caller's own Google token

Drive/Sheets/Docs/Slides fell back to the owner's token when the calling
group had none — any agent without Google creds was operating in the
owner's Drive."
```

### Task 3: Apple Container dual-shape status fix

**Why now:** `container ls --format json` changed `status` from a bare string to `{ state }` in Apple Container 1.0.0. `src/container-runtime.ts:168` matches `c.status === 'running'`, which silently matches nothing on 1.x — orphan reaping stops. **This must land before Task 4's upgrade**, and it is safe on both versions.

The fix exists in the personal repo (`47b8be1`). Read it, do not blind-copy: `git -C /Users/admin/projects/nanoclaw_personal show 47b8be1`.

**Files:**
- Modify: `src/container-runtime.ts` (~line 160-168)
- Test: `src/container-runtime.test.ts`

**Interfaces:**
- Produces: orphan cleanup works against `status: 'running'` (0.12.x) **and** `status: { state: 'running' }` (1.x).

- [ ] **Step 1: Write both-shape failing tests**

In `src/container-runtime.test.ts`, add a case feeding `container ls --format json` output with `status: { state: 'running' }` and asserting the container is recognized. Keep the existing string-shape case. Reuse the file's existing `execSync` mock.

- [ ] **Step 2: Run, watch the 1.x case fail**

Run: `pnpm exec vitest run src/container-runtime.test.ts`
Expected: the new object-shape test FAILS (matches nothing).

- [ ] **Step 3: Implement**

Read `status` as `string | { state: string }`:

```ts
function containerState(status: unknown): string {
  if (typeof status === 'string') return status;
  if (status && typeof status === 'object' && 'state' in status) {
    const s = (status as { state: unknown }).state;
    if (typeof s === 'string') return s;
  }
  return '';
}
```
and filter with `containerState(c.status) === 'running'`. Update the row type accordingly.

- [ ] **Step 4: Both shapes green; commit**

```bash
pnpm exec vitest run src/container-runtime.test.ts
pnpm test && pnpm run build
git add -A
git commit -m "fix(container-runtime): read object-shaped status (Apple Container 1.x)"
```

### Task 4: Apple Container 0.12.3 → 1.1.0 upgrade

**Do not start until Task 3 has landed.** Upgrading first would silently stop orphan reaping.

**Shared-resource hazard:** `/opt/homebrew/bin/container` and the per-user container daemon are shared with the **personal install** (`com.nanoclaw-v2-011e3c4e`, `/Users/admin/projects/nanoclaw_personal`). You cannot upgrade one without the other. The personal repo already carries the dual-shape fix, so it is 1.x-ready at the known break point.

**Files:** none in-repo (a toolchain upgrade). Evidence goes in the report.

**Interfaces:**
- Consumes: Task 3's dual-shape fix, landed and green.
- Produces: `container --version` reports 1.1.0; one verified container spawn per install.

- [ ] **Step 1: Record the pre-state**

```bash
container --version
container list --all
launchctl list | grep nanoclaw
```
Save all output to the report. This is your rollback reference.

- [ ] **Step 2: Stop both services, then upgrade**

```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw-v2-581fefa4.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw-v2-011e3c4e.plist
brew upgrade container
container --version
```
Expected: `1.1.0`. If `brew upgrade` requires interactive sudo or fails, **stop, restore both services, and report BLOCKED** — a half-upgraded runtime with services down is the worst state.

- [ ] **Step 3: Restart the container system and both services**

```bash
container system stop 2>/dev/null; container system start
launchctl load ~/Library/LaunchAgents/com.nanoclaw-v2-581fefa4.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw-v2-011e3c4e.plist
sleep 8
tail -20 logs/nanoclaw.error.log
```

- [ ] **Step 4: Verify a real turn on THIS install**

Drive one agent turn end-to-end: insert a message into the active session's `inbound.db` (`data/v2-sessions/<group>/<session>/`, host uses **even** `seq` — read `src/router.ts` for the `messages_in` schema), wait up to ~4 minutes for the first spawn, and confirm a reply row appears in `outbound.db`. Confirm the container received `X_NANOCLAW_AGENT_TOKEN` (`container inspect <name>`; report presence + length, never the value) and that `logs/nanoclaw.log` contains no `rejected unauthenticated non-loopback request`.

- [ ] **Step 5: Verify the personal install still spawns**

READ-ONLY on that install: `container list` should show its containers running, or its log should show a healthy boot. **Do not modify it.** If it is broken by the upgrade, report immediately — that is the owner's other live system.

- [ ] **Step 6: Verify orphan reaping works on 1.x**

```bash
container list --all | grep -c stopped
```
Restart this install's service and confirm stopped orphans from this install are reaped (`cleanupOrphans` runs at boot). This is the behavior Task 3 protects; prove it against the real 1.x output shape.

- [ ] **Step 7: Record evidence**

No code commit unless something needed fixing. Write the upgrade evidence (versions, both installs' verification, reaping proof) into the report, and update `state.md`'s deployment section with the new runtime version in the same commit as Task 5.

**Rollback:** `brew uninstall container && brew install container@0.12.3` is not guaranteed available; the real rollback is `brew` pinning or reinstalling the prior bottle. Establish the rollback command **before** Step 2 and record it. If you cannot establish one, report BLOCKED and let the operator decide.

### Task 5: HTTP MCP transport support (port from the personal repo)

**This repo cannot express the servers we want.** `src/container-config.ts:21-29` defines `McpServerConfig` with a **required `command`** — stdio only. Every MCP server the operator actually uses is an **HTTP** server (`url` + `headers`). The personal repo already solved this; port it.

Three pieces, all from `/Users/admin/projects/nanoclaw_personal` (read-only source):
1. `McpServerConfig` gains optional `url` and `headers`, and `command` becomes optional (`src/container-config.ts`).
2. `host.docker.internal` → bridge-gateway rewrite (`src/container-config.ts:57-66`). Apple Container VMs cannot resolve `host.docker.internal`; the rewrite substitutes `CONTAINER_HOST_GATEWAY`. The personal repo also rewrites it inside `-e` args (`src/container-runner.ts:495-500`) — port both.
3. `src/mcp-header-env.ts` (`collectMcpHeaderEnvRefs`) + its spawn-time forwarding. Headers may reference secrets as `${VAR}`; the host collects exactly those names, forwards only those env vars into the container at spawn, and the in-container pi bridge expands them at connect time. **The secret lives in `.env` and the transient container env — never as a literal in the DB or committed config.**

**Security note to preserve in the code comments, not just here:** MCP bearer tokens differ from LLM keys. LLM keys never enter a container (the credential proxy substitutes them). MCP header tokens *do* enter the container env, so any agent wired to a credentialed server can read that token and use it directly, outside the MCP server. That is why the default set below is unauthenticated except `gc-wiki`.

**Files:**
- Modify: `src/container-config.ts` (type + gateway rewrite)
- Modify: `src/container-runner.ts` (`-e` arg rewrite; forward the collected header env vars at spawn)
- Create: `src/mcp-header-env.ts` + `src/mcp-header-env.test.ts` (port both)
- Modify: `container/agent-runner/src/providers/pi-mcp-bridge.ts` if it lacks `resolveHeaders` / HTTP-server support — compare against the personal repo's `harnesses/pi-mcp-bridge.ts` (they differ by ~53 lines; **Task 8 owns the full reconciliation, so port only what HTTP MCP needs here and leave the rest**)

**Interfaces:**
- Produces: `collectMcpHeaderEnvRefs(servers: Record<string, McpServerConfig>): string[]` — unique `${VAR}` names referenced in any header value.
- Produces: `McpServerConfig = { command?: string; args?: string[]; env?: Record<string,string>; url?: string; headers?: Record<string,string>; instructions?: string }`.

- [ ] **Step 1: Port `mcp-header-env.ts` with its test first**

```bash
cat /Users/admin/projects/nanoclaw_personal/src/mcp-header-env.ts
cat /Users/admin/projects/nanoclaw_personal/src/mcp-header-env.test.ts
```
Copy both. The test asserts `{ a: { url: 'http://x', headers: { Authorization: 'Bearer ${CUASSISTANT_MCP_TOKEN}' } } }` yields `['CUASSISTANT_MCP_TOKEN']`. Host test, **vitest**.

Run: `pnpm exec vitest run src/mcp-header-env.test.ts` → PASS.

- [ ] **Step 2: Widen `McpServerConfig`, watch the typecheck tell you every consumer**

Make `command` optional and add `url`/`headers`. Then:

```bash
pnpm run build
```
tsc will flag every site that assumed `command` is present. Fix each — a server with neither `command` nor `url` is invalid; **throw at config-read time with the server name**, do not silently skip it.

- [ ] **Step 3: Port the gateway rewrite, with a test**

Port `src/container-config.ts:57-66` (rewrite `url`) and `src/container-runner.ts:495-500` (rewrite `-e` args). Add a host test asserting a config with `http://host.docker.internal:8766/` comes back as `http://<CONTAINER_HOST_GATEWAY>:8766/`, and that a URL without that host is untouched.

**Prove it:** delete the rewrite, confirm the test FAILS; revert.

- [ ] **Step 4: Forward only the referenced secrets at spawn**

In `src/container-runner.ts` `buildContainerArgs`, call `collectMcpHeaderEnvRefs(config.mcpServers)`, read each name from `.env` via the repo's existing `readEnvFile` helper, and push `-e NAME=value` for each. **Never log the values.** A referenced var that is missing from `.env` must produce a loud warning naming the var and the server — a silently-unexpanded `${WIKI_MCP_TOKEN}` becomes a literal bearer string and the server returns 401 with no clue why.

Add a test asserting: given a config referencing `WIKI_MCP_TOKEN`, the built args contain `-e WIKI_MCP_TOKEN=...`; given a config with no headers, no extra env is forwarded.

- [ ] **Step 5: Both typechecks, both suites, commit**

```bash
pnpm test && pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
cd container/agent-runner && bun test && cd ../..
git add -A
git commit -m "feat(mcp): HTTP transport, gateway rewrite, and scoped header-secret forwarding"
```

### Task 6: Curated default MCP server set

**Depends on Task 5** (HTTP transport must exist first).

**The set** — decided by the operator 2026-07-10. Unauthenticated servers are safe to give everyone; `gc-wiki` is included deliberately despite its token. `cuassistant-credentialed` and `procurement` are **excluded** from the default and remain available through the `add_mcp_server` approval flow.

```json
{
  "cuassistant-public":  { "url": "http://host.docker.internal:8766/" },
  "cuassistant-catalog": { "url": "http://host.docker.internal:8767/" },
  "gc-alumni":           { "url": "http://host.docker.internal:8011/mcp" },
  "gc-wiki":             { "url": "http://gcworkflow.clemson.edu:3000/api/mcp",
                           "headers": { "Authorization": "Bearer ${WIKI_MCP_TOKEN}" } }
}
```

Write `host.docker.internal` literally — Task 5's rewrite converts it to the bridge gateway at spawn, and that keeps the config portable if the runtime ever changes back.

**Files:**
- Create: `config/default-mcp-servers.json` (exact content above)
- Modify: `src/group-init.ts` (seed a new group's `mcp_servers` from it)
- Create: `scripts/backfill-default-mcp-servers.ts`
- Test: `src/group-init.test.ts`

**Interfaces:**
- Produces: `readDefaultMcpServers(): Record<string, McpServerConfig>` exported from `src/group-init.ts`. Returns `{}` if the file is absent or unparsable — **never throw at group creation**; a malformed config must not prevent an agent from existing.

- [ ] **Step 1: `WIKI_MCP_TOKEN` must exist in this install's `.env`**

This repo's `.env` has none of the MCP tokens; the personal repo's has three. Copy **only** `WIKI_MCP_TOKEN` across, without printing it:

```bash
grep -q '^WIKI_MCP_TOKEN=' .env || grep '^WIKI_MCP_TOKEN=' /Users/admin/projects/nanoclaw_personal/.env >> .env
grep -c '^WIKI_MCP_TOKEN=' .env    # expect 1
chmod 600 .env
```
Do **not** copy `CUASSISTANT_MCP_TOKEN` or `PROCUREMENT_MCP_TOKEN` — those servers are not in the default set, and an unused secret in `.env` is a liability. Never echo any token value.

- [ ] **Step 2: Write the failing test**

In `src/group-init.test.ts`, point the config path at a temp `default-mcp-servers.json` holding one fake HTTP server, create a new group, and assert the created `container_configs` row's `mcp_servers` JSON contains it. Follow `src/default-participant.test.ts`'s temp-dir + `initTestDb` + `vi.mock('./config.js')` pattern.

Add a second case: an absent/malformed file yields `{}` and group creation still succeeds.

- [ ] **Step 3: Run, watch fail; implement**

Run: `pnpm exec vitest run src/group-init.test.ts` → FAIL (`mcp_servers` is `{}`).

Implement `readDefaultMcpServers()` and use it where `group-init.ts` writes the container config.

- [ ] **Step 4: Backfill the three existing groups**

All three currently have `mcp_servers = {}`. Write `scripts/backfill-default-mcp-servers.ts` (follow `scripts/backfill-container-configs.ts` for conventions) applying the default set to any group whose `mcp_servers` is empty — **do not overwrite a non-empty value.** Run it, then verify:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT agent_group_id, mcp_servers FROM container_configs"
```
Expected: all three carry the four servers.

- [ ] **Step 5: Rebuild the image and prove an agent can actually reach a server**

```bash
./container/build.sh
```
If COPY steps serve stale files, prune the builder and rebuild — `--no-cache` alone does not invalidate them.

Then drive one real agent turn (Task 4 Step 4's method) asking the agent to use a **`cuassistant-public`** tool (unauthenticated, so a failure is a wiring bug, not a token bug). Confirm a substantive reply.

Then a second turn against **`gc-wiki`**, which exercises the `${WIKI_MCP_TOKEN}` expansion end-to-end. A 401 here means the token did not expand — check the spawn args for `-e WIKI_MCP_TOKEN` (presence only; never print the value).

- [ ] **Step 6: Commit**

```bash
git add config/default-mcp-servers.json src/group-init.ts scripts/backfill-default-mcp-servers.ts src/group-init.test.ts
git commit -m "feat(mcp): curated default server set (cuassistant public+catalog, gc-alumni, gc-wiki)"
```

### Task 6b: Skills — confirm per-group confinement

**Nothing to port.** This repo's 16 container skills already superset the personal repo's 9, except `hermes-selflearning` (deferred) and `whatsapp-formatting` (unwanted). `self-customize` is **kept**: agents may write their own skills. This task proves that writing is confined.

**Files:**
- Create: `src/skills-confinement.test.ts`
- Modify: `container/skills/self-customize/SKILL.md` only if it documents behavior that is not true

**Interfaces:**
- Produces: a test proving an agent's self-authored skills land only under its own `groups/<folder>/` and that no group's container mounts another group's folder.

- [ ] **Step 1: Establish where self-authored skills are written**

```bash
grep -rn "skills" container/skills/self-customize/SKILL.md | head -20
grep -rn "custom-skills\|customSkills" src/channels/playground/ src/group-init.ts src/container-runner.ts | head -10
```
Record the exact path a new skill lands at and which mount makes it writable. Put it in your report — the rest of the task depends on it.

- [ ] **Step 2: Write the confinement test**

Test `buildMounts` (in `src/container-runner.ts`) directly: for group A, no mount source may resolve inside another group's folder, and the writable custom-skills mount must resolve under `groups/<A>/`.

Compare with `path.resolve` and a **trailing separator** — `resolved.startsWith(path.join(GROUPS_DIR, 'user_a') + path.sep)` — because a bare `startsWith('/groups/user_a')` also matches `/groups/user_ab`. Include `user_a` / `user_ab` as a case; that prefix trap is the bug this test exists to catch.

- [ ] **Step 3: Run it, then break it deliberately**

If it passes first try, say so and show the assertion. Then point group A's custom-skills mount at group B's folder, confirm the test FAILS, and revert. **A confinement test that never could have failed is worth nothing** — report the verbatim failure.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test(skills): pin per-group confinement of self-authored skills"
```

### Task 6c: Port the skills that teach the MCP servers

**Depends on Task 6.** An MCP server without its skill is a set of tools with no instructions — the agent has to guess the schema. These five skills exist in the personal repo as **per-group** skills (`groups/pi-test/skills/`, `groups/coco/skills/`). In this repo they become **shared container skills** (`container/skills/`), because every department agent gets the same curated server set.

Skill → server mapping, verified by grep of each `SKILL.md`:

| Skill | Server it drives | Default set? | Action |
|---|---|---|---|
| `clemson-curriculum` (27 lines) | `gc-wiki` | yes | **Port** |
| `clemson-scheduling` (26 lines) | `cuassistant-public` | yes | **Port** |
| `gc-advisor` (176 lines) | `cuassistant-catalog` | yes | **Port** |
| `gc-alumni` (82 lines) | `gc-alumni` | yes | **Port** |
| `clemson-procurement` (30 lines) | `procurement` | **no** (approval-only) | **Port, dormant** — ships the instructions so that when an operator approves the `procurement` server for a group, the skill is already there. Note in its `SKILL.md` that the server must be wired first. |
| `clemson-email` | `cuassistant-credentialed` + Gmail + Outlook | no | **Exclude** — email, and an excluded server. |
| `email-taskfinder` | `cuassistant-credentialed` + Gmail + Outlook | no | **Exclude** — same. |

**A trap:** `gc-alumni`'s `SKILL.md` contains the word `outlook` three times — it is the **BLS job-growth outlook column**, not Microsoft Outlook. Do not "helpfully" strip it. Verify by reading lines 44, 58, 81 before touching anything.

**Files:**
- Create: `container/skills/{clemson-curriculum,clemson-scheduling,gc-advisor,gc-alumni,clemson-procurement}/` (copy from `/Users/admin/projects/nanoclaw_personal/groups/pi-test/skills/`, which has all five; `coco` has a subset)
- Modify: whatever enumerates the shared skill set — find it (`grep -rn "container/skills" src/ container/ | head`) and confirm whether a new directory is picked up automatically or must be listed.

**Interfaces:**
- Produces: five skills mounted into every agent session, four of them backed by a wired server.

- [ ] **Step 1: Copy the five skills and read every line of each**

```bash
for s in clemson-curriculum clemson-scheduling gc-advisor gc-alumni clemson-procurement; do
  cp -R "/Users/admin/projects/nanoclaw_personal/groups/pi-test/skills/$s" "container/skills/$s"
done
```

Then **read each `SKILL.md` in full.** These were written for a single-user personal install. Check each for:
- hardcoded absolute paths that only exist in the personal install,
- references to `groups/pi-test/` or other personal-install group names,
- credentials, tokens, or personal data,
- instructions to use Gmail/Outlook/Calendar (must be removed — the operator excluded email and calendar; Task 2 deletes those tools entirely, so any such instruction would send the agent after a tool that does not exist),
- references to `cuassistant-credentialed` or `procurement` in the four default skills (they should reference only their own server).

Fix what you find; list every edit in your report with the reason.

- [ ] **Step 2: Confirm the shared-skill loader picks them up**

```bash
grep -rn "container/skills" src/container-runner.ts src/claude-md-compose.ts | head
```
`src/container-runner.ts:436` mounts `/app/skills/<skill>`; `claude-md-compose.ts:28` references `SHARED_SKILLS_CONTAINER_BASE`. Determine whether the skill set is discovered from the directory or enumerated somewhere (e.g. an enabled-skills list per group). **If it is enumerated, add the five there too** — a skill that ships but is never enabled is dead weight, and you will not notice from the tests.

- [ ] **Step 3: Rebuild the image**

```bash
./container/build.sh
```
If COPY steps serve stale files, prune the builder and rebuild.

- [ ] **Step 4: Prove an agent can actually use one, end to end**

Drive a real agent turn (Task 4 Step 4's method) with a question that requires `clemson-scheduling` (driven by the unauthenticated `cuassistant-public`, so a failure is a wiring bug, not a token bug). Confirm the agent invokes the tool and returns a substantive answer, not an apology.

Then one turn requiring `clemson-curriculum` (driven by `gc-wiki`), which exercises the `${WIKI_MCP_TOKEN}` expansion through a skill rather than a raw tool call.

- [ ] **Step 5: Commit**

```bash
git add container/skills/
git commit -m "feat(skills): port the five skills that drive the curated MCP servers

clemson-email and email-taskfinder deliberately excluded: they drive
Gmail/Outlook and the approval-only cuassistant-credentialed server."
```

### Task 7: Ports from the personal repo

**Do not port `hermes-selflearning`** — deferred by decision.

**Files:**
- Create: `fetch_url_to_workspace` in `container/agent-runner/src/mcp-tools/files.ts` (ported from `/Users/admin/projects/nanoclaw_personal/container/agent-runner/src/mcp-tools/files.ts`)
- Modify: `src/group-init.ts` (persona size guard, ported from `/Users/admin/projects/nanoclaw_personal/src/group-init.ts` + `agents-compose.test.ts`)

**Interfaces:**
- Produces: an agent tool that downloads a URL into its own workspace with SSRF protection; a fail-loud guard when a composed persona exceeds its size budget.

- [ ] **Step 1: Read the source implementations**

```bash
grep -n "fetch_url_to_workspace" -A 60 /Users/admin/projects/nanoclaw_personal/container/agent-runner/src/mcp-tools/files.ts
grep -rn "agents-compose\|composeGuard\|persona size" /Users/admin/projects/nanoclaw_personal/src/group-init.ts | head
```
Read them fully. **Do not blind-copy**: the personal repo has no per-container token and no `requireGroupAccess`. Verify the SSRF guard blocks the bridge gateway (`192.168.64.1`), `127.0.0.1`, `::1`, link-local `169.254.0.0/16`, and private ranges — the credential proxy and GWS relay live on that gateway, and Plan 1.5's whole point is that they must not be reachable by a confused agent. If the ported guard misses any of these, **fix it during the port** and say so.

- [ ] **Step 2: Port `fetch_url_to_workspace` with its tests**

Copy the tool and its tests into the container tree. Container tests import from `bun:test`. Add a test asserting the gateway address and each private range are refused. Run:

```bash
cd container/agent-runner && bun test && cd ../..
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```

- [ ] **Step 3: Port the persona size guard with its test**

Bring `agents-compose.test.ts`'s guard into this repo's `group-init.ts`. It must **fail loud** (throw, with the size and the limit in the message) rather than silently truncate. Host test, vitest.

- [ ] **Step 4: Full suites, both typechecks, commit**

```bash
pnpm test && pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
cd container/agent-runner && bun test && cd ../..
git add -A
git commit -m "feat(agent): SSRF-safe fetch_url_to_workspace + fail-loud persona size guard"
```

### Task 8: Pi harness reconciliation

**This is the judgment task of the plan.** `container/agent-runner/src/providers/pi.ts` differs from the personal repo's `harnesses/pi.ts` by **643 diff lines**; `pi-auth.ts` by 135, `pi-model.ts` by 127, `pi-mcp-bridge.ts` by 53. Each repo has fixes the other lacks: the personal install has per-group ChatGPT auth refinements; this one has the seq-bound usage backfill.

There is no mechanical merge. **Do not `git checkout` one over the other.**

**Files:**
- Modify: `container/agent-runner/src/providers/pi.ts`, `pi-auth.ts`, `pi-model.ts`, `pi-mcp-bridge.ts`
- Test: the existing `pi*.test.ts` in the same directory

**Interfaces:**
- Produces: one pi harness carrying both repos' fixes, with a written record of every hunk's disposition.

- [ ] **Step 1: Produce the categorized diff**

```bash
for f in pi.ts pi-auth.ts pi-model.ts pi-mcp-bridge.ts; do
  diff -u container/agent-runner/src/providers/$f \
          /Users/admin/projects/nanoclaw_personal/container/agent-runner/src/harnesses/$f \
    > /tmp/pi-diff-$f.txt
done
wc -l /tmp/pi-diff-*.txt
```

For **every** hunk, classify it in your report as one of:
- **take-personal** — a fix this repo lacks (name the bug it fixes)
- **keep-dept** — a fix the personal repo lacks (e.g. the seq-bound usage backfill)
- **divergent-intent** — the two repos genuinely want different behavior (e.g. anything touching the credential proxy, the per-container token, or scoped `ncl` — Plan 1.5 changed this repo's contract and the personal repo does not have those changes)
- **cosmetic** — formatting/renames; prefer this repo's form and move on

**Any hunk you cannot confidently classify is a `divergent-intent` until proven otherwise.** Report BLOCKED rather than guessing on the credential/auth paths — those are the ones Plan 1.5 hardened.

- [ ] **Step 2: Apply take-personal hunks one at a time, testing between**

After each hunk: `cd container/agent-runner && bun test`. A hunk that breaks a test is a `divergent-intent` in disguise; back it out and reclassify.

- [ ] **Step 3: Guard the Plan 1.5 contract**

Confirm, by grep, that after reconciliation the container still:
- sends `x-nanoclaw-agent-token` on proxy and relay calls (`proxy-fetch.ts`, `mcp-tools/gws.ts`),
- does not reintroduce any code that trusts `x-nanoclaw-agent-group` for identity,
- does not reintroduce an unscoped `ncl` call pattern.

```bash
grep -rn "x-nanoclaw-agent-token" container/agent-runner/src/ | head
grep -rn "x-nanoclaw-agent-group" container/agent-runner/src/ | head
```

- [ ] **Step 4: Both suites, both typechecks, live turn**

```bash
pnpm test && pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
cd container/agent-runner && bun test && cd ../..
./container/build.sh
```
Then drive one real agent turn (Task 4 Step 4's method) and confirm a reply, a populated `tokens`/`provider` on the usage row, and no proxy 401s. **The seq-bound usage backfill is the fix this repo has and the personal one lacks — verify the usage row is populated, or you have regressed it.**

- [ ] **Step 5: Commit with the disposition record**

```bash
git add -A
git commit -m "refactor(pi): reconcile harness with personal repo — best of both

Full hunk-by-hunk disposition in the task report."
```

### Task 9: Carry-over bug fixes

Each is independent; commit separately. All were found by the 2026-07-09 review or Plan 1's execution.

**Files:** `src/group-init.ts` (or wherever `composeGroupClaudeMd` lives), `src/container-runner.ts`, `container/agent-runner/src/poll-loop.ts`, `src/knowledge/corpus.ts`, `src/benchmarks/store.ts`

- [ ] **Step 1: `composeGroupClaudeMd` clobber ordering**

`composeGroupClaudeMd` re-materializes `container.json` **after** `ensureRuntimeFields` resolves the provider, wiping it. Symptom: a container dies at startup with a misleading `Module not found "/app/src/index.ts"` because `container.json` lacks `provider`. Reorder so `ensureRuntimeFields` runs last, and add a test asserting the written `container.json` has a non-empty `provider`. Prove the test fails against the old order.

- [ ] **Step 2: Dead `'claude'` provider fallback**

`src/container-runner.ts` (~line 260) `resolveProviderName` falls back to `'claude'`, which no longer registers a container config — a group with `agent_provider: null` gets `{}` silently instead of a clear error. Make it throw with the group id and the missing provider. Add a test.

- [ ] **Step 3: Readonly-DB follow-up-poll noise**

`SQLITE_READONLY_ROLLBACK` on the container's read-only `inbound.db` reads: the host's DELETE-journal commits leave a hot journal, and virtiofs does not propagate SQLite locks across kernels. `withReadonlyRetry` guards only outbound *writes*. Wrap the inbound read in the same retry. Non-fatal today; it is masking noise that could hide a real error.

- [ ] **Step 4: `GROUPS_DIR` bug**

`src/knowledge/corpus.ts:6` and `src/benchmarks/store.ts:6` build `path.join(folder, 'knowledge', …)` with no `GROUPS_DIR` prefix, so corpora land at the repo root instead of under `groups/`. Per-folder isolated (no cross-tenant leak) but wrong. Fix both, and add a test asserting the resolved path is under `GROUPS_DIR`. Note that a test run previously dropped a stray `user_bob/` at the repo root — that was this bug.

- [ ] **Step 5: Budget the knowledge/RAG routes**

Corpus ingest/query and benchmark runs spend on embeddings with no cap (they are authorization-gated to the caller's own group, so this is cost, not isolation). Apply `assertWithinBudget` at those routes, returning 429, mirroring Task 1's pattern. Add one route-level test per route family.

- [ ] **Step 6: Full suites, both typechecks; commit each fix separately**

### Task 10: Dependency audit

Never completed: `pnpm audit --prod` was not run to completion, and `container/agent-runner/`'s Bun dependencies have **no** `minimumReleaseAge` policy and were never pin-audited.

- [ ] **Step 1: Host audit**

```bash
pnpm audit --prod
```
Report only actionable, reachable vulnerabilities — a transitive dev-only advisory is noise. For each: the package, the path, whether the vulnerable code is reachable from this codebase, and the fix.

- [ ] **Step 2: Container dep audit**

Read `container/agent-runner/package.json`. For every runtime dependency: is the version an exact pin or a range? Check each against npm for recency and provenance. `bun install` here does **not** honor the repo's `minimumReleaseAge` policy (that is pnpm-only), so a fresh malicious version could be pulled at build time.

Recommend (do not apply without operator sign-off) exact pins for anything on a range.

- [ ] **Step 3: Supply-chain policy check**

```bash
grep -n -A6 "minimumReleaseAgeExclude\|onlyBuiltDependencies" pnpm-workspace.yaml
```
Per `CLAUDE.md`, entries in either list require human approval and `minimumReleaseAgeExclude` must pin exact versions, never ranges. Report any entry that violates this. **Do not add or remove entries.**

- [ ] **Step 4: Write findings; commit only doc changes**

```bash
git add -A
git commit -m "docs(security): dependency audit findings for host and container trees"
```

---

## Success criteria

1. A normal agent turn is refused with 429 once its group is over budget (proven at the proxy, not just in a unit test).
2. No agent, with or without its own Google credentials, can reach the owner's Drive; no agent has any Gmail or Calendar tool.
3. `container --version` is 1.1.0, both installs spawn containers, orphan reaping works against the 1.x status shape.
4. A new agent group is created with the curated MCP set already wired; `add_mcp_server` still routes to admin approval. An agent answers a real question through `cuassistant-public` (unauthenticated) **and** through `gc-wiki` (proving `${WIKI_MCP_TOKEN}` expands).
5. The five associated skills ship; an agent uses `clemson-scheduling` and `clemson-curriculum` end to end. No skill instructs the agent to use Gmail, Outlook, or Calendar.
6. An agent's self-authored skills are provably confined to its own group folder.
6. One pi harness carries both repos' fixes; a live turn produces a reply **and** a populated usage row.
7. All of Plan 1.5's guarantees still hold: `pnpm test` green, and a container still cannot reach the proxy or relay without its token.

## Out of scope (deliberately)

- **`hermes-selflearning`** and the memory/self-learning loop — a later phase, by decision.
- **Retiring `PLAYGROUND_AUTH_BYPASS`** and per-user login/invites — Plan 3. Until it lands, every web session is the owner; do not invite anyone.
- **Per-user ChatGPT OAuth and the backstop-warning UX** — Plan 4.
- **Homepage reorganization, admin roster, Telegram self-serve linking** — Plan 5.
- **Container network isolation (C8)** — container↔container and container↔LAN reachability remain. Mitigated (the host services now require a token). If it is ever done, it belongs with the runtime work in Task 4, not bolted on elsewhere.
- **Architectural splits** (`api-routes.ts` at 1,205 LOC / 72 routes; `credential-proxy.ts` at 871; identity unified on the `users` table). Real, and recommended *before* Plans 3–5 land new routes and auth flows in those same files — but they are refactors, not this plan's subject.
