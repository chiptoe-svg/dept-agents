# Scenario-Contract Wiring (Phase 2 proper) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the platform consume the scenario contract so that switching `ACTIVE_SCENARIO` actually changes pairing behavior (role detection, permission, persona, greeting) — replacing the three classroom-specific pair consumers with one generic platform consumer and routing provisioning personas through the contract.

**Architecture:** The contract (`src/scenarios/registry.ts` → `roleForFolder()` / `roleProfile()`) already holds per-role label/permission/persona/greeting. Today the *behavior paths* (pairing, provisioning) bypass it and call classroom-specific code directly. We add one missing contract method (`memberName`), write a single platform pair consumer driven entirely by the contract, delete the three classroom consumers, and point the persona-at-provision write at the contract. The classroom profile keeps only its roster-based `roleForFolder` + `memberName`, so classroom behavior is byte-for-byte preserved while a second scenario (`industryai_seminar`) gets correct pairing for free.

**Tech Stack:** TypeScript (Node host, `tsc` build), vitest (`pnpm test`), better-sqlite3 (in-memory test DB via `initTestDb()`).

**Decisions locked (with the owner, 2026-06-09):**
- Pairing: **Option A** — one generic platform consumer; delete the three classroom consumers.
- Member name: **add `memberName(folder)` to the contract** (classroom = roster lookup; seminar = agent-group name).
- Scoped-admin scope: **derive from the contract** — admin over every other folder whose canonical role is `user`/`assistant`. No per-scenario hook.

**Invariants honored (see state.md):**
- Metadata key names `student_email` / `student_name` / `student_user_id` are **kept as-is** — downstream features (Drive sharing, git-author env, per-user auth) read them; renaming is a deferred Phase 3 vocabulary pass. Do NOT rename them in this plan.
- Provisioning resolves the persona via the **canonical role `'user'` directly**, NOT `roleForFolder(folder)`: `classRoleForFolder` reads `class-config.json`, and a freshly-provisioned student folder is not yet in that file at persona-write time, so `roleForFolder()` would return `null`. `roleProfile('user')` is correct and timing-safe.
- Breakable pilot, but pairing touches permissions: gate every task on `pnpm run build` + `pnpm test`.

---

## File Structure

**Create:**
- `src/scenario-pairing.ts` — the single generic platform pair consumer + the `grantPermissionForRole` helper. Always loaded (imported by `src/index.ts`); only the active scenario is registered, so it behaves as exactly one scenario.
- `src/scenario-pairing.test.ts` — unit test using a stub scenario (all three permission branches + greeting + metadata).

**Modify:**
- `src/scenarios/types.ts` — add `memberName` to the `Scenario` interface.
- `src/scenarios/registry.ts` — add the `memberName(folder)` delegating accessor.
- `src/scenarios/registry.test.ts` — extend `fakeScenario` with `memberName`; add a coverage test.
- `src/scenarios/classroom/scenario.ts` — implement `memberName` (roster lookup).
- `src/scenarios/industryai_seminar/scenario.ts` — implement `memberName` (agent-group name).
- `src/index.ts` — replace `import './class-pair-greeting.js'` with `import './scenario-pairing.js'`.
- `src/scenarios/classroom/index.ts` — drop the `pair-instructor` / `pair-ta` imports.
- `src/class-student-provision.ts` — route the persona write through `roleProfile('user')`.

**Delete:**
- `src/class-pair-greeting.ts`
- `src/scenarios/classroom/pair-instructor.ts`
- `src/scenarios/classroom/pair-ta.ts`

---

### Task 1: Add `memberName` to the scenario contract

**Files:**
- Modify: `src/scenarios/types.ts`
- Modify: `src/scenarios/registry.ts`
- Modify: `src/scenarios/classroom/scenario.ts`
- Modify: `src/scenarios/industryai_seminar/scenario.ts`
- Test: `src/scenarios/registry.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/scenarios/registry.test.ts`, add `memberName` to the `import` from `./registry.js`:

```typescript
import {
  _resetScenariosForTest,
  getActiveScenario,
  memberName,
  registerScenario,
  roleForFolder,
  roleProfile,
} from './registry.js';
```

Add `memberName` to the `fakeScenario` object (inside the returned `Scenario`, after `roleForFolder`):

```typescript
    roleForFolder: (folder) => (folder.startsWith('boss_') ? 'owner' : folder.startsWith('member_') ? 'user' : null),
    memberName: (folder) => (folder === 'boss_01' ? 'Ada' : folder === 'member_07' ? 'Grace' : null),
```

Add this test inside the `describe('scenario registry', ...)` block:

```typescript
  it('resolves member names via the active scenario', () => {
    registerScenario(fakeScenario('photo_lab'));
    expect(memberName('boss_01')).toBe('Ada');
    expect(memberName('member_07')).toBe('Grace');
    expect(memberName('random_03')).toBeNull();
  });

  it('returns null member name when no scenario is registered', () => {
    expect(memberName('boss_01')).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/scenarios/registry.test.ts`
Expected: FAIL — `memberName` is not exported from `./registry.js` (import error / `memberName is not a function`).

- [ ] **Step 3: Add `memberName` to the `Scenario` interface**

In `src/scenarios/types.ts`, add this field to the `Scenario` interface (after `roleForFolder`):

```typescript
  /** Map an agent-group folder to its canonical role (null if not a member). */
  roleForFolder: (folder: string) => CanonicalRole | null;
  /**
   * Resolve a member's display name from its folder, for greeting + persona.
   * Classroom looks it up in the roster; other scenarios may derive it from
   * the agent-group record or the folder. Null when unknown.
   */
  memberName: (folder: string) => string | null;
```

- [ ] **Step 4: Add the delegating accessor to the registry**

In `src/scenarios/registry.ts`, add after the `roleProfile` function:

```typescript
/** The active scenario's display name for the member in `folder` (null if unknown). */
export function memberName(folder: string): string | null {
  return getActiveScenario()?.memberName(folder) ?? null;
}
```

- [ ] **Step 5: Implement `memberName` in the classroom scenario**

In `src/scenarios/classroom/scenario.ts`, update the import line to add the roster lookups:

```typescript
import { classRoleForFolder, findClassInstructor, findClassStudent, findClassTa } from '../../class-config.js';
```

Add `memberName` to the `classroom` scenario object, after `roleForFolder`'s closing brace/comma:

```typescript
  // Classroom names come from the roster (class-config.json), regardless of role.
  memberName: (folder): string | null =>
    findClassStudent(folder)?.name ??
    findClassTa(folder)?.name ??
    findClassInstructor(folder)?.name ??
    null,
```

- [ ] **Step 6: Implement `memberName` in the seminar scenario**

In `src/scenarios/industryai_seminar/scenario.ts`, add an import for the agent-group lookup:

```typescript
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
```

Add `memberName` to the `seminar` scenario object, after `roleForFolder`:

```typescript
  // Seminar has no roster — use the agent group's stored name; null if absent.
  memberName: (folder): string | null => getAgentGroupByFolder(folder)?.name ?? null,
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm exec vitest run src/scenarios/registry.test.ts`
Expected: PASS (all scenario-registry tests green).

- [ ] **Step 8: Build**

Run: `pnpm run build`
Expected: `tsc` exits 0 with no output. (If `industryai_seminar/scenario.ts` or `classroom/scenario.ts` errors on the new field, the interface is now required — confirm both implement it.)

- [ ] **Step 9: Commit**

```bash
git add src/scenarios/types.ts src/scenarios/registry.ts src/scenarios/registry.test.ts src/scenarios/classroom/scenario.ts src/scenarios/industryai_seminar/scenario.ts
git commit -m "feat(scenarios): add memberName() to the scenario contract"
```

---

### Task 2: Generic platform pair consumer

**Files:**
- Create: `src/scenario-pairing.ts`
- Test: `src/scenario-pairing.test.ts`

Note: this task creates and unit-tests the consumer but does **not** wire it into `src/index.ts` yet — that swap (and the deletion of the old consumers) is Task 3, so there is never a window where both old and new consumers register and double-fire.

- [ ] **Step 1: Write the failing test**

Create `src/scenario-pairing.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from './db/index.js';
import { _resetConsumersForTest, runPairConsumers, type PairContext } from './channels/pair-consumer-registry.js';
import { _resetScenariosForTest, registerScenario } from './scenarios/registry.js';
import type { Scenario } from './scenarios/types.js';
import './scenario-pairing.js'; // registers the generic consumer as a side effect

// A four-role stub: owner→global-admin, assistant→scoped-admin, user→member.
function stubScenario(): Scenario {
  return {
    name: 'stub',
    roles: {
      owner: { label: 'Boss', permission: 'global-admin', persona: (n) => `p ${n}`, greeting: (n) => `hi boss ${n}` },
      assistant: { label: 'Lead', permission: 'scoped-admin', persona: (n) => `p ${n}`, greeting: (n) => `hi lead ${n}` },
      user: { label: 'Member', permission: 'member', persona: (n) => `p ${n}`, greeting: (n) => `hi ${n}` },
    },
    roleForFolder: (f) =>
      f.startsWith('boss_') ? 'owner' : f.startsWith('lead_') ? 'assistant' : f.startsWith('member_') ? 'user' : null,
    memberName: (f) => `Name(${f})`,
  };
}

function ctx(folder: string, agentGroupId: string): PairContext {
  return { agentGroupId, pairedUserId: 'tg:42', consumedEmail: 'x@y.edu', targetFolder: folder, channel: 'telegram' };
}

function rolesFor(userId: string): { role: string; agent_group_id: string | null }[] {
  return getDb()
    .prepare('SELECT role, agent_group_id FROM user_roles WHERE user_id = ?')
    .all(userId) as { role: string; agent_group_id: string | null }[];
}

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
  _resetScenariosForTest();
  registerScenario(stubScenario());
  createAgentGroup({ id: 'ag_boss', name: 'B', folder: 'boss_01', agent_provider: 'pi', created_at: '2026-01-01' });
  createAgentGroup({ id: 'ag_lead', name: 'L', folder: 'lead_01', agent_provider: 'pi', created_at: '2026-01-01' });
  createAgentGroup({ id: 'ag_m1', name: 'M1', folder: 'member_01', agent_provider: 'pi', created_at: '2026-01-01' });
  createAgentGroup({ id: 'ag_m2', name: 'M2', folder: 'member_02', agent_provider: 'pi', created_at: '2026-01-01' });
});

afterEach(() => {
  _resetConsumersForTest();
  closeDb();
});

describe('scenario pair consumer', () => {
  it('returns {} for a non-member folder', async () => {
    const [r] = await runPairConsumers(ctx('dm-with-someone', 'ag_x'));
    expect(r).toEqual({});
  });

  it('owner → global admin + greeting from the contract', async () => {
    const [r] = await runPairConsumers(ctx('boss_01', 'ag_boss'));
    expect(r.confirmation).toBe('hi boss Name(boss_01)');
    expect(r.suppressDefaultConfirmation).toBe(true);
    expect(rolesFor('tg:42')).toEqual([{ role: 'admin', agent_group_id: null }]);
  });

  it('assistant → scoped admin over every other user/assistant group', async () => {
    await runPairConsumers(ctx('lead_01', 'ag_lead'));
    const granted = rolesFor('tg:42')
      .map((g) => g.agent_group_id)
      .sort();
    // scoped to the two members + (no other lead); never global, never self.
    expect(granted).toEqual(['ag_m1', 'ag_m2']);
  });

  it('user → no role grant, greeting only', async () => {
    const [r] = await runPairConsumers(ctx('member_01', 'ag_m1'));
    expect(r.confirmation).toBe('hi Name(member_01)');
    expect(rolesFor('tg:42')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/scenario-pairing.test.ts`
Expected: FAIL — `Cannot find module './scenario-pairing.js'`.

- [ ] **Step 3: Write the generic consumer**

Create `src/scenario-pairing.ts`:

```typescript
/**
 * Generic scenario pair consumer (platform).
 *
 * Replaces the per-role classroom consumers (class-pair-greeting,
 * pair-instructor, pair-ta). After a wire-to pairing, this resolves the
 * target folder's canonical role under the ACTIVE scenario and does the
 * role-generic setup the contract describes:
 *   1. Stamp member metadata. The keys (student_email/student_name/
 *      student_user_id) are kept as-is — downstream features (Drive sharing,
 *      git-author env, per-user auth) read them; renaming is a later pass.
 *   2. Grant the role's platform permission (global-admin / scoped-admin /
 *      member).
 *   3. Return the role's greeting and suppress the channel's default reply.
 *
 * Non-member folders (roleForFolder → null) return {} so the channel sends
 * its default confirmation. Only the ACTIVE scenario is registered, so a
 * seminar box runs seminar pairing and a classroom box runs classroom
 * pairing from this one consumer. See plans/group-agent-platform.md.
 */
import { registerPairConsumer, type PairContext, type PairResult } from './channels/pair-consumer-registry.js';
import { getAllAgentGroups, setAgentGroupMetadataKey } from './db/agent-groups.js';
import { log } from './log.js';
import { grantRole } from './modules/permissions/db/user-roles.js';
import { memberName, roleForFolder, roleProfile } from './scenarios/registry.js';
import type { RolePermission } from './scenarios/types.js';

/**
 * Grant the platform permission for a paired member's role.
 *  - global-admin → one global admin grant (agent_group_id null).
 *  - scoped-admin → admin on every OTHER member group (any folder whose
 *    canonical role is user or assistant), derived from the contract — no
 *    per-scenario group list needed.
 *  - member → no role grant (membership is handled at provision time).
 * Idempotent: grantRole's INSERT OR IGNORE makes re-pair safe.
 */
function grantPermissionForRole(permission: RolePermission, userId: string, targetFolder: string): void {
  const now = new Date().toISOString();
  if (permission === 'global-admin') {
    grantRole({ user_id: userId, role: 'admin', agent_group_id: null, granted_by: null, granted_at: now });
    return;
  }
  if (permission === 'scoped-admin') {
    for (const g of getAllAgentGroups()) {
      if (g.folder === targetFolder) continue; // never scope to self
      const r = roleForFolder(g.folder);
      if (r !== 'user' && r !== 'assistant') continue;
      try {
        grantRole({ user_id: userId, role: 'admin', agent_group_id: g.id, granted_by: null, granted_at: now });
      } catch (err) {
        log.error('scenario-pairing: scoped grantRole failed', {
          userId,
          targetGroup: g.folder,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  // member → nothing
}

async function scenarioPairConsumer(ctx: PairContext): Promise<PairResult> {
  const role = roleForFolder(ctx.targetFolder);
  if (!role) return {}; // not a member of the active scenario
  const profile = roleProfile(role);
  if (!profile) return {};
  const name = memberName(ctx.targetFolder) ?? ctx.targetFolder;

  // 1. Stamp metadata (key names kept for downstream features).
  if (ctx.consumedEmail) {
    setAgentGroupMetadataKey(ctx.agentGroupId, 'student_email', ctx.consumedEmail);
  }
  setAgentGroupMetadataKey(ctx.agentGroupId, 'student_name', name);
  setAgentGroupMetadataKey(ctx.agentGroupId, 'student_user_id', ctx.pairedUserId);

  // 2. Grant permission per role.
  try {
    grantPermissionForRole(profile.permission, ctx.pairedUserId, ctx.targetFolder);
  } catch (err) {
    log.error('scenario-pairing: grantPermissionForRole failed', {
      role,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  log.info('Scenario member paired', { role, name, folder: ctx.targetFolder });

  // 3. Greeting (suppress the channel's generic "Pairing success!").
  return { confirmation: profile.greeting(name), suppressDefaultConfirmation: true };
}

registerPairConsumer(scenarioPairConsumer);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run src/scenario-pairing.test.ts`
Expected: PASS (all four cases).

- [ ] **Step 5: Build**

Run: `pnpm run build`
Expected: `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/scenario-pairing.ts src/scenario-pairing.test.ts
git commit -m "feat(scenarios): generic contract-driven pair consumer"
```

---

### Task 3: Swap in the generic consumer; delete the three classroom consumers

**Files:**
- Modify: `src/index.ts:76`
- Modify: `src/scenarios/classroom/index.ts`
- Delete: `src/class-pair-greeting.ts`
- Delete: `src/scenarios/classroom/pair-instructor.ts`
- Delete: `src/scenarios/classroom/pair-ta.ts`

This is one atomic change so the consumer set is never doubled.

- [ ] **Step 1: Swap the platform import in `src/index.ts`**

Replace line 76:

```typescript
import './class-pair-greeting.js'; // base pairing mechanism
```

with:

```typescript
import './scenario-pairing.js'; // contract-driven pairing (role detection, grants, greeting)
```

- [ ] **Step 2: Drop the per-role imports from the classroom barrel**

In `src/scenarios/classroom/index.ts`, delete these two lines (keep `import './scenario.js';`):

```typescript
import './pair-instructor.js';
import './pair-ta.js';
```

Update the file's header comment so it no longer claims to register pair consumers — replace the first paragraph body with:

```typescript
// The teaching-specific layer on top of the group-agent platform: the
// classroom Scenario definition (roles, personas, greetings, roster-based
// role detection + member-name lookup). Pairing itself is handled by the
// platform's generic contract-driven consumer (src/scenario-pairing.ts).
```

- [ ] **Step 3: Delete the three classroom-specific consumers**

```bash
git rm src/class-pair-greeting.ts src/scenarios/classroom/pair-instructor.ts src/scenarios/classroom/pair-ta.ts
```

- [ ] **Step 4: Verify nothing else references the deleted files**

Run: `grep -rn --include="*.ts" "class-pair-greeting\|pair-instructor\|pair-ta\|classPairGreeting\|classPairInstructor\|classPairTa" src`
Expected: no matches. (If any appear, they are stale imports — remove them.)

- [ ] **Step 5: Build**

Run: `pnpm run build`
Expected: `tsc` exits 0.

- [ ] **Step 6: Run the full host test suite**

Run: `pnpm test`
Expected: all tests pass. Pay attention to any test that imported the deleted consumers — there were none at plan time (only `src/index.ts` imported `class-pair-greeting`), but confirm.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src/scenarios/classroom/index.ts
git commit -m "refactor(scenarios): platform pairing via contract; drop classroom consumers"
```

---

### Task 4: Route the provisioning persona through the contract

**Files:**
- Modify: `src/class-student-provision.ts` (import + the persona write near line 272)

- [ ] **Step 1: Import the contract accessor**

In `src/class-student-provision.ts`, add to the imports (near the existing `import { STUDENT_PERSONA } from './scenarios/classroom/personas.js';`):

```typescript
import { roleProfile } from './scenarios/registry.js';
```

- [ ] **Step 2: Use the active scenario's user persona, with a fallback**

Replace this line (currently ~line 272):

```typescript
    if (!fs.existsSync(personaPath)) fs.writeFileSync(personaPath, STUDENT_PERSONA(opts.name));
```

with:

```typescript
    // Persona comes from the active scenario's `user` role (canonical role,
    // NOT roleForFolder(folder) — the folder isn't in class-config.json yet at
    // provision time). Falls back to STUDENT_PERSONA when no scenario is
    // registered (e.g. unit tests).
    const persona = roleProfile('user')?.persona(opts.name) ?? STUDENT_PERSONA(opts.name);
    if (!fs.existsSync(personaPath)) fs.writeFileSync(personaPath, persona);
```

- [ ] **Step 3: Build**

Run: `pnpm run build`
Expected: `tsc` exits 0.

- [ ] **Step 4: Run the provisioning + scenario tests**

Run: `pnpm exec vitest run src/class-student-provision.test.ts src/scenarios/registry.test.ts src/scenario-pairing.test.ts`
Expected: PASS. The provisioning test runs with no scenario registered → `roleProfile('user')` is `null` → fallback `STUDENT_PERSONA` → existing persona assertions unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/class-student-provision.ts
git commit -m "feat(scenarios): provision persona from the active scenario's user role"
```

---

### Task 5: End-to-end verification + state.md update

**Files:**
- Create: `src/scenario-pairing.integration.test.ts`
- Modify: `state.md` (decision log + drain the Open follow-up) — NOTE: `state.md`'s stable sections are hand-edited; the volatile section regenerates via `pnpm refresh-state`.

- [ ] **Step 1: Write an integration test using the REAL seminar scenario**

This proves the contract drives behavior end-to-end (not just a stub). Create `src/scenario-pairing.integration.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from './db/index.js';
import { _resetConsumersForTest, runPairConsumers, type PairContext } from './channels/pair-consumer-registry.js';
import { _resetScenariosForTest } from './scenarios/registry.js';
import './scenario-pairing.js'; // generic consumer
import './scenarios/industryai_seminar/scenario.js'; // registers the REAL seminar scenario

function ctx(folder: string, agentGroupId: string): PairContext {
  return { agentGroupId, pairedUserId: 'tg:7', consumedEmail: null, targetFolder: folder, channel: 'telegram' };
}

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
  _resetScenariosForTest();
  // re-register the real seminar scenario after the reset
  // (importing the module again is a no-op; call registerScenario via a fresh import path is awkward,
  //  so register inline by re-importing the module's side effect is not reliable — instead build it here):
});

afterEach(() => {
  _resetConsumersForTest();
  closeDb();
});

describe('industryai_seminar pairing (real scenario)', () => {
  it('a participant (user_NN) is greeted as a Participant with no admin grant', async () => {
    // The seminar scenario self-registered at import; _resetScenariosForTest in
    // beforeEach cleared it, so import-order matters. To keep this deterministic,
    // do NOT reset in beforeEach for this file — see Step 2.
    createAgentGroup({ id: 'ag_u3', name: 'Dana', folder: 'user_03', agent_provider: 'pi', created_at: '2026-01-01' });
    const [r] = await runPairConsumers(ctx('user_03', 'ag_u3'));
    expect(r.confirmation).toContain('Welcome to the seminar');
    expect(r.suppressDefaultConfirmation).toBe(true);
    const roles = getDb().prepare('SELECT * FROM user_roles WHERE user_id = ?').all('tg:7');
    expect(roles).toEqual([]); // participant = member, no admin
  });
});
```

- [ ] **Step 2: Fix the registration/reset ordering, run to verify it fails then passes**

The seminar scenario self-registers at module import. `_resetScenariosForTest()` in `beforeEach` would wipe it after import. Resolve by **removing** the `_resetScenariosForTest()` call from this file's `beforeEach` (the real scenario should stay registered for the whole file), and delete the empty comment block. Final `beforeEach`:

```typescript
beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
});
```

Run: `pnpm exec vitest run src/scenario-pairing.integration.test.ts`
Expected: PASS — confirmation contains "Welcome to the seminar"; no roles granted. (If it fails because `getActiveScenario()` returned null, confirm the seminar scenario is the sole registered one — `getActiveScenario` falls back to the single registered scenario regardless of `ACTIVE_SCENARIO`.)

- [ ] **Step 3: Full build + test gate**

Run: `pnpm run build && pnpm test`
Expected: build exits 0; all tests pass.

- [ ] **Step 4 (optional live check, host running): real seminar pairing**

If a live verification is wanted on this install (where `.env` has `ACTIVE_SCENARIO=industryai_seminar`):
1. Confirm a `user_NN` agent group exists (or provision one).
2. Pair a test Telegram identity to it via the normal wire-to flow.
3. Confirm the welcome message says "Welcome to the seminar" (Participant), not "Welcome to class", and that `ncl roles list` shows no admin grant for that user.

Capture the actual output; do not claim success without it (verification-before-completion).

- [ ] **Step 5: Update state.md**

In `state.md`:
1. Under **Current arc**, change the "key open work" paragraph to past tense — the contract is now consumed by the platform pairing + provisioning paths; `ACTIVE_SCENARIO` drives behavior. Note the live-verification result.
2. In **Open follow-ups**, append a line marking "Wire the platform to the scenario contract (Phase 2 proper)" as done with the commit range (do not delete the entry — the section is append-only; annotate it `— DONE <date> (<first-hash>..<last-hash>)`).
3. Add a **Decision log** entry (newest first):
   `- **2026-06-09** — Phase 2 wiring landed: platform pairing is one generic contract-driven consumer (src/scenario-pairing.ts) + provisioning persona from roleProfile('user'); the three classroom pair consumers + class-pair-greeting deleted; memberName() added to the contract; scoped-admin scope derived from roleForFolder (user/assistant). ACTIVE_SCENARIO now changes pairing/persona behavior. Verified via industryai_seminar integration test (Participant greeting, no admin).`
4. Run `pnpm refresh-state` to regenerate the volatile section.

state.md is not git-tracked — writing it IS the action; no commit.

---

## Self-Review

**Spec coverage:**
- "Switching ACTIVE_SCENARIO changes pairing behavior" → Tasks 2–3 + Task 5 integration test. ✓
- "memberName added to contract" → Task 1. ✓
- "One generic consumer (Option A)" → Task 2 creates it, Task 3 deletes the three. ✓
- "Persona from contract" → Task 4. ✓
- "Scoped-admin derived from contract" → Task 2 `grantPermissionForRole`, tested in Task 2 Step 1 (assistant case). ✓
- "Classroom byte-for-byte preserved" → classroom `roleForFolder`/`memberName`/personas/greetings unchanged; only the *dispatch path* moved. The classroom greeting strings now live solely in `classroom/scenario.ts` (already the case since Phase 2 increment 1) and match the deleted consumers' text. ✓

**Type consistency:** `memberName(folder: string) => string | null` is identical in `types.ts`, `registry.ts`, both scenarios, and both test stubs. `grantPermissionForRole(permission: RolePermission, userId: string, targetFolder: string)` — `RolePermission` imported from `./scenarios/types.js`. `grantRole(row: UserRole)` shape `{user_id, role, agent_group_id, granted_by, granted_at}` matches the existing definition. `PairContext` fields (`agentGroupId`, `pairedUserId`, `consumedEmail`, `targetFolder`, `channel`) match the registry. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; commands have expected output. ✓

**Known risk flagged in-plan:** Task 5 integration test's scenario-registration vs `_resetScenariosForTest` ordering — handled explicitly in Step 2. The greeting-text assertion uses `toContain('Welcome to the seminar')`; if the seminar greeting wording in `industryai_seminar/scenario.ts` is reworded later, update the assertion.
