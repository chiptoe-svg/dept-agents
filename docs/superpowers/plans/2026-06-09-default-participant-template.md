# Default Participant Template Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner define a Participant default (persona/CLAUDE.md/skills/model) via a dedicated template agent + "Save as default", have new Participants provision from it (scenario-correct folders), and reset all existing Participants to it reversibly.

**Architecture:** A dedicated flagged agent group `_default_participant` is edited via the existing workbench; "Save as default" snapshots it (files + `container_configs` serialized) into `data/config/default-participant/`. Provisioning becomes scenario-aware (folder prefix from the scenario contract) and reads that slot for content, with `roleProfile('user')` as the no-default fallback. "Apply to all" backs up each `user`-role group into its own agent-library, overwrites from the slot, and restarts the container.

**Tech Stack:** TypeScript (Node host, `tsc`), vitest (in-memory `initTestDb`), better-sqlite3. Spec: `docs/superpowers/specs/2026-06-09-default-participant-template-design.md`.

**Verified APIs (use these exactly):**
- Scenario contract: `src/scenarios/types.ts` (`Scenario`, `CanonicalRole`), `src/scenarios/registry.ts` (`getActiveScenario`, `roleForFolder`, `roleProfile`, `_resetScenariosForTest`, `registerScenario`).
- container_configs (`src/db/container-configs.ts`): `getContainerConfig(id): ContainerConfigRow|undefined`, `createContainerConfig(row: ContainerConfigRow)`, `updateContainerConfigScalars(id, {provider,model,effort,image_tag,assistant_name,max_messages_per_prompt,cli_scope,model_provider})`, `updateContainerConfigJson(id, column, value)` where column ∈ `'skills'|'mcp_servers'|'packages_apt'|'packages_npm'|'additional_mounts'|'env'|'allowed_models'` (value is the raw object/array; it stringifies internally). `ContainerConfigRow` fields: `agent_group_id, provider, model, effort, image_tag, assistant_name, max_messages_per_prompt, skills, mcp_servers, packages_apt, packages_npm, additional_mounts, cli_scope, env, allowed_models` (+ `model_provider`); all JSON columns are JSON-encoded strings on the row.
- agent-library (`src/channels/playground/api/agent-library.ts`): `saveEntry(folder, slug, includeMemory)`, `loadEntry(folder, slug)`. Snapshots `CLAUDE.md`, `container.json`, `custom-skills/`, and `CLAUDE.local.md` when `includeMemory`.
- restart: `restartAgentGroupContainers(agentGroupId, reason, wakeMessage?): number` (`src/container-restart.ts`).
- groups: `getAllAgentGroups()`, `getAgentGroupByFolder(folder)`, `getAgentGroup(id)`, `createAgentGroup(row)`, `setAgentGroupMetadataKey(id,k,v)`, `getAgentGroupMetadata(id)` (`src/db/agent-groups.ts`).
- gating: `isOwner`, `isGlobalAdmin` (`src/modules/permissions/db/user-roles.ts`); pattern `isOwnerOrAdmin` in `src/channels/playground/api/enrollment.ts`.
- paths (`src/config.ts`): `GROUPS_DIR`, `DATA_DIR`.

**Conventions:** host tests use `vitest` + `initTestDb()`/`runMigrations(getDb())`/`closeDb()` (in-memory). `pnpm run build` = tsc. `pnpm test` = full suite. Commit after each task. Branch first (not on `main`).

---

### Task 1: Scenario contract — `folderPrefix` + `onMemberProvisioned`

**Files:**
- Modify: `src/scenarios/types.ts`, `src/scenarios/registry.ts`, `src/scenarios/classroom/scenario.ts`, `src/scenarios/industryai_seminar/scenario.ts`
- Test: `src/scenarios/registry.test.ts` (extend), and fix stubs in `src/scenario-pairing.test.ts` + `src/scenario-pairing.integration.test.ts` (they build `Scenario` objects that will need the new required field)

- [ ] **Step 1: Write the failing test** — append to `src/scenarios/registry.test.ts`. Add `folderPrefix`/`onMemberProvisioned` to its `fakeScenario` return object first:

```typescript
    memberName: (folder) => (folder === 'boss_01' ? 'Ada' : folder === 'member_07' ? 'Grace' : null),
    folderPrefix: { owner: 'boss_', user: 'member_' },
```

Add the import `folderPrefix, onMemberProvisioned` to the `./registry.js` import, and these tests:

```typescript
  it('exposes the active scenario folder prefix per role', () => {
    registerScenario(fakeScenario('photo_lab'));
    expect(folderPrefix('user')).toBe('member_');
    expect(folderPrefix('owner')).toBe('boss_');
    expect(folderPrefix('it_admin')).toBeNull(); // not in this scenario
  });

  it('onMemberProvisioned is a safe no-op when the scenario omits it', () => {
    registerScenario(fakeScenario('photo_lab'));
    expect(() => onMemberProvisioned('member_01', { name: 'A', email: 'a@b.c', role: 'user' })).not.toThrow();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run src/scenarios/registry.test.ts`
Expected: FAIL — `folderPrefix`/`onMemberProvisioned` not exported.

- [ ] **Step 3: Extend the `Scenario` interface** — in `src/scenarios/types.ts`, after the `memberName` field:

```typescript
  /** Folder prefix used to provision a member of each canonical role this scenario uses (e.g. user → 'user_'). */
  folderPrefix: Partial<Record<CanonicalRole, string>>;
  /** Optional scenario-specific work after a member is provisioned (e.g. classroom roster append). */
  onMemberProvisioned?: (folder: string, member: { name: string; email: string; role: CanonicalRole }) => void;
```

- [ ] **Step 4: Add registry accessors** — in `src/scenarios/registry.ts`, after `memberName`:

```typescript
/** Folder prefix the active scenario uses to provision a member of `role` (null if unset). */
export function folderPrefix(role: CanonicalRole): string | null {
  return getActiveScenario()?.folderPrefix[role] ?? null;
}

/** Run the active scenario's post-provision hook, if any. No-op otherwise. */
export function onMemberProvisioned(
  folder: string,
  member: { name: string; email: string; role: CanonicalRole },
): void {
  getActiveScenario()?.onMemberProvisioned?.(folder, member);
}
```

- [ ] **Step 5: Implement for both scenarios.**

In `src/scenarios/industryai_seminar/scenario.ts`, add to the `seminar` object (after `memberName`):

```typescript
  folderPrefix: { owner: 'owner_', it_admin: 'it_admin_', assistant: 'assistant_', user: 'user_' },
```

In `src/scenarios/classroom/scenario.ts`, add to the `classroom` object (after `memberName`):

```typescript
  folderPrefix: { owner: 'instructor_', assistant: 'ta_', user: 'student_' },
  onMemberProvisioned: (folder, member) => {
    if (member.role === 'user') appendStudentToClassConfig({ name: member.name, folder });
  },
```

Move `appendStudentToClassConfig` out of `src/class-student-provision.ts` into `src/scenarios/classroom/scenario.ts` (or export it from `class-config.ts` and import it here). Confirmed it currently lives in `class-student-provision.ts` (~line 192) and writes `DATA_DIR/class-config.json`. Keep its body identical; just relocate so classroom owns it.

- [ ] **Step 6: Fix the other test stubs.** In `src/scenario-pairing.test.ts` `stubScenario()` and `src/scenario-pairing.integration.test.ts` (if it builds a Scenario inline — it imports the real seminar, so only `scenario-pairing.test.ts` needs it). Add to `stubScenario()`'s returned object:

```typescript
    memberName: (f) => `Name(${f})`,
    folderPrefix: { owner: 'boss_', assistant: 'lead_', user: 'member_' },
```

- [ ] **Step 7: Run + build**

Run: `pnpm exec vitest run src/scenarios/registry.test.ts src/scenario-pairing.test.ts && pnpm run build`
Expected: tests PASS, tsc exits 0. (If tsc errors that `folderPrefix` is missing on a `Scenario`, a stub or real scenario still needs it.)

- [ ] **Step 8: Commit**

```bash
git add src/scenarios/ src/class-student-provision.ts src/scenario-pairing.test.ts
git commit -m "feat(scenarios): per-role folderPrefix + onMemberProvisioned hook"
```

---

### Task 2: `nextFolderForRole` — scenario-aware folder allocation

**Files:**
- Modify: `src/class-student-provision.ts`
- Test: `src/class-student-provision.test.ts` (extend)

- [ ] **Step 1: Write the failing test** — add to `src/class-student-provision.test.ts`. In `beforeEach` a scenario must be registered; register a stub with `folderPrefix.user = 'user_'`:

```typescript
import { _resetScenariosForTest, registerScenario } from './scenarios/registry.js';
// inside beforeEach, after DB init:
_resetScenariosForTest();
registerScenario({
  name: 'stub', roles: { user: { label: 'P', permission: 'member', persona: (n) => n, greeting: (n) => n } },
  roleForFolder: (f) => (f.startsWith('user_') ? 'user' : null),
  memberName: () => null,
  folderPrefix: { user: 'user_' },
});
// afterEach: _resetScenariosForTest();
```

Test:

```typescript
import { nextFolderForRole } from './class-student-provision.js';
it('allocates the next folder using the active scenario prefix', () => {
  expect(nextFolderForRole('user')).toBe('user_1');
  createAgentGroup({ id: 'ag_u1', name: 'x', folder: 'user_1', agent_provider: 'pi', created_at: '2026-01-01' });
  createAgentGroup({ id: 'ag_u4', name: 'y', folder: 'user_4', agent_provider: 'pi', created_at: '2026-01-01' });
  expect(nextFolderForRole('user')).toBe('user_5');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run src/class-student-provision.test.ts`
Expected: FAIL — `nextFolderForRole` not exported.

- [ ] **Step 3: Implement** — in `src/class-student-provision.ts`, add (and import `folderPrefix` + `CanonicalRole`):

```typescript
import { folderPrefix } from './scenarios/registry.js';
import type { CanonicalRole } from './scenarios/types.js';

/** Lowest unused `<prefix><n>` folder for `role` under the active scenario. */
export function nextFolderForRole(role: CanonicalRole): string {
  const prefix = folderPrefix(role);
  if (!prefix) throw new Error(`Active scenario has no folder prefix for role "${role}"`);
  const re = new RegExp(`^${prefix}(\\d+)$`);
  const rows = getDb().prepare('SELECT folder FROM agent_groups').all() as { folder: string }[];
  let max = 0;
  for (const r of rows) {
    const m = re.exec(r.folder);
    if (m) max = Math.max(max, parseInt(m[1]!, 10));
  }
  return `${prefix}${max + 1}`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run src/class-student-provision.test.ts`
Expected: PASS.

- [ ] **Step 5: Build + commit**

```bash
pnpm run build
git add src/class-student-provision.ts src/class-student-provision.test.ts
git commit -m "feat(provision): scenario-aware nextFolderForRole"
```

---

### Task 3: Default-slot module (paths + read/write/exists)

**Files:**
- Create: `src/default-participant-slot.ts`
- Test: `src/default-participant-slot.test.ts`

This module owns the slot at `DATA_DIR/config/default-participant/` and the (de)serialization of `container_configs` ↔ the slot's `container.json`.

- [ ] **Step 1: Write the failing test** — `src/default-participant-slot.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const TMP = '/tmp/nanoclaw-test-default-slot';
vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: TMP, GROUPS_DIR: path.join(TMP, 'groups') };
});

import { slotDir, slotExists, writeSlotConfig, readSlotConfig } from './default-participant-slot.js';

beforeEach(() => { fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(TMP, { recursive: true }); });
afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('default-participant slot', () => {
  it('reports not-exists when no config written', () => {
    expect(slotExists()).toBe(false);
    expect(readSlotConfig()).toBeNull();
  });
  it('round-trips the container config JSON', () => {
    writeSlotConfig({ provider: 'pi', model: 'gpt-5.4-mini', effort: null, skills: 'all', mcp_servers: {}, packages_apt: [], packages_npm: [], additional_mounts: [], env: {}, allowed_models: [], assistant_name: null, max_messages_per_prompt: null, model_provider: 'openai-codex' });
    expect(fs.existsSync(path.join(slotDir(), 'container.json'))).toBe(true);
    const cfg = readSlotConfig()!;
    expect(cfg.provider).toBe('pi');
    expect(cfg.model_provider).toBe('openai-codex');
    expect(cfg.skills).toBe('all');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run src/default-participant-slot.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/default-participant-slot.ts`:

```typescript
/**
 * The "default participant" slot — a stable snapshot under
 * DATA_DIR/config/default-participant/ that provisioning + apply-to-all read.
 * Contains CLAUDE.local.md (persona), CLAUDE.md, custom-skills/, container.json
 * (a serialization of the template's container_configs row), and meta.json.
 * Authoritative config is the DB; container.json here is a portable copy.
 */
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';

/** Subset of container_configs fields the slot persists (parsed, not JSON-encoded). */
export interface SlotConfig {
  provider: string | null;
  model: string | null;
  model_provider?: string | null;
  effort: string | null;
  assistant_name: string | null;
  max_messages_per_prompt: number | null;
  skills: unknown; // string[] | 'all'
  mcp_servers: unknown;
  packages_apt: unknown;
  packages_npm: unknown;
  additional_mounts: unknown;
  env: unknown;
  allowed_models: unknown;
}

export function slotDir(): string {
  return path.join(DATA_DIR, 'config', 'default-participant');
}

export function slotExists(): boolean {
  return fs.existsSync(path.join(slotDir(), 'meta.json'));
}

export function writeSlotConfig(cfg: SlotConfig): void {
  fs.mkdirSync(slotDir(), { recursive: true });
  fs.writeFileSync(path.join(slotDir(), 'container.json'), JSON.stringify(cfg, null, 2));
}

export function readSlotConfig(): SlotConfig | null {
  const p = path.join(slotDir(), 'container.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as SlotConfig;
  } catch {
    return null;
  }
}

export function writeSlotMeta(savedBy: string): void {
  fs.mkdirSync(slotDir(), { recursive: true });
  fs.writeFileSync(
    path.join(slotDir(), 'meta.json'),
    JSON.stringify({ savedAt: new Date().toISOString(), savedBy }, null, 2),
  );
}

export function readSlotMeta(): { savedAt: string; savedBy: string } | null {
  const p = path.join(slotDir(), 'meta.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as { savedAt: string; savedBy: string };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run src/default-participant-slot.test.ts`
Expected: PASS.

- [ ] **Step 5: Build + commit**

```bash
pnpm run build
git add src/default-participant-slot.ts src/default-participant-slot.test.ts
git commit -m "feat(default): default-participant slot module"
```

---

### Task 4: Scenario-aware `provisionMember` (reads slot, drops owner-inheritance)

**Files:**
- Modify: `src/class-student-provision.ts`
- Test: `src/class-student-provision.test.ts` (extend)

Refactor: `provisionStudent` becomes a thin wrapper over a new `provisionMember`. The folder comes from `nextFolderForRole(role)`. Content comes from the slot when present; otherwise the existing fallback (`roleProfile`, `STUDENT_CLAUDE_MD`, env model/provider). **Remove the `inheritedSkills()` call** (owner-coupling). Call `onMemberProvisioned`.

- [ ] **Step 1: Write the failing test** — add to `src/class-student-provision.test.ts` (scenario stub from Task 2 registered):

```typescript
import { provisionMember } from './class-student-provision.js';
import { writeSlotConfig, writeSlotMeta, slotDir } from './default-participant-slot.js';
import { getContainerConfig } from './db/container-configs.js';
import fs from 'fs'; import path from 'path';

it('provisions a user-role member from the slot when present', () => {
  // seed slot
  fs.mkdirSync(slotDir(), { recursive: true });
  fs.writeFileSync(path.join(slotDir(), 'CLAUDE.local.md'), '# Template persona\n');
  fs.writeFileSync(path.join(slotDir(), 'CLAUDE.md'), '# Template CLAUDE\n');
  writeSlotConfig({ provider: 'pi', model: 'gpt-5.4-mini', effort: null, assistant_name: null, max_messages_per_prompt: null, skills: ['web'], mcp_servers: {}, packages_apt: [], packages_npm: [], additional_mounts: [], env: {}, allowed_models: [], model_provider: 'openai' });
  writeSlotMeta('owner:test');

  const r = provisionMember({ role: 'user', name: 'Dana', email: 'dana@x.edu', addedBy: null });
  expect(r.folder).toBe('user_1');
  const persona = fs.readFileSync(path.join(GROUPS_DIR, r.folder, 'CLAUDE.local.md'), 'utf8');
  expect(persona).toBe('# Template persona\n');
  const cfg = getContainerConfig(r.agentGroupId)!;
  expect(cfg.provider).toBe('pi');
  expect(JSON.parse(cfg.skills)).toEqual(['web']);
});
```

(Use the actual field names from `ProvisionStudentResult` — confirm `folder` and the agent-group id field; adapt `r.agentGroupId` to the real result shape, which currently exposes `folder`, `name`, `email`, `userId` — add `agentGroupId` to the result in Step 3.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run src/class-student-provision.test.ts`
Expected: FAIL — `provisionMember` not exported.

- [ ] **Step 3: Implement.** In `src/class-student-provision.ts`:

1. Add `role` + `agentGroupId` to the result interface (`ProvisionStudentResult`): add `agentGroupId: string;`.
2. Rename the body of `provisionStudent` to `provisionMember(opts: { role: CanonicalRole; name: string; email: string; addedBy: string | null })`, and keep:
   ```typescript
   export function provisionStudent(opts: { name: string; email: string; addedBy: string | null }): ProvisionStudentResult {
     return provisionMember({ role: 'user', ...opts });
   }
   ```
3. In `provisionMember`:
   - `const folder = nextFolderForRole(opts.role);` (replaces `nextStudentFolder()`).
   - `const userId = \`class:${folder}\`;` (unchanged shape).
   - Build the `AgentGroup` as today.
   - **Content:** after creating the group dir, if `slotExists()`:
     ```typescript
     import { slotExists, readSlotConfig, slotDir } from './default-participant-slot.js';
     import { copyDirRecursive } from './channels/playground/api/agent-library.js'; // or fs-based copy
     // persona + CLAUDE.md + custom-skills from slot
     const sd = slotDir();
     copyFileIfExists(path.join(sd, 'CLAUDE.local.md'), personaPath);
     copyFileIfExists(path.join(sd, 'CLAUDE.md'), claudeMdPath);
     const slotCustom = path.join(sd, 'custom-skills');
     if (fs.existsSync(slotCustom)) copyDirRecursive(slotCustom, path.join(groupDir, 'custom-skills'));
     ```
     else fallback to current behavior: `roleProfile(opts.role)?.persona(opts.name) ?? STUDENT_PERSONA(opts.name)` for persona, `STUDENT_CLAUDE_MD` for CLAUDE.md.
   - **Container config:** build the `ContainerConfigRow` from the slot when present, else from `makeContainerConfig` but **without `inheritedSkills()`** — set `skills` to a fixed default `'all'` (string `"all"`) in the no-slot path. Concretely, when slot present:
     ```typescript
     const sc = readSlotConfig();
     createContainerConfig({
       agent_group_id: group.id,
       provider: sc?.provider ?? (process.env.NANOCLAW_STUDENT_PROVIDER || 'pi'),
       model: sc?.model ?? (process.env.NANOCLAW_STUDENT_MODEL || 'gpt-5.4-mini'),
       model_provider: sc?.model_provider ?? null,
       effort: sc?.effort ?? null,
       image_tag: null,
       assistant_name: sc?.assistant_name ?? null,
       max_messages_per_prompt: sc?.max_messages_per_prompt ?? null,
       skills: JSON.stringify(sc?.skills ?? 'all'),
       mcp_servers: JSON.stringify(sc?.mcp_servers ?? {}),
       packages_apt: JSON.stringify(sc?.packages_apt ?? []),
       packages_npm: JSON.stringify(sc?.packages_npm ?? []),
       additional_mounts: JSON.stringify(sc?.additional_mounts ?? []),
       cli_scope: 'group',
       env: JSON.stringify(sc?.env ?? {}),
       allowed_models: JSON.stringify(sc?.allowed_models ?? []),
     });
     ```
     When no slot, keep the existing `makeContainerConfig(...)` createContainerConfig block but change `skills: opts.isStudent ? inheritedSkills() : []` in `makeContainerConfig` to `skills: 'all'` (remove the `inheritedSkills` import + function, or leave the function but stop calling it from the provisioning path — prefer deleting `inheritedSkills` if no other caller; verify with `grep -rn inheritedSkills src`).
   - **Hook:** at the end, `onMemberProvisioned(folder, { name: opts.name, email: opts.email, role: opts.role });` (replaces the inline `appendStudentToClassConfig`).
   - Set `agentGroupId: group.id` in the returned result.

- [ ] **Step 4: Verify `inheritedSkills` removal is clean**

Run: `grep -rn --include="*.ts" "inheritedSkills" src | grep -v ".test.ts"`
Expected: no callers remain (delete the function + its import if unused). If a test referenced it, update the test.

- [ ] **Step 5: Run + build**

Run: `pnpm exec vitest run src/class-student-provision.test.ts && pnpm run build`
Expected: PASS, tsc 0.

- [ ] **Step 6: Full suite (provisioning refactor blast check)**

Run: `pnpm test`
Expected: all pass. (`students-admin.ts` still calls `provisionStudent` — unchanged signature.)

- [ ] **Step 7: Commit**

```bash
git add src/class-student-provision.ts src/class-student-provision.test.ts
git commit -m "feat(provision): provisionMember reads default slot; drop owner-agent skill inheritance"
```

---

### Task 5: Template agent bootstrap + "Save as default"

**Files:**
- Create: `src/default-participant.ts` (core: ensure template agent, save template→slot)
- Test: `src/default-participant.test.ts`

- [ ] **Step 1: Write the failing test** — `src/default-participant.test.ts` (mock config DATA_DIR/GROUPS_DIR to a tmp dir as in Task 3; init DB; register a stub scenario):

```typescript
import { ensureTemplateAgent, saveDefaultFromTemplate, TEMPLATE_FOLDER } from './default-participant.js';
import { getAgentGroupByFolder } from './db/agent-groups.js';
import { slotExists, readSlotConfig } from './default-participant-slot.js';
import fs from 'fs'; import path from 'path';

it('ensureTemplateAgent creates the flagged template group once (idempotent)', () => {
  const a = ensureTemplateAgent();
  expect(getAgentGroupByFolder(TEMPLATE_FOLDER)?.id).toBe(a.id);
  const b = ensureTemplateAgent();
  expect(b.id).toBe(a.id); // idempotent
});

it('saveDefaultFromTemplate snapshots files + container config into the slot', () => {
  const ag = ensureTemplateAgent();
  const dir = path.join(GROUPS_DIR, TEMPLATE_FOLDER);
  fs.writeFileSync(path.join(dir, 'CLAUDE.local.md'), '# persona\n');
  // set a recognizable container config on the template
  // (createContainerConfig already done by ensureTemplateAgent; update model)
  saveDefaultFromTemplate('owner:test');
  expect(slotExists()).toBe(true);
  expect(fs.readFileSync(path.join(/* slotDir */ ''), 'utf8')); // assert persona copied — use slotDir()
  expect(readSlotConfig()).not.toBeNull();
});
```

(Refine the second test's assertions to read `slotDir()/CLAUDE.local.md` === '# persona\n' and `readSlotConfig().model` equals what you set on the template's container_configs.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run src/default-participant.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/default-participant.ts`:

```typescript
/**
 * Default-participant template agent + "save as default".
 *
 * `_default_participant` is a flagged agent group edited via the normal
 * workbench. It is never paired, never a roster member, and roleForFolder
 * returns null for it (no scenario prefix matches '_default_participant').
 * "Save as default" snapshots its files + container_configs into the slot.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { GROUPS_DIR } from './config.js';
import type { AgentGroup } from './types.js';
import { createAgentGroup, getAgentGroupByFolder, setAgentGroupMetadataKey } from './db/agent-groups.js';
import { createContainerConfig, getContainerConfig } from './db/container-configs.js';
import { roleProfile } from './scenarios/registry.js';
import { copyDirRecursive } from './channels/playground/api/agent-library.js';
import { slotDir, writeSlotConfig, writeSlotMeta, type SlotConfig } from './default-participant-slot.js';

export const TEMPLATE_FOLDER = '_default_participant';

export function ensureTemplateAgent(): AgentGroup {
  const existing = getAgentGroupByFolder(TEMPLATE_FOLDER);
  if (existing) return existing;

  const group: AgentGroup = {
    id: `ag_${crypto.randomBytes(6).toString('hex')}`,
    name: 'Default Participant Template',
    folder: TEMPLATE_FOLDER,
    agent_provider: process.env.NANOCLAW_STUDENT_PROVIDER || 'pi',
    created_at: new Date().toISOString(),
  };
  createAgentGroup(group);
  setAgentGroupMetadataKey(group.id, 'template', true);

  const dir = path.join(GROUPS_DIR, TEMPLATE_FOLDER);
  fs.mkdirSync(dir, { recursive: true });
  const persona = roleProfile('user')?.persona('Participant') ?? '# Participant\n';
  if (!fs.existsSync(path.join(dir, 'CLAUDE.local.md'))) fs.writeFileSync(path.join(dir, 'CLAUDE.local.md'), persona);
  if (!fs.existsSync(path.join(dir, 'CLAUDE.md'))) fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Participant agent\n');

  createContainerConfig({
    agent_group_id: group.id,
    provider: process.env.NANOCLAW_STUDENT_PROVIDER || 'pi',
    model: process.env.NANOCLAW_STUDENT_MODEL || 'gpt-5.4-mini',
    model_provider: null, effort: null, image_tag: null, assistant_name: null, max_messages_per_prompt: null,
    skills: JSON.stringify('all'), mcp_servers: '{}', packages_apt: '[]', packages_npm: '[]',
    additional_mounts: '[]', cli_scope: 'group', env: '{}', allowed_models: '[]',
  });
  return group;
}

function copyFileIfExists(src: string, dst: string): void {
  if (fs.existsSync(src)) fs.copyFileSync(src, dst);
}

export function saveDefaultFromTemplate(savedBy: string): void {
  const ag = ensureTemplateAgent();
  const dir = path.join(GROUPS_DIR, TEMPLATE_FOLDER);
  const slot = slotDir();
  fs.mkdirSync(slot, { recursive: true });

  copyFileIfExists(path.join(dir, 'CLAUDE.local.md'), path.join(slot, 'CLAUDE.local.md'));
  copyFileIfExists(path.join(dir, 'CLAUDE.md'), path.join(slot, 'CLAUDE.md'));
  const customSrc = path.join(dir, 'custom-skills');
  const customDst = path.join(slot, 'custom-skills');
  fs.rmSync(customDst, { recursive: true, force: true });
  if (fs.existsSync(customSrc)) copyDirRecursive(customSrc, customDst);

  const cfg = getContainerConfig(ag.id);
  const slotCfg: SlotConfig = {
    provider: cfg?.provider ?? null,
    model: cfg?.model ?? null,
    model_provider: (cfg as { model_provider?: string | null } | undefined)?.model_provider ?? null,
    effort: cfg?.effort ?? null,
    assistant_name: cfg?.assistant_name ?? null,
    max_messages_per_prompt: cfg?.max_messages_per_prompt ?? null,
    skills: cfg ? JSON.parse(cfg.skills) : 'all',
    mcp_servers: cfg ? JSON.parse(cfg.mcp_servers) : {},
    packages_apt: cfg ? JSON.parse(cfg.packages_apt) : [],
    packages_npm: cfg ? JSON.parse(cfg.packages_npm) : [],
    additional_mounts: cfg ? JSON.parse(cfg.additional_mounts) : [],
    env: cfg ? JSON.parse(cfg.env) : {},
    allowed_models: cfg ? JSON.parse(cfg.allowed_models) : [],
  };
  writeSlotConfig(slotCfg);
  writeSlotMeta(savedBy);
}
```

(If `copyDirRecursive` isn't exported from agent-library, export it there or inline a small recursive copy.)

- [ ] **Step 4: Run + build**

Run: `pnpm exec vitest run src/default-participant.test.ts && pnpm run build`
Expected: PASS, tsc 0.

- [ ] **Step 5: Commit**

```bash
git add src/default-participant.ts src/default-participant.test.ts src/channels/playground/api/agent-library.ts
git commit -m "feat(default): template agent bootstrap + save-as-default"
```

---

### Task 6: Apply-to-all core (`applyDefaultToAllParticipants`)

**Files:**
- Modify: `src/default-participant.ts`
- Test: `src/default-participant.test.ts` (extend)

- [ ] **Step 1: Write the failing test** — extend `src/default-participant.test.ts`. Register the seminar-like stub (`user_` prefix), create a couple of `user_NN` groups + the template, seed the slot (via `saveDefaultFromTemplate`), then:

```typescript
import { applyDefaultToAllParticipants } from './default-participant.js';
it('applies the default to user-role groups only, backs up + overwrites, returns count', () => {
  ensureTemplateAgent();
  // template persona that will be pushed
  fs.writeFileSync(path.join(GROUPS_DIR, TEMPLATE_FOLDER, 'CLAUDE.local.md'), '# DEFAULT\n');
  saveDefaultFromTemplate('owner:test');
  createAgentGroup({ id: 'ag_u1', name: 'A', folder: 'user_1', agent_provider: 'pi', created_at: '2026-01-01' });
  fs.mkdirSync(path.join(GROUPS_DIR, 'user_1'), { recursive: true });
  fs.writeFileSync(path.join(GROUPS_DIR, 'user_1', 'CLAUDE.local.md'), '# MINE\n');
  createAgentGroup({ id: 'ag_own', name: 'O', folder: 'owner_1', agent_provider: 'pi', created_at: '2026-01-01' });

  const res = applyDefaultToAllParticipants();
  expect(res.affected).toBe(1); // user_1 only, not owner_1, not the template
  expect(fs.readFileSync(path.join(GROUPS_DIR, 'user_1', 'CLAUDE.local.md'), 'utf8')).toBe('# DEFAULT\n');
  // backup restore-point exists in user_1's library
  expect(res.restorePoints[0]).toMatch(/^pre-default-reset-/);
  expect(fs.existsSync(path.join(GROUPS_DIR, 'user_1', 'library', res.restorePoints[0]!))).toBe(true);
});
```

Note: `restartAgentGroupContainers` is a no-op in tests (no running sessions) — safe to call.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run src/default-participant.test.ts`
Expected: FAIL — `applyDefaultToAllParticipants` not exported.

- [ ] **Step 3: Implement** — add to `src/default-participant.ts`:

```typescript
import { getAllAgentGroups } from './db/agent-groups.js';
import { roleForFolder } from './scenarios/registry.js';
import { saveEntry } from './channels/playground/api/agent-library.js';
import { updateContainerConfigScalars, updateContainerConfigJson, ensureContainerConfig } from './db/container-configs.js';
import { restartAgentGroupContainers } from './container-restart.js';
import { readSlotConfig, slotDir } from './default-participant-slot.js';

export function applyDefaultToAllParticipants(): { affected: number; restorePoints: string[] } {
  const slot = slotDir();
  const sc = readSlotConfig();
  if (!sc) throw new Error('No default saved — call saveDefaultFromTemplate first');

  const groups = getAllAgentGroups().filter((g) => roleForFolder(g.folder) === 'user');
  const restorePoints: string[] = [];

  for (const g of groups) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const slug = `pre-default-reset-${ts}`;
    saveEntry(g.folder, slug, true); // restore point (incl. persona)
    restorePoints.push(slug);

    // overwrite files from slot
    const gdir = path.join(GROUPS_DIR, g.folder);
    fs.mkdirSync(gdir, { recursive: true });
    copyFileIfExists(path.join(slot, 'CLAUDE.local.md'), path.join(gdir, 'CLAUDE.local.md'));
    copyFileIfExists(path.join(slot, 'CLAUDE.md'), path.join(gdir, 'CLAUDE.md'));
    const customSrc = path.join(slot, 'custom-skills');
    const customDst = path.join(gdir, 'custom-skills');
    fs.rmSync(customDst, { recursive: true, force: true });
    if (fs.existsSync(customSrc)) copyDirRecursive(customSrc, customDst);

    // overwrite container_configs (DB authoritative)
    ensureContainerConfig(g.id);
    updateContainerConfigScalars(g.id, {
      provider: sc.provider ?? undefined,
      model: sc.model ?? undefined,
      model_provider: (sc.model_provider ?? undefined) as string | undefined,
      effort: sc.effort ?? undefined,
      assistant_name: sc.assistant_name ?? undefined,
      max_messages_per_prompt: sc.max_messages_per_prompt ?? undefined,
    });
    updateContainerConfigJson(g.id, 'skills', sc.skills);
    updateContainerConfigJson(g.id, 'mcp_servers', sc.mcp_servers);
    updateContainerConfigJson(g.id, 'packages_apt', sc.packages_apt);
    updateContainerConfigJson(g.id, 'packages_npm', sc.packages_npm);
    updateContainerConfigJson(g.id, 'additional_mounts', sc.additional_mounts);
    updateContainerConfigJson(g.id, 'env', sc.env);
    updateContainerConfigJson(g.id, 'allowed_models', sc.allowed_models);

    restartAgentGroupContainers(g.id, 'default-participant-reset');
  }
  return { affected: groups.length, restorePoints };
}
```

- [ ] **Step 4: Run + build + full suite**

Run: `pnpm exec vitest run src/default-participant.test.ts && pnpm run build && pnpm test`
Expected: PASS, tsc 0, full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/default-participant.ts src/default-participant.test.ts
git commit -m "feat(default): apply-to-all (backup + overwrite + restart) for user-role groups"
```

---

### Task 7: Owner-gated API handlers + routing

**Files:**
- Create: `src/channels/playground/api/default-participant.ts`
- Modify: `src/channels/playground/api-routes.ts`
- Test: `src/channels/playground/api/default-participant.test.ts`

- [ ] **Step 1: Write the failing test** — `default-participant.test.ts`: init DB + register a stub scenario; grant a user `owner`; assert non-owner is 403 on save; owner save returns `{ ok: true, savedAt }` and `slotExists()`; apply-all without `confirm` is 400; with `confirm:'APPLY'` returns `{ affected }`. Mirror the gating-test style in `src/channels/playground/api/enrollment.test.ts`.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run src/channels/playground/api/default-participant.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/channels/playground/api/default-participant.ts`:

```typescript
import type { PlaygroundSession } from '../session.js'; // match enrollment.ts import for the session type
import { isOwner, isGlobalAdmin } from '../../../modules/permissions/db/user-roles.js';
import { ensureTemplateAgent, saveDefaultFromTemplate, applyDefaultToAllParticipants, TEMPLATE_FOLDER } from '../../../default-participant.js';
import { slotExists, readSlotMeta } from '../../../default-participant-slot.js';
import { getAllAgentGroups } from '../../../db/agent-groups.js';
import { roleForFolder } from '../../../scenarios/registry.js';

function isOwnerOrAdmin(userId: string | null): boolean {
  if (!userId) return false;
  return isOwner(userId) || isGlobalAdmin(userId);
}

export function handleGetDefaultParticipant(session: PlaygroundSession) {
  if (!isOwnerOrAdmin(session.userId)) return { status: 403, body: { error: 'owner role required' } };
  const ag = ensureTemplateAgent();
  const meta = readSlotMeta();
  const participantCount = getAllAgentGroups().filter((g) => roleForFolder(g.folder) === 'user').length;
  return { status: 200, body: { saved: slotExists(), savedAt: meta?.savedAt ?? null, savedBy: meta?.savedBy ?? null, templateFolder: TEMPLATE_FOLDER, templateGroupId: ag.id, participantCount } };
}

export function handleSaveDefaultParticipant(session: PlaygroundSession) {
  if (!isOwnerOrAdmin(session.userId)) return { status: 403, body: { error: 'owner role required' } };
  saveDefaultFromTemplate(session.userId!);
  const meta = readSlotMeta();
  return { status: 200, body: { ok: true, savedAt: meta?.savedAt } };
}

export function handleApplyDefaultToAll(session: PlaygroundSession, body: { confirm?: unknown }) {
  if (!isOwnerOrAdmin(session.userId)) return { status: 403, body: { error: 'owner role required' } };
  if (body.confirm !== 'APPLY') return { status: 400, body: { error: 'confirmation required' } };
  if (!slotExists()) return { status: 400, body: { error: 'no default saved' } };
  const res = applyDefaultToAllParticipants();
  return { status: 200, body: { ok: true, ...res } };
}
```

(Match the exact `PlaygroundSession` type + `ApiResult` return type used by sibling handlers — open `enrollment.ts` and copy its imports/return typing.)

- [ ] **Step 4: Wire routes** — in `src/channels/playground/api-routes.ts`, import the three handlers and add (near the other `/api/...` matches):

```typescript
if (method === 'GET' && url.pathname === '/api/default-participant') return handleGetDefaultParticipant(session);
if (method === 'POST' && url.pathname === '/api/default-participant/save') return handleSaveDefaultParticipant(session);
if (method === 'POST' && url.pathname === '/api/default-participant/apply-all') return handleApplyDefaultToAll(session, await readJsonBody(req));
```

(Use the same body-reading helper sibling POST routes use — check how `handleAddStudent` gets its body in this file.)

- [ ] **Step 5: Run + build + full suite**

Run: `pnpm exec vitest run src/channels/playground/api/default-participant.test.ts && pnpm run build && pnpm test`
Expected: PASS, tsc 0, full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/channels/playground/api/default-participant.ts src/channels/playground/api/default-participant.test.ts src/channels/playground/api-routes.ts
git commit -m "feat(default): owner-gated API (status/save/apply-all)"
```

---

### Task 8: Owner playground card (Home tab)

**Files:**
- Modify: the Home-tab playground frontend (`src/channels/playground/public/...` — locate the file rendering the owner "Class Controls" / instructor cards; follow that exact card pattern)

- [ ] **Step 1: Locate the pattern.** Run `grep -rn "Class Controls\|renderClassControls\|class-controls" src/channels/playground/public` to find the card-rendering file + how an owner-only card is conditionally shown and how it calls `/api/...`. Read that card end-to-end before writing.

- [ ] **Step 2: Add the card.** Render an owner-only "Default Participant Template" card with:
  - A line showing saved state from `GET /api/default-participant` (`saved`, `savedAt`, `participantCount`).
  - **"Edit template"** button → deep-link to the existing workbench/agent editor pointed at `templateFolder` (`_default_participant`) — reuse whatever navigation the existing UI uses to open an agent for editing (find it near the agent list / drafts UI).
  - **"Save as default"** button → `POST /api/default-participant/save`; on success update the saved-state line.
  - **"Apply default to all Participants"** button → shows `participantCount`, requires a typed confirmation (prompt for the literal word `APPLY`), then `POST /api/default-participant/apply-all` with `{ confirm: 'APPLY' }`; on success show `affected` count + a note that each Participant has a `pre-default-reset-*` restore point.
  - Hide the card entirely for non-owner sessions (mirror how Class Controls is gated client-side).

- [ ] **Step 3: Verify the template agent is excluded from Participant lists.** Run `grep -rn "roleForFolder\|participant\|user_\|listAgentGroups\|/api/groups" src/channels/playground` and confirm any Participant/agent list either filters `metadata.template === true` or relies on `roleForFolder(folder) === 'user'` (which excludes `_default_participant`). If a list shows it, add a filter on the `template` metadata flag.

- [ ] **Step 4: Manual smoke (host running).** Start dev (`pnpm run dev` on a NON-conflicting port per `~/.dev-ports.yaml`) or use the live instance; load the playground as the owner; confirm the card renders, "Save as default" persists (`data/config/default-participant/meta.json` appears), and the template agent doesn't appear in the Participant list.

- [ ] **Step 5: Build + commit**

```bash
pnpm run build
git add src/channels/playground/public
git commit -m "feat(default): owner Default Participant Template card"
```

---

### Task 9: Live verification + state.md

- [ ] **Step 1: Build + restart the Clemson/seminar service**

```bash
pnpm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-581fefa4
```

- [ ] **Step 2: Verify the template agent exists + is non-live.** `./bin/ncl groups list` shows `_default_participant` "Default Participant Template"; confirm it's not wired to any messaging group and `roleForFolder` excludes it (it won't match `user_`).

- [ ] **Step 3: End-to-end (use the playground as owner):**
  1. Edit `_default_participant` (persona + model), **Save as default** → confirm `data/config/default-participant/{meta.json,container.json,CLAUDE.local.md}` written.
  2. Provision a new Participant (Add-Student flow / `provisionMember('user', …)`) → confirm the new group is **`user_NN`** with the template's persona/model and **no owner-inherited skills**.
  3. **Apply to all** → confirm existing `user_NN` Participants got the default, each has a `pre-default-reset-*` library entry (`./bin/ncl` or inspect `groups/user_NN/library/`), and containers restarted (logs).
  Capture actual output; do not claim success without it.

- [ ] **Step 4: Update `state.md`** — decision-log entry (this feature: default participant template + scenario-aware provisioning; owner-inheritance removed; per-role deferred) and, if a follow-up remains (e.g. migrate existing `student_NN`), append to Open follow-ups. Run `pnpm refresh-state`. (state.md is committed via the husky hook.)

---

## Self-Review

**Spec coverage:** template agent + slot (Tasks 3,5) ✓; provisioning reads slot + drops `inheritedSkills` (Task 4) ✓; scenario-aware folders via `folderPrefix` (Tasks 1,2) ✓; classroom roster via `onMemberProvisioned` (Task 1) ✓; owner card + 3 endpoints (Tasks 7,8) ✓; apply-to-all backup+overwrite+restart, user-role only, confirm token (Tasks 6,7) ✓; container config DB-authoritative with slot serialization (Tasks 3,5,6) ✓; boundaries (Participants only via `roleForFolder==='user'`; template excluded) ✓; tests + live check (Task 9) ✓.

**Placeholder scan:** UI task (8) intentionally directs the implementer to read the sibling card pattern before writing DOM — the behavior, API contract, states, and confirmation flow are fully specified; the DOM idiom follows an existing card. The Task 4/5/7 notes "match the real result shape / PlaygroundSession type / body helper" are pointers to copy exact local signatures, not unfinished logic.

**Type consistency:** `SlotConfig` (Task 3) is produced by `saveDefaultFromTemplate` (Task 5) and consumed by `provisionMember` (Task 4) + `applyDefaultToAllParticipants` (Task 6) — same field names. `TEMPLATE_FOLDER`, `ensureTemplateAgent`, `saveDefaultFromTemplate`, `applyDefaultToAllParticipants` exported from `src/default-participant.ts` and imported by the handlers (Task 7). `folderPrefix`/`onMemberProvisioned` added to `Scenario` (Task 1) and used by `nextFolderForRole` (Task 2) + `provisionMember` (Task 4). `restartAgentGroupContainers(id, reason, wakeMessage?)` and `updateContainerConfigScalars/Json` used with their verified signatures.
