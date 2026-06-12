# "My Agent" Simple Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A beginner-mode playground tab (`simple`, label "My Agent") with an embedded chat, a Use-agent toggle (agent vs raw model), an instructor-curated skill checklist with ⓘ descriptions, an editable agent name, an editable persona, and a left-aligned model dropdown — per `docs/superpowers/specs/2026-06-11-simple-my-agent-tab-design.md`.

**Architecture:** Three small host endpoints (`GET /api/simple-config`, `PUT /api/drafts/:folder/name`, `POST /api/simple-restart`) in one new module + one new frontend tab (`simple.js`) that embeds the real `mountChat()` unchanged inside a `.simple-mode` wrapper and drives its hidden controls programmatically. Zero chat.js changes.

**Tech Stack:** Node host (TypeScript, vitest), vanilla-JS playground frontend (happy-dom tests via vitest), existing drafts API endpoints.

---

## Verified contracts (read before implementing — these pin the integration points)

| Contract                                    | Truth (verified in code)                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent reply bubble class                    | `li.className = 'msg agent'` (chat.js:692). **NOT** `.bubble-agent`.                                                                                                                                                                                                                                                                                                 |
| Direct reply bubble class                   | `li.className = 'bubble bubble-agent bubble-direct'` (chat.js:571).                                                                                                                                                                                                                                                                                                  |
| User bubble class                           | `li.className = 'msg user'` (chat.js:684).                                                                                                                                                                                                                                                                                                                           |
| Mode switch                                 | Hidden buttons `#mode-agent` / `#mode-direct`; `click()` calls `setMode()` (chat.js:384-393). Safe to click programmatically — no fetch side effects.                                                                                                                                                                                                                |
| Hidden provider select                      | `#provider-sel` holds **PROVIDER_GROUP ids** (`openai`/`anthropic`/`local`/`clemson`), not catalog modelProvider names. Its `change` handler pops a confirm modal + auto-PUTs active-model (chat.js:174-199) — **never dispatch `change` on it**; set `.value` silently. Direct mode reads `provSel.value`/`modelSel.value` verbatim at send time (chat.js:499-500). |
| Direct-chat provider normalization          | `direct-chat.ts` NORMALIZE accepts group ids: `openai→codex`, `anthropic→claude`; `local`/`clemson` pass through (direct-chat.ts:308-315). So a group id in `#provider-sel` works.                                                                                                                                                                                   |
| `PUT /api/drafts/:folder/active-model` body | `{ modelProvider: string, model: string }` (models.ts:185-189). Group ids and raw catalog modelProvider names both accepted (group ids get resolved). It also kills running containers itself via `setModelProviderAndModel`.                                                                                                                                        |
| Persona PUT                                 | `PUT /api/drafts/:folder/persona` body `{ text }` — **already recycles the container** (api-routes.ts:347-381). No gate call on it (persona is the always-allowed student mutation).                                                                                                                                                                                 |
| Skills PUT                                  | `PUT /api/drafts/:folder/skills` body `{ skills: string[] \| 'all' }`, gate action `'skills_put'`, does **not** recycle the container (api-routes.ts:548-568).                                                                                                                                                                                                       |
| Gate registry                               | `checkDraftMutation(folder, action, userId)` → `{ allow, reason? }`. `DraftMutationAction` is the closed union `'file_put' \| 'skills_put' \| 'provider_put' \| 'models_put'` — reuse `'skills_put'` for name + restart (same "save my agent" surface); do not extend the union. `PLAYGROUND_AUTH_BYPASS` short-circuits to allow.                                   |
| Read gate                                   | `canReadDraft(folder, session.userId)` → boolean, from `./draft-read-gate.js` (relative to api-routes.ts).                                                                                                                                                                                                                                                           |
| `assistant_name`                            | **Scalar** column → `updateContainerConfigScalars(groupId, { assistant_name })` (container-configs.ts:62). NOT `updateContainerConfigJson` (that throws on non-JSON columns).                                                                                                                                                                                        |
| Group display name                          | `updateAgentGroup(id, { name })` (src/db/agent-groups.ts:53, `Partial<Pick<AgentGroup, 'name' \| 'agent_provider'>>`).                                                                                                                                                                                                                                               |
| `killGroupContainer`                        | Module-local in `api/agent-library-handlers.ts:36-47`, hardcoded reason `'agent library load'`. Export it with a `reason` param.                                                                                                                                                                                                                                     |
| Template slot                               | `readSlotConfig()` from `src/default-participant-slot.ts` → `SlotConfig \| null`; `skills: unknown` (`string[] \| 'all'`), `allowed_models: unknown` (`{provider, model}[]`).                                                                                                                                                                                        |
| Container skills dir                        | `path.join(CONTAINER_DIR, 'skills')` (`CONTAINER_DIR` from `src/config.js` = `<root>/container`). 13 skills today; `pdf-reader/SKILL.md` has **no frontmatter** — description fallback required.                                                                                                                                                                     |
| Frontmatter parse                           | `/^---\n([\s\S]*?)\n---/` then per-line `key: value` (library.ts:88-97 pattern).                                                                                                                                                                                                                                                                                     |
| `materializeContainerJson(groupId)`         | Returns `ContainerConfig`: `skills: string[] \| 'all'`, `modelProvider?`, `provider?`, `model?`, `assistantName?`, `allowedModels?: {provider, model}[]`.                                                                                                                                                                                                            |
| `ApiResult<T>`                              | `{ status: number; body: T \| { error: string } }` from `./me.js`.                                                                                                                                                                                                                                                                                                   |
| Tab system                                  | `app.js:13-14` `TABS` array + `mounters` map; `index.html:22-33` `<nav id="tab-bar">` buttons + `:46-47` `<section id="tab-<name>" class="tab-body" hidden>`. Students see `activeClass.tabsVisibleToStudents ∩ TABS` (app.js:37).                                                                                                                                   |
| Frontend test pattern                       | `// @vitest-environment happy-dom` header, import from the `.js` module, build DOM with `document.createElement` (chat-trace.test.ts). vitest excludes `container/agent-runner/`.                                                                                                                                                                                    |
| Host test pattern                           | `vi.doMock` per-dependency + dynamic `await import('./module.js')` + `vi.resetModules()` in `afterEach` (models.test.ts).                                                                                                                                                                                                                                            |
| PROVIDER_GROUPS                             | `public/provider-groups.js` exports `PROVIDER_GROUPS` with `{ id, displayName, memberModelProviders }` — maps catalog modelProvider → dropdown group id.                                                                                                                                                                                                             |
| Pre-commit hook                             | Runs prettier `format:check` (commit fails on unformatted files) and regenerates state.md's volatile section. Run `pnpm exec prettier --write <files>` before committing.                                                                                                                                                                                            |

**Two deliberate deltas from the spec (already justified above):**

1. Reply styling targets `.simple-mode .msg.agent` (green) and `.simple-mode .bubble-direct` (blue-gray) — the spec's `.bubble-agent:not(.bubble-direct)` selector doesn't match real agent bubbles.
2. The hidden-select sync sets values **without** dispatching `change` (avoids the provider-switch modal + double PUT); the simple tab issues its own `PUT active-model`.
3. (Addition) `GET /api/simple-config` also returns `agentName` and `activeModel` so the tab can prefill the name field and preselect the dropdown without extra calls.

## File Structure

| File                                                    | Action          | Responsibility                                                                                                                                  |
| ------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/channels/playground/api/agent-library-handlers.ts` | Modify          | Export `killGroupContainer` with a `reason` param                                                                                               |
| `src/channels/playground/api/simple-config.ts`          | Create          | All three simple-tab handlers: `handleGetSimpleConfig`, `handlePutAgentName`, `handleSimpleRestart` (+ exported `humanizeSkillTitle` for tests) |
| `src/channels/playground/api/simple-config.test.ts`     | Create          | Host tests for all three handlers                                                                                                               |
| `src/channels/playground/api-routes.ts`                 | Modify          | Register the three routes with read/mutation gates                                                                                              |
| `src/channels/playground/public/tabs/simple.js`         | Create          | The tab: layout, embedded `mountChat`, panel, exported helpers                                                                                  |
| `src/channels/playground/public/tabs/simple.test.ts`    | Create          | happy-dom tests for the exported helpers                                                                                                        |
| `src/channels/playground/public/app.js`                 | Modify          | Register `simple` in TABS/mounters; hide tab strip when exactly one tab                                                                         |
| `src/channels/playground/public/index.html`             | Modify          | Tab button + section                                                                                                                            |
| `src/channels/playground/public/style.css`              | Modify          | `.simple-mode` layout, hiding, bubble styling                                                                                                   |
| `state.md`                                              | Modify (Task 8) | Decision-log entry                                                                                                                              |

---

### Task 1: Export `killGroupContainer`

**Files:**

- Modify: `src/channels/playground/api/agent-library-handlers.ts:35-47`

- [ ] **Step 1: Make the helper exported and parameterize the kill reason**

In `src/channels/playground/api/agent-library-handlers.ts`, replace:

```ts
/** Stop any running container for the group so the next message respawns. */
function killGroupContainer(folder: string): void {
  const group = getAgentGroupByFolder(folder);
  if (!group) return;
  for (const s of getActiveSessions()) {
    if (s.agent_group_id !== group.id) continue;
    if (!isContainerRunning(s.id)) continue;
    try {
      killContainer(s.id, 'agent library load');
    } catch {
      /* best-effort */
    }
  }
}
```

with:

```ts
/** Stop any running container for the group so the next message respawns. */
export function killGroupContainer(folder: string, reason = 'agent library load'): void {
  const group = getAgentGroupByFolder(folder);
  if (!group) return;
  for (const s of getActiveSessions()) {
    if (s.agent_group_id !== group.id) continue;
    if (!isContainerRunning(s.id)) continue;
    try {
      killContainer(s.id, reason);
    } catch {
      /* best-effort */
    }
  }
}
```

(All existing call sites in this file call it with one argument — the default preserves their behavior. Do not touch them.)

- [ ] **Step 2: Verify existing tests still pass**

Run: `pnpm exec vitest run src/channels/playground/api/agent-library.test.ts`
Expected: PASS (all existing tests green — behavior unchanged).

- [ ] **Step 3: Commit**

```bash
pnpm exec prettier --write src/channels/playground/api/agent-library-handlers.ts
git add src/channels/playground/api/agent-library-handlers.ts
git commit -m "refactor(playground): export killGroupContainer with reason param"
```

---

### Task 2: `handleGetSimpleConfig` (TDD)

**Files:**

- Create: `src/channels/playground/api/simple-config.ts`
- Test: `src/channels/playground/api/simple-config.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/channels/playground/api/simple-config.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const TMP = '/tmp/nanoclaw-test-simple-config';
const SKILLS = path.join(TMP, 'container', 'skills');

// CONTAINER_DIR is read at module load by simple-config.ts, so the config
// mock must be in place before the dynamic import in each test.
vi.mock('../../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../../config.js')>('../../../config.js');
  return { ...actual, CONTAINER_DIR: path.join('/tmp/nanoclaw-test-simple-config', 'container') };
});

function writeSkill(name: string, md: string | null) {
  const dir = path.join(SKILLS, name);
  fs.mkdirSync(dir, { recursive: true });
  if (md !== null) fs.writeFileSync(path.join(dir, 'SKILL.md'), md);
}

const GROUP = { id: 'ag-1', folder: 'user_01', name: 'Pilot User 1', agent_provider: null, created_at: '' };

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(SKILLS, { recursive: true });
  writeSkill(
    'image-gen',
    '---\ndescription: Create pictures, logos, and illustrations. Saves them as files.\n---\n# Image gen\n',
  );
  writeSkill('pdf-reader', '# PDF Reader\nNo frontmatter here.\n');
  writeSkill('wiki', '---\ndescription: Browse and edit the course wiki\n---\n# Wiki\n');
});

afterEach(() => {
  vi.resetModules();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('handleGetSimpleConfig', () => {
  it('returns the template shortlist with descriptions, titles, and enabled state', async () => {
    vi.doMock('../../../db/agent-groups.js', () => ({ getAgentGroupByFolder: () => GROUP }));
    vi.doMock('../../../container-config.js', () => ({
      materializeContainerJson: () => ({
        skills: ['image-gen'],
        modelProvider: 'openai-codex',
        model: 'gpt-5.4-mini',
        assistantName: 'JaneBot',
      }),
    }));
    vi.doMock('../../../default-participant-slot.js', () => ({
      readSlotConfig: () => ({ skills: ['image-gen', 'pdf-reader'], allowed_models: [] }),
    }));
    vi.doMock('../../../model-catalog.js', () => ({ getModelCatalog: () => [] }));
    const { handleGetSimpleConfig } = await import('./simple-config.js');
    const r = handleGetSimpleConfig('user_01');
    expect(r.status).toBe(200);
    const body = r.body as {
      agentName: string;
      skills: { name: string; title: string; description: string; enabled: boolean }[];
    };
    expect(body.agentName).toBe('JaneBot');
    expect(body.skills).toEqual([
      {
        name: 'image-gen',
        title: 'Image gen',
        description: 'Create pictures, logos, and illustrations.',
        enabled: true,
      },
      {
        name: 'pdf-reader',
        title: 'Pdf reader',
        description: 'Pdf reader',
        enabled: false,
      },
    ]);
  });

  it("template skills 'all' (or missing slot) falls back to the full container skills dir", async () => {
    vi.doMock('../../../db/agent-groups.js', () => ({ getAgentGroupByFolder: () => GROUP }));
    vi.doMock('../../../container-config.js', () => ({
      materializeContainerJson: () => ({ skills: 'all', model: 'gpt-5.4-mini', modelProvider: 'openai-codex' }),
    }));
    vi.doMock('../../../default-participant-slot.js', () => ({ readSlotConfig: () => null }));
    vi.doMock('../../../model-catalog.js', () => ({ getModelCatalog: () => [] }));
    const { handleGetSimpleConfig } = await import('./simple-config.js');
    const r = handleGetSimpleConfig('user_01');
    expect(r.status).toBe(200);
    const body = r.body as { skills: { name: string; enabled: boolean }[] };
    expect(body.skills.map((s) => s.name)).toEqual(['image-gen', 'pdf-reader', 'wiki']);
    // agent has skills:'all' → everything reads enabled
    expect(body.skills.every((s) => s.enabled)).toBe(true);
  });

  it('resolves template allowed_models against the catalog; falls back to the active model when empty', async () => {
    vi.doMock('../../../db/agent-groups.js', () => ({ getAgentGroupByFolder: () => GROUP }));
    vi.doMock('../../../container-config.js', () => ({
      materializeContainerJson: () => ({ skills: [], modelProvider: 'openai-codex', model: 'gpt-5.4-mini' }),
    }));
    vi.doMock('../../../model-catalog.js', () => ({
      getModelCatalog: () => [{ id: 'claude-haiku-4-5', modelProvider: 'anthropic', displayName: 'Claude Haiku 4.5' }],
    }));

    // a) template has two models — one in catalog (display name), one not (id fallback)
    vi.doMock('../../../default-participant-slot.js', () => ({
      readSlotConfig: () => ({
        skills: [],
        allowed_models: [
          { provider: 'anthropic', model: 'claude-haiku-4-5' },
          { provider: 'local', model: 'Qwen3.6-35B' },
        ],
      }),
    }));
    let mod = await import('./simple-config.js');
    let r = mod.handleGetSimpleConfig('user_01');
    let body = r.body as { models: { provider: string; id: string; displayName: string }[]; activeModel: unknown };
    expect(body.models).toEqual([
      { provider: 'anthropic', id: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5' },
      { provider: 'local', id: 'Qwen3.6-35B', displayName: 'Qwen3.6-35B' },
    ]);
    expect(body.activeModel).toEqual({ provider: 'openai-codex', id: 'gpt-5.4-mini' });

    // b) empty template list → the agent's current model is the only entry
    vi.resetModules();
    vi.doMock('../../../db/agent-groups.js', () => ({ getAgentGroupByFolder: () => GROUP }));
    vi.doMock('../../../container-config.js', () => ({
      materializeContainerJson: () => ({ skills: [], modelProvider: 'openai-codex', model: 'gpt-5.4-mini' }),
    }));
    vi.doMock('../../../model-catalog.js', () => ({ getModelCatalog: () => [] }));
    vi.doMock('../../../default-participant-slot.js', () => ({
      readSlotConfig: () => ({ skills: [], allowed_models: [] }),
    }));
    mod = await import('./simple-config.js');
    r = mod.handleGetSimpleConfig('user_01');
    body = r.body as typeof body;
    expect(body.models).toEqual([{ provider: 'openai-codex', id: 'gpt-5.4-mini', displayName: 'gpt-5.4-mini' }]);
  });

  it('404s on an unknown folder', async () => {
    vi.doMock('../../../db/agent-groups.js', () => ({ getAgentGroupByFolder: () => undefined }));
    vi.doMock('../../../container-config.js', () => ({ materializeContainerJson: () => ({ skills: [] }) }));
    vi.doMock('../../../default-participant-slot.js', () => ({ readSlotConfig: () => null }));
    vi.doMock('../../../model-catalog.js', () => ({ getModelCatalog: () => [] }));
    const { handleGetSimpleConfig } = await import('./simple-config.js');
    expect(handleGetSimpleConfig('nope').status).toBe(404);
  });
});

describe('humanizeSkillTitle', () => {
  it('kebab → spaced, first letter capitalized', async () => {
    const { humanizeSkillTitle } = await import('./simple-config.js');
    expect(humanizeSkillTitle('image-gen')).toBe('Image gen');
    expect(humanizeSkillTitle('rag-pdf-ingest')).toBe('Rag pdf ingest');
    expect(humanizeSkillTitle('wiki')).toBe('Wiki');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/channels/playground/api/simple-config.test.ts`
Expected: FAIL — `Cannot find module './simple-config.js'`.

- [ ] **Step 3: Implement `simple-config.ts` (GET handler + helpers only)**

Create `src/channels/playground/api/simple-config.ts`:

```ts
/**
 * Backend for the "My Agent" simple beginner tab.
 *
 *   GET  /api/simple-config?folder=…  — instructor-curated skill shortlist +
 *                                       model choices (from the default-
 *                                       participant template slot)
 *   PUT  /api/drafts/:folder/name     — student-editable assistant name
 *   POST /api/simple-restart          — recycle the group's container so a
 *                                       panel save takes effect next message
 *
 * Spec: docs/superpowers/specs/2026-06-11-simple-my-agent-tab-design.md
 */
import fs from 'fs';
import path from 'path';

import { CONTAINER_DIR } from '../../../config.js';
import { materializeContainerJson } from '../../../container-config.js';
import { getAgentGroupByFolder, updateAgentGroup } from '../../../db/agent-groups.js';
import { updateContainerConfigScalars } from '../../../db/container-configs.js';
import { readSlotConfig } from '../../../default-participant-slot.js';
import { getModelCatalog } from '../../../model-catalog.js';
import { killGroupContainer } from './agent-library-handlers.js';
import type { ApiResult } from './me.js';

const SKILLS_DIR = path.join(CONTAINER_DIR, 'skills');

export interface SimpleSkill {
  name: string;
  title: string;
  description: string;
  enabled: boolean;
}

export interface SimpleModel {
  provider: string;
  id: string;
  displayName: string;
}

export interface SimpleConfigResponse {
  agentName: string;
  skills: SimpleSkill[];
  models: SimpleModel[];
  activeModel: { provider: string; id: string } | null;
}

/** `image-gen` → "Image gen". Kebab/snake → spaces, first letter capitalized. */
export function humanizeSkillTitle(name: string): string {
  const words = name.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function listContainerSkills(): string[] {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  return fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * First sentence of the SKILL.md frontmatter `description`. Falls back to
 * the humanized name when the file or frontmatter is missing (pdf-reader
 * ships without frontmatter).
 */
function skillDescription(name: string): string {
  try {
    const md = fs.readFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
    const fm = md.match(/^---\n([\s\S]*?)\n---/);
    if (fm) {
      for (const line of fm[1]!.split('\n')) {
        const m = line.match(/^description:\s*(.+)$/);
        if (m) {
          const full = m[1]!.trim();
          const sentence = full.match(/^.*?[.!?](?=\s|$)/);
          return sentence ? sentence[0]! : full;
        }
      }
    }
  } catch {
    /* unreadable SKILL.md — fall through to the name */
  }
  return humanizeSkillTitle(name);
}

export function handleGetSimpleConfig(draftFolder: string): ApiResult<SimpleConfigResponse> {
  try {
    const group = getAgentGroupByFolder(draftFolder);
    if (!group) return { status: 404, body: { error: `Agent group not found: ${draftFolder}` } };
    const cfg = materializeContainerJson(group.id);

    // Shortlist = the default-participant template's skill list. 'all' or a
    // missing slot → the full container/skills library (the instructor
    // narrows the template to curate).
    const slot = readSlotConfig();
    const slotSkills = slot?.skills;
    const shortlist = Array.isArray(slotSkills)
      ? slotSkills.filter((s): s is string => typeof s === 'string')
      : listContainerSkills();

    const enabledSet = new Set(cfg.skills === 'all' ? listContainerSkills() : cfg.skills);
    const skills: SimpleSkill[] = shortlist.map((name) => ({
      name,
      title: humanizeSkillTitle(name),
      description: skillDescription(name),
      enabled: enabledSet.has(name),
    }));

    // Model choices = the template's allowed_models resolved against the
    // catalog. Empty/missing → the agent's current model as the only entry.
    const catalog = getModelCatalog();
    const displayNameFor = (provider: string, id: string): string =>
      catalog.find((c) => c.modelProvider === provider && c.id === id)?.displayName || id;

    const slotModels = Array.isArray(slot?.allowed_models)
      ? (slot.allowed_models as { provider?: unknown; model?: unknown }[])
      : [];
    const models: SimpleModel[] = [];
    for (const am of slotModels) {
      if (!am || typeof am.provider !== 'string' || typeof am.model !== 'string') continue;
      models.push({ provider: am.provider, id: am.model, displayName: displayNameFor(am.provider, am.model) });
    }

    const activeProvider = cfg.modelProvider || cfg.provider || '';
    const activeModel = cfg.model && activeProvider ? { provider: activeProvider, id: cfg.model } : null;
    if (models.length === 0 && activeModel) {
      models.push({
        provider: activeModel.provider,
        id: activeModel.id,
        displayName: displayNameFor(activeModel.provider, activeModel.id),
      });
    }

    return {
      status: 200,
      body: { agentName: cfg.assistantName || group.name, skills, models, activeModel },
    };
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}
```

(`updateAgentGroup`, `updateContainerConfigScalars`, and `killGroupContainer` are imported now but used in Task 3 — if the linter complains about unused imports at this step, add them in Task 3 instead.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/channels/playground/api/simple-config.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write src/channels/playground/api/simple-config.ts src/channels/playground/api/simple-config.test.ts
git add src/channels/playground/api/simple-config.ts src/channels/playground/api/simple-config.test.ts
git commit -m "feat(playground): GET /api/simple-config handler — template skill shortlist + model choices"
```

---

### Task 3: `handlePutAgentName` + `handleSimpleRestart` (TDD)

**Files:**

- Modify: `src/channels/playground/api/simple-config.ts` (append)
- Test: `src/channels/playground/api/simple-config.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `src/channels/playground/api/simple-config.test.ts`:

```ts
describe('handlePutAgentName', () => {
  function mockWriteDeps() {
    const updateScalars = vi.fn();
    const updateGroup = vi.fn();
    const materialize = vi.fn(() => ({ skills: [] }));
    vi.doMock('../../../db/agent-groups.js', () => ({
      getAgentGroupByFolder: () => GROUP,
      updateAgentGroup: updateGroup,
    }));
    vi.doMock('../../../db/container-configs.js', () => ({ updateContainerConfigScalars: updateScalars }));
    vi.doMock('../../../container-config.js', () => ({ materializeContainerJson: materialize }));
    vi.doMock('../../../default-participant-slot.js', () => ({ readSlotConfig: () => null }));
    vi.doMock('../../../model-catalog.js', () => ({ getModelCatalog: () => [] }));
    return { updateScalars, updateGroup, materialize };
  }

  it('writes assistant_name + group display name and re-materializes container.json', async () => {
    const { updateScalars, updateGroup, materialize } = mockWriteDeps();
    const { handlePutAgentName } = await import('./simple-config.js');
    const r = handlePutAgentName('user_01', { name: '  JaneBot  ' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, name: 'JaneBot' });
    expect(updateScalars).toHaveBeenCalledWith('ag-1', { assistant_name: 'JaneBot' });
    expect(updateGroup).toHaveBeenCalledWith('ag-1', { name: 'JaneBot' });
    expect(materialize).toHaveBeenCalledWith('ag-1');
  });

  it('400s on empty, whitespace-only, too-long, or non-string names', async () => {
    mockWriteDeps();
    const { handlePutAgentName } = await import('./simple-config.js');
    expect(handlePutAgentName('user_01', { name: '' }).status).toBe(400);
    expect(handlePutAgentName('user_01', { name: '   ' }).status).toBe(400);
    expect(handlePutAgentName('user_01', { name: 'x'.repeat(41) }).status).toBe(400);
    expect(handlePutAgentName('user_01', { name: 42 }).status).toBe(400);
    expect(handlePutAgentName('user_01', {}).status).toBe(400);
  });

  it('404s on an unknown folder', async () => {
    vi.doMock('../../../db/agent-groups.js', () => ({
      getAgentGroupByFolder: () => undefined,
      updateAgentGroup: vi.fn(),
    }));
    vi.doMock('../../../db/container-configs.js', () => ({ updateContainerConfigScalars: vi.fn() }));
    vi.doMock('../../../container-config.js', () => ({ materializeContainerJson: vi.fn() }));
    vi.doMock('../../../default-participant-slot.js', () => ({ readSlotConfig: () => null }));
    vi.doMock('../../../model-catalog.js', () => ({ getModelCatalog: () => [] }));
    const { handlePutAgentName } = await import('./simple-config.js');
    expect(handlePutAgentName('nope', { name: 'X' }).status).toBe(404);
  });
});

describe('handleSimpleRestart', () => {
  it('kills the group container and reports ok', async () => {
    const kill = vi.fn();
    vi.doMock('../../../db/agent-groups.js', () => ({
      getAgentGroupByFolder: () => GROUP,
      updateAgentGroup: vi.fn(),
    }));
    vi.doMock('./agent-library-handlers.js', () => ({ killGroupContainer: kill }));
    vi.doMock('../../../db/container-configs.js', () => ({ updateContainerConfigScalars: vi.fn() }));
    vi.doMock('../../../container-config.js', () => ({ materializeContainerJson: vi.fn() }));
    vi.doMock('../../../default-participant-slot.js', () => ({ readSlotConfig: () => null }));
    vi.doMock('../../../model-catalog.js', () => ({ getModelCatalog: () => [] }));
    const { handleSimpleRestart } = await import('./simple-config.js');
    const r = handleSimpleRestart('user_01');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(kill).toHaveBeenCalledWith('user_01', 'simple tab save');
  });

  it('404s on an unknown folder', async () => {
    vi.doMock('../../../db/agent-groups.js', () => ({
      getAgentGroupByFolder: () => undefined,
      updateAgentGroup: vi.fn(),
    }));
    vi.doMock('./agent-library-handlers.js', () => ({ killGroupContainer: vi.fn() }));
    vi.doMock('../../../db/container-configs.js', () => ({ updateContainerConfigScalars: vi.fn() }));
    vi.doMock('../../../container-config.js', () => ({ materializeContainerJson: vi.fn() }));
    vi.doMock('../../../default-participant-slot.js', () => ({ readSlotConfig: () => null }));
    vi.doMock('../../../model-catalog.js', () => ({ getModelCatalog: () => [] }));
    const { handleSimpleRestart } = await import('./simple-config.js');
    expect(handleSimpleRestart('nope').status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm exec vitest run src/channels/playground/api/simple-config.test.ts`
Expected: FAIL — `handlePutAgentName is not a function` (and same for `handleSimpleRestart`). The Task 2 tests must still PASS.

- [ ] **Step 3: Implement both handlers**

Append to `src/channels/playground/api/simple-config.ts`:

```ts
/**
 * PUT /api/drafts/:folder/name — set the assistant's display name. Writes
 * the container-config `assistant_name` (system prompt at next spawn) AND
 * the agent group's display name so rosters and /api/me/agent agree.
 */
export function handlePutAgentName(
  draftFolder: string,
  body: { name?: unknown },
): ApiResult<{ ok: true; name: string }> {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length < 1 || name.length > 40) {
    return { status: 400, body: { error: 'name must be 1–40 characters' } };
  }
  try {
    const group = getAgentGroupByFolder(draftFolder);
    if (!group) return { status: 404, body: { error: `Agent group not found: ${draftFolder}` } };
    updateContainerConfigScalars(group.id, { assistant_name: name });
    updateAgentGroup(group.id, { name });
    materializeContainerJson(group.id);
    return { status: 200, body: { ok: true, name } };
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

/**
 * POST /api/simple-restart — stop the group's running container so the next
 * message respawns with freshly-saved skills/name. A separate endpoint
 * (rather than baking the kill into the skills PUT) because the skills PUT
 * is shared with the advanced Skills tab, where editing shouldn't bounce a
 * working container mid-session.
 */
export function handleSimpleRestart(draftFolder: string): ApiResult<{ ok: true }> {
  try {
    const group = getAgentGroupByFolder(draftFolder);
    if (!group) return { status: 404, body: { error: `Agent group not found: ${draftFolder}` } };
    killGroupContainer(draftFolder, 'simple tab save');
    return { status: 200, body: { ok: true } };
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/channels/playground/api/simple-config.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write src/channels/playground/api/simple-config.ts src/channels/playground/api/simple-config.test.ts
git add src/channels/playground/api/simple-config.ts src/channels/playground/api/simple-config.test.ts
git commit -m "feat(playground): agent-name PUT + simple-restart handlers"
```

---

### Task 4: Register the three routes

**Files:**

- Modify: `src/channels/playground/api-routes.ts`

- [ ] **Step 1: Add the import**

In the import block of `src/channels/playground/api-routes.ts` (alongside the other `./api/*.js` handler imports), add:

```ts
import { handleGetSimpleConfig, handlePutAgentName, handleSimpleRestart } from './api/simple-config.js';
```

- [ ] **Step 2: Register the routes**

Insert directly **after** the `PUT /api/drafts/:folder/active-model` block (which ends near line 668, `return send(res, r.status, r.body);` followed by `}`):

```ts
// GET /api/simple-config?folder=… — beginner-tab config: template skill
// shortlist + model choices + the agent's current name/model. Member-
// readable behind the same draft-read gate as the other drafts GETs.
if (method === 'GET' && url.pathname === '/api/simple-config') {
  const folder = url.searchParams.get('folder') || '';
  if (!canReadDraft(folder, session.userId)) return send(res, 403, { error: 'Forbidden' });
  const r = handleGetSimpleConfig(folder);
  return send(res, r.status, r.body);
}

// PUT /api/drafts/:folder/name — student-editable assistant name.
// Reuses the skills_put gate action: name edits belong to the same
// "save my agent" surface as the skills checklist.
const nameMatch = url.pathname.match(/^\/api\/drafts\/([A-Za-z0-9_-]+)\/name$/);
if (method === 'PUT' && nameMatch) {
  const draftFolder = nameMatch[1]!;
  {
    const decision = checkDraftMutation(draftFolder, 'skills_put', session.userId);
    if (!decision.allow) return send(res, 403, { error: decision.reason || 'Forbidden' });
  }
  const body = await readJsonBody(req);
  const r = handlePutAgentName(draftFolder, body as { name?: unknown });
  return send(res, r.status, r.body);
}

// POST /api/simple-restart — recycle the group's container so a simple-tab
// save takes effect on the next message.
if (method === 'POST' && url.pathname === '/api/simple-restart') {
  const body = await readJsonBody(req);
  const folder = typeof body.folder === 'string' ? body.folder : '';
  if (!folder) return send(res, 400, { error: 'folder (string) required' });
  {
    const decision = checkDraftMutation(folder, 'skills_put', session.userId);
    if (!decision.allow) return send(res, 403, { error: decision.reason || 'Forbidden' });
  }
  const r = handleSimpleRestart(folder);
  return send(res, r.status, r.body);
}
```

- [ ] **Step 3: Build + full host suite**

Run: `pnpm run build && pnpm test`
Expected: build clean, all tests pass.

- [ ] **Step 4: Commit**

```bash
pnpm exec prettier --write src/channels/playground/api-routes.ts
git add src/channels/playground/api-routes.ts
git commit -m "feat(playground): wire simple-config, name, and simple-restart routes"
```

---

### Task 5: Tab registration + `simple.js` skeleton + CSS hiding

**Files:**

- Create: `src/channels/playground/public/tabs/simple.js`
- Modify: `src/channels/playground/public/app.js:1-14, 38-41`
- Modify: `src/channels/playground/public/index.html:22-33, ~47`
- Modify: `src/channels/playground/public/style.css` (append)

No unit test in this task — the skeleton is mount-time orchestration (fetch + DOM wiring); its testable helpers land with tests in Tasks 6–7. Verification here is build + existing suite + the happy-dom import smoke check in Task 6.

- [ ] **Step 1: Create `simple.js` with the layout and embedded chat**

Create `src/channels/playground/public/tabs/simple.js`:

```js
/**
 * "My Agent" — the beginner tab. One chat window + one side panel.
 *
 * The chat is the REAL chat tab embedded unchanged (mountChat) inside a
 * `.simple-mode` wrapper; scoped CSS hides the advanced chrome (toolbar,
 * trace panel). The panel drives chat.js's hidden controls programmatically:
 *   - Use-agent toggle → clicks the hidden #mode-agent / #mode-direct
 *   - model dropdown   → PUT active-model + silently sync the hidden
 *     #provider-sel / #model-sel (NO change event — chat.js's own change
 *     handler pops a confirm modal and PUTs active-model itself)
 *
 * Hidden-control contract pinned by simple.test.ts: #mode-agent,
 * #mode-direct, #provider-sel, #model-sel.
 *
 * Spec: docs/superpowers/specs/2026-06-11-simple-my-agent-tab-design.md
 */
import { mountChat } from './chat.js';
import { PROVIDER_GROUPS } from '../provider-groups.js';

export function mountSimple(el) {
  const folder = window.__pg.agent.folder;

  el.innerHTML = `
    <div class="simple-mode">
      <div class="simple-topbar">
        <label>model <select id="simple-model-sel"></select></label>
      </div>
      <div class="simple-layout">
        <div class="simple-chat-host"></div>
        <aside class="simple-panel">
          <div class="simple-panel-header">
            <label class="simple-toggle" title="Off = talk to the raw model — no skills, no personality">
              <input type="checkbox" id="simple-use-agent" checked>
              <span>Use agent</span>
            </label>
            <input id="simple-agent-name" class="simple-name-input" maxlength="40"
                   title="Your agent's name — click to edit" aria-label="Agent name">
          </div>
          <div class="simple-panel-body">
            <div class="simple-section-label">Skills <span class="simple-hint">(click ⓘ to learn)</span></div>
            <div id="simple-skills"></div>
            <div class="simple-section-label">Personality</div>
            <textarea id="simple-persona" rows="6"></textarea>
            <button id="simple-save" class="btn btn-primary" type="button">Save my agent</button>
            <div id="simple-save-status" class="simple-save-status" role="status"></div>
          </div>
        </aside>
      </div>
    </div>
  `;

  const wrapper = el.querySelector('.simple-mode');
  mountChat(el.querySelector('.simple-chat-host'));

  initPanel(wrapper, folder);
}

// Panel orchestration — fleshed out in Task 6 (data load + wiring) and
// Task 7 (model dropdown + bubble labels). Kept separate from mountSimple
// so the testable helpers below stay pure DOM.
function initPanel(wrapper, folder) {
  /* Task 6 */
}
```

- [ ] **Step 2: Register the tab in `index.html`**

In `src/channels/playground/public/index.html`, add a button inside `<nav id="tab-bar">` after the Home button (line 23):

```html
<button data-tab="simple" class="tab">My Agent</button>
```

And add the tab section after the `tab-home` section (line 46):

```html
<section id="tab-simple" class="tab-body" hidden></section>
```

- [ ] **Step 3: Register the tab in `app.js` and auto-hide the strip for single-tab students**

In `src/channels/playground/public/app.js`:

Add the import after line 1 (`mountHome` import):

```js
import { mountSimple } from './tabs/simple.js';
```

Replace lines 13–14:

```js
const TABS = ['home', 'chat', 'persona', 'skills', 'models', 'agents', 'sources', 'retrieval', 'benchmarks', 'status'];
const mounters = {
  home: mountHome,
  chat: mountChat,
  persona: mountPersona,
  skills: mountSkills,
  models: mountModels,
  agents: mountAgents,
  sources: mountSources,
  retrieval: mountRetrieval,
  benchmarks: mountBenchmarks,
  status: mountStatus,
};
```

with:

```js
const TABS = [
  'home',
  'simple',
  'chat',
  'persona',
  'skills',
  'models',
  'agents',
  'sources',
  'retrieval',
  'benchmarks',
  'status',
];
const mounters = {
  home: mountHome,
  simple: mountSimple,
  chat: mountChat,
  persona: mountPersona,
  skills: mountSkills,
  models: mountModels,
  agents: mountAgents,
  sources: mountSources,
  retrieval: mountRetrieval,
  benchmarks: mountBenchmarks,
  status: mountStatus,
};
```

In `applyClassControls` (after the per-button `hidden` loop, lines 38–41), add the strip auto-hide:

```js
// A student stripped down to exactly one tab gets a single uncluttered
// page — no tab strip at all.
const tabBar = document.getElementById('tab-bar');
if (tabBar) tabBar.hidden = allowedTabs.length === 1;
```

- [ ] **Step 4: Add the `.simple-mode` CSS**

Append to `src/channels/playground/public/style.css`:

```css
/* ── "My Agent" simple tab ─────────────────────────────────────────────── */
/* Hide the embedded chat's advanced chrome. Hiding the whole toolbar covers
   the mode buttons, provider/model/reasoning selects, and Export in one
   rule — the simple tab provides its own model dropdown and agent name. */
.simple-mode .chat-toolbar {
  display: none;
}
.simple-mode .trace-panel {
  display: none;
}

.simple-topbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  margin-bottom: 8px;
  border: 1px solid #ddd;
  border-radius: 6px;
  background: #fafafa;
  font-size: 13px;
}

.simple-layout {
  display: flex;
  gap: 12px;
  align-items: stretch;
}
.simple-chat-host {
  flex: 2.2;
  min-width: 0;
}
.simple-panel {
  flex: 1;
  min-width: 220px;
  border: 1px solid #ccc;
  border-radius: 8px;
  padding: 12px;
  align-self: flex-start;
}

.simple-panel-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid #eee;
}
.simple-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  font-weight: 600;
}
.simple-name-input {
  flex: 1;
  min-width: 0;
  font-weight: 600;
}

.simple-section-label {
  font-weight: 600;
  margin: 10px 0 4px;
}
.simple-hint {
  color: #999;
  font-weight: 400;
  font-size: 12px;
}

.simple-skill-row {
  margin: 3px 0;
}
.simple-info-btn {
  border: none;
  background: none;
  color: #4a5a96;
  cursor: pointer;
  font-size: 13px;
  padding: 0 4px;
}
.simple-skill-desc {
  background: #f4f6fb;
  border: 1px solid #dde;
  border-radius: 4px;
  padding: 6px;
  margin: 4px 0;
  color: #445;
  font-size: 12px;
}

#simple-persona {
  width: 100%;
  box-sizing: border-box;
}
#simple-save {
  margin-top: 10px;
}
.simple-save-status {
  color: #888;
  font-size: 12px;
  margin-top: 4px;
  min-height: 1em;
}

/* Toggle OFF — everything below the header grayed and inert. */
.simple-panel-body.simple-disabled {
  opacity: 0.35;
  pointer-events: none;
}
```

- [ ] **Step 5: Build + suite**

Run: `pnpm run build && pnpm test`
Expected: build clean, all tests pass (no frontend test imports simple.js yet).

- [ ] **Step 6: Commit**

```bash
pnpm exec prettier --write src/channels/playground/public/tabs/simple.js src/channels/playground/public/app.js src/channels/playground/public/index.html src/channels/playground/public/style.css
git add src/channels/playground/public/tabs/simple.js src/channels/playground/public/app.js src/channels/playground/public/index.html src/channels/playground/public/style.css
git commit -m "feat(playground): My Agent simple tab skeleton — registration, layout, embedded chat, CSS hiding"
```

---

### Task 6: Side panel — skills checklist, persona, toggle, name, Save (TDD)

**Files:**

- Modify: `src/channels/playground/public/tabs/simple.js`
- Test: `src/channels/playground/public/tabs/simple.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/channels/playground/public/tabs/simple.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { renderSkillRows, checkedSkills, applyUseAgentToggle } from './simple.js';

const SKILLS = [
  { name: 'image-gen', title: 'Image gen', description: 'Create pictures and logos.', enabled: true },
  { name: 'pdf-reader', title: 'Pdf reader', description: 'Read PDFs.', enabled: false },
];

describe('renderSkillRows / checkedSkills', () => {
  it('renders one checkbox row per skill with the saved checked state', () => {
    const host = document.createElement('div');
    renderSkillRows(host, SKILLS);
    const boxes = host.querySelectorAll('input[type="checkbox"]');
    expect(boxes.length).toBe(2);
    expect((boxes[0] as HTMLInputElement).checked).toBe(true);
    expect((boxes[1] as HTMLInputElement).checked).toBe(false);
    expect(host.textContent).toContain('Image gen');
    expect(checkedSkills(host)).toEqual(['image-gen']);
  });

  it('ⓘ expands the description inline, one open at a time', () => {
    const host = document.createElement('div');
    renderSkillRows(host, SKILLS);
    const infos = host.querySelectorAll('.simple-info-btn');
    const descs = host.querySelectorAll('.simple-skill-desc');
    expect((descs[0] as HTMLElement).hidden).toBe(true);

    (infos[0] as HTMLElement).click();
    expect((descs[0] as HTMLElement).hidden).toBe(false);
    expect((descs[0] as HTMLElement).textContent).toContain('Create pictures');

    (infos[1] as HTMLElement).click(); // opening the second closes the first
    expect((descs[0] as HTMLElement).hidden).toBe(true);
    expect((descs[1] as HTMLElement).hidden).toBe(false);

    (infos[1] as HTMLElement).click(); // clicking again closes it
    expect((descs[1] as HTMLElement).hidden).toBe(true);
  });
});

describe('applyUseAgentToggle', () => {
  function wrapperWithHiddenModeButtons() {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
      <button id="mode-agent"></button>
      <button id="mode-direct"></button>
      <div class="simple-panel-body"></div>
    `;
    return wrapper;
  }

  it('OFF clicks the hidden #mode-direct and grays the panel body', () => {
    const wrapper = wrapperWithHiddenModeButtons();
    let clicked = '';
    wrapper.querySelector('#mode-agent')!.addEventListener('click', () => (clicked = 'agent'));
    wrapper.querySelector('#mode-direct')!.addEventListener('click', () => (clicked = 'direct'));

    applyUseAgentToggle(wrapper, false);
    expect(clicked).toBe('direct');
    expect(wrapper.querySelector('.simple-panel-body')!.classList.contains('simple-disabled')).toBe(true);

    applyUseAgentToggle(wrapper, true);
    expect(clicked).toBe('agent');
    expect(wrapper.querySelector('.simple-panel-body')!.classList.contains('simple-disabled')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/channels/playground/public/tabs/simple.test.ts`
Expected: FAIL — `renderSkillRows` (etc.) not exported.

- [ ] **Step 3: Implement the helpers and panel wiring**

In `src/channels/playground/public/tabs/simple.js`, add the exported helpers (above `mountSimple`):

```js
/** Render the shortlist as checkbox rows with ⓘ inline-expand descriptions. */
export function renderSkillRows(container, skills) {
  container.innerHTML = '';
  for (const s of skills) {
    const row = document.createElement('div');
    row.className = 'simple-skill-row';

    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!s.enabled;
    cb.dataset.skill = s.name;
    label.appendChild(cb);
    label.appendChild(document.createTextNode(` ${s.title} `));

    const info = document.createElement('button');
    info.type = 'button';
    info.className = 'simple-info-btn';
    info.setAttribute('aria-label', `About ${s.title}`);
    info.textContent = 'ⓘ';

    const desc = document.createElement('div');
    desc.className = 'simple-skill-desc';
    desc.hidden = true;
    desc.textContent = s.description;

    info.addEventListener('click', () => {
      const wasHidden = desc.hidden;
      for (const d of container.querySelectorAll('.simple-skill-desc')) d.hidden = true; // one open at a time
      desc.hidden = !wasHidden;
    });

    row.appendChild(label);
    row.appendChild(info);
    row.appendChild(desc);
    container.appendChild(row);
  }
}

/** The checked subset of the rendered shortlist, as skill names. */
export function checkedSkills(container) {
  return [...container.querySelectorAll('input[type="checkbox"]')]
    .filter((cb) => cb.checked)
    .map((cb) => cb.dataset.skill);
}

/**
 * Flip between agent and direct-model chat by clicking the embedded chat's
 * hidden mode buttons (chat.js's setMode handles the rest). OFF also grays
 * the panel body — you can't edit an agent you're not talking to.
 */
export function applyUseAgentToggle(wrapper, useAgent) {
  const btn = wrapper.querySelector(useAgent ? '#mode-agent' : '#mode-direct');
  if (btn) btn.click();
  const body = wrapper.querySelector('.simple-panel-body');
  if (body) body.classList.toggle('simple-disabled', !useAgent);
}
```

Then replace the `initPanel` stub with the real orchestration:

```js
function initPanel(wrapper, folder) {
  const nameInput = wrapper.querySelector('#simple-agent-name');
  const skillsHost = wrapper.querySelector('#simple-skills');
  const personaEl = wrapper.querySelector('#simple-persona');
  const saveBtn = wrapper.querySelector('#simple-save');
  const statusEl = wrapper.querySelector('#simple-save-status');
  const toggleEl = wrapper.querySelector('#simple-use-agent');

  let lastSavedName = '';

  toggleEl.addEventListener('change', () => applyUseAgentToggle(wrapper, toggleEl.checked));

  // Load config + persona in parallel; render the panel when both land.
  Promise.all([
    fetch(`/api/simple-config?folder=${encodeURIComponent(folder)}`, { credentials: 'same-origin' }).then((r) =>
      r.ok ? r.json() : null,
    ),
    fetch(`/api/drafts/${folder}/persona`, { credentials: 'same-origin' }).then((r) =>
      r.ok ? r.json() : { text: '' },
    ),
  ])
    .then(([config, persona]) => {
      if (!config) {
        statusEl.textContent = "Couldn't load your agent's setup — refresh to retry.";
        return;
      }
      lastSavedName = config.agentName || '';
      nameInput.value = lastSavedName;
      renderSkillRows(skillsHost, config.skills);
      personaEl.value = persona.text || '';
      initModelDropdown(wrapper, folder, config); // Task 7
    })
    .catch(() => {
      statusEl.textContent = "Couldn't load your agent's setup — refresh to retry.";
    });

  // Name saves on blur / Enter; the bubble label follows live.
  async function saveName() {
    const name = nameInput.value.trim();
    if (!name || name === lastSavedName) return;
    try {
      const r = await fetch(`/api/drafts/${folder}/name`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ name }),
      });
      if (r.ok) {
        lastSavedName = name;
        setBubbleLabels(wrapper, name, currentModelLabel(wrapper)); // Task 7
      } else {
        statusEl.textContent = "Couldn't save the name — try again.";
      }
    } catch {
      statusEl.textContent = "Couldn't save the name — try again.";
    }
  }
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') nameInput.blur();
  });
  nameInput.addEventListener('blur', saveName);

  // Save = skills + persona (+ name if dirty), then restart so the next
  // message respawns the container with the new setup.
  saveBtn.addEventListener('click', async () => {
    statusEl.textContent = 'Saving…';
    try {
      const skillsRes = await fetch(`/api/drafts/${folder}/skills`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ skills: checkedSkills(skillsHost) }),
      });
      const personaRes = await fetch(`/api/drafts/${folder}/persona`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ text: personaEl.value }),
      });
      await saveName();
      const restartRes = await fetch('/api/simple-restart', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ folder }),
      });
      if (!skillsRes.ok || !personaRes.ok || !restartRes.ok) throw new Error('save failed');
      statusEl.textContent = 'Saved! Your agent will use this from its next reply.';
    } catch {
      statusEl.textContent = "Couldn't save — try again.";
    }
  });
}
```

Also add temporary stubs at the bottom so this task builds standalone (Task 7 replaces them):

```js
// Replaced with real implementations in Task 7 (model dropdown + bubble labels).
function initModelDropdown(wrapper, folder, config) {}
export function setBubbleLabels(wrapper, agentName, modelLabel) {}
function currentModelLabel(wrapper) {
  return '';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/channels/playground/public/tabs/simple.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write src/channels/playground/public/tabs/simple.js src/channels/playground/public/tabs/simple.test.ts
git add src/channels/playground/public/tabs/simple.js src/channels/playground/public/tabs/simple.test.ts
git commit -m "feat(playground): simple tab side panel — skills checklist, persona, toggle, save"
```

---

### Task 7: Model dropdown + hidden-select sync + reply styling (TDD)

**Files:**

- Modify: `src/channels/playground/public/tabs/simple.js`
- Modify: `src/channels/playground/public/tabs/simple.test.ts` (append)
- Modify: `src/channels/playground/public/style.css` (append)

- [ ] **Step 1: Write the failing tests**

Append to `src/channels/playground/public/tabs/simple.test.ts`:

```ts
import { syncHiddenModelSelects, setBubbleLabels } from './simple.js';

describe('syncHiddenModelSelects', () => {
  function wrapperWithHiddenSelects() {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `<select id="provider-sel"></select><select id="model-sel"></select>`;
    return wrapper;
  }

  it('maps a catalog modelProvider to its PROVIDER_GROUP id and sets both selects', () => {
    const wrapper = wrapperWithHiddenSelects();
    syncHiddenModelSelects(wrapper, 'openai-codex', 'gpt-5.4-mini');
    expect((wrapper.querySelector('#provider-sel') as HTMLSelectElement).value).toBe('openai');
    expect((wrapper.querySelector('#model-sel') as HTMLSelectElement).value).toBe('gpt-5.4-mini');
  });

  it('appends missing options instead of silently failing (template wider than whitelist)', () => {
    const wrapper = wrapperWithHiddenSelects();
    const modelSel = wrapper.querySelector('#model-sel') as HTMLSelectElement;
    modelSel.add(new Option('other-model', 'other-model'));
    syncHiddenModelSelects(wrapper, 'anthropic', 'claude-haiku-4-5');
    expect(modelSel.value).toBe('claude-haiku-4-5');
    expect([...modelSel.options].map((o) => o.value)).toContain('other-model'); // existing options kept
  });

  it('passes unknown providers through as-is (clemson/local style ids)', () => {
    const wrapper = wrapperWithHiddenSelects();
    syncHiddenModelSelects(wrapper, 'clemson', 'some-model');
    expect((wrapper.querySelector('#provider-sel') as HTMLSelectElement).value).toBe('clemson');
  });
});

describe('setBubbleLabels', () => {
  it('writes both CSS custom properties on the wrapper', () => {
    const wrapper = document.createElement('div');
    setBubbleLabels(wrapper, 'JaneBot', 'gpt-5.4-mini');
    expect(wrapper.style.getPropertyValue('--agent-label')).toBe('"🤖 JaneBot — your agent"');
    expect(wrapper.style.getPropertyValue('--model-label')).toBe(
      '"⚡ gpt-5.4-mini — model only (no skills, no personality)"',
    );
  });

  it('escapes double quotes so a name cannot break out of the CSS string', () => {
    const wrapper = document.createElement('div');
    setBubbleLabels(wrapper, 'Jane"Bot', 'm"x');
    expect(wrapper.style.getPropertyValue('--agent-label')).toBe('"🤖 Jane\\"Bot — your agent"');
    expect(wrapper.style.getPropertyValue('--model-label')).toBe('"⚡ m\\"x — model only (no skills, no personality)"');
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm exec vitest run src/channels/playground/public/tabs/simple.test.ts`
Expected: FAIL — `syncHiddenModelSelects` not exported / `setBubbleLabels` stub sets nothing. Task 6 tests must still PASS.

- [ ] **Step 3: Implement — replace the Task 6 stubs**

In `src/channels/playground/public/tabs/simple.js`, **delete** the three Task 6 stubs (`initModelDropdown`, `setBubbleLabels`, `currentModelLabel`) and add:

```js
/**
 * Keep the embedded chat's hidden #provider-sel / #model-sel in step with
 * the simple dropdown so DIRECT mode (which reads the selects verbatim at
 * send time) uses the same model. Values are set silently — dispatching
 * 'change' on #provider-sel would trip chat.js's provider-switch modal and
 * a second active-model PUT. #provider-sel holds PROVIDER_GROUP ids, so map
 * the catalog modelProvider first; append missing <option>s because the
 * student's whitelist may be narrower than the template's choices.
 */
export function syncHiddenModelSelects(wrapper, provider, modelId) {
  const group = PROVIDER_GROUPS.find((g) => (g.memberModelProviders || []).includes(provider));
  const groupId = group ? group.id : provider;
  const provSel = wrapper.querySelector('#provider-sel');
  const modelSel = wrapper.querySelector('#model-sel');
  if (!provSel || !modelSel) return;
  if (![...provSel.options].some((o) => o.value === groupId)) {
    provSel.add(new Option(group ? group.displayName : provider, groupId));
  }
  provSel.value = groupId;
  if (![...modelSel.options].some((o) => o.value === modelId)) {
    modelSel.add(new Option(modelId, modelId));
  }
  modelSel.value = modelId;
}

/** Bubble headers via CSS vars — see the .simple-mode bubble rules in style.css. */
export function setBubbleLabels(wrapper, agentName, modelLabel) {
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  wrapper.style.setProperty('--agent-label', `"🤖 ${esc(agentName)} — your agent"`);
  wrapper.style.setProperty('--model-label', `"⚡ ${esc(modelLabel)} — model only (no skills, no personality)"`);
}

function currentModelLabel(wrapper) {
  const sel = wrapper.querySelector('#simple-model-sel');
  const opt = sel && sel.selectedOptions[0];
  return opt ? opt.textContent : '';
}

/**
 * Top-bar model dropdown — populated from the TEMPLATE's allowed_models
 * (config.models), preselected from the agent's active model. On change:
 * our own PUT active-model (server resolves + recycles the container) and
 * a silent hidden-select sync for direct mode.
 */
function initModelDropdown(wrapper, folder, config) {
  const sel = wrapper.querySelector('#simple-model-sel');
  sel.innerHTML = '';
  for (const m of config.models) {
    const opt = new Option(m.displayName, m.id);
    opt.dataset.provider = m.provider;
    sel.add(opt);
  }
  if (config.activeModel) {
    const match = [...sel.options].find(
      (o) => o.value === config.activeModel.id && o.dataset.provider === config.activeModel.provider,
    );
    if (match) sel.value = match.value;
  }

  const applySelection = () => {
    const opt = sel.selectedOptions[0];
    if (!opt) return;
    syncHiddenModelSelects(wrapper, opt.dataset.provider, opt.value);
    setBubbleLabels(wrapper, wrapper.querySelector('#simple-agent-name').value.trim() || 'Your agent', opt.textContent);
  };
  applySelection(); // initial labels + hidden-select state

  sel.addEventListener('change', async () => {
    const opt = sel.selectedOptions[0];
    if (!opt) return;
    applySelection();
    try {
      await fetch(`/api/drafts/${folder}/active-model`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ modelProvider: opt.dataset.provider, model: opt.value }),
      });
    } catch {
      /* next agent send will surface the failure */
    }
  });
}
```

(`initPanel` from Task 6 already calls `initModelDropdown(wrapper, folder, config)` and `setBubbleLabels`/`currentModelLabel` from `saveName` — no further wiring needed.)

- [ ] **Step 4: Add the bubble styling CSS**

Append to `src/channels/playground/public/style.css` (after the Task 5 block):

```css
/* Reply differentiation — agent replies are `.msg.agent` (chat.js:692),
   direct/model-only replies are `.bubble-direct` (chat.js:571). Labels come
   from CSS vars set by simple.js (setBubbleLabels). */
.simple-mode .msg.agent {
  background: #e8f5ec;
  border: 1px solid #bfe3c9;
  border-radius: 8px;
}
.simple-mode .msg.agent::before {
  content: var(--agent-label, '🤖 your agent');
  display: block;
  font-size: 11px;
  font-weight: 600;
  color: #2e7d46;
  margin-bottom: 2px;
}
.simple-mode .bubble-direct {
  background: #eef1f8;
  border: 1px dashed #aab4d4;
  border-radius: 8px;
}
.simple-mode .bubble-direct::before {
  content: var(--model-label, '⚡ model only');
  display: block;
  font-size: 11px;
  font-weight: 600;
  color: #4a5a96;
  margin-bottom: 2px;
}
```

- [ ] **Step 5: Run the full frontend test file**

Run: `pnpm exec vitest run src/channels/playground/public/tabs/simple.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
pnpm exec prettier --write src/channels/playground/public/tabs/simple.js src/channels/playground/public/tabs/simple.test.ts src/channels/playground/public/style.css
git add src/channels/playground/public/tabs/simple.js src/channels/playground/public/tabs/simple.test.ts src/channels/playground/public/style.css
git commit -m "feat(playground): simple tab model dropdown, hidden-select sync, labeled reply bubbles"
```

---

### Task 8: Full verification + deploy + live verify + state.md

**Files:**

- Modify: `state.md` (decision log)

- [ ] **Step 1: Build + full host suite + container typecheck untouched**

Run: `pnpm run build && pnpm test`
Expected: build clean, all tests pass. (No `container/agent-runner/` files were touched — no Bun typecheck needed.)

- [ ] **Step 2: state.md decision-log entry**

Append to the Decision log section of `state.md` (match the existing entry style):

```markdown
- **2026-06-11 — "My Agent" simple beginner tab.** New `simple` playground tab: embedded real chat (`mountChat` unchanged, `.simple-mode` CSS hides advanced chrome) + side panel (Use-agent toggle driving the hidden mode buttons, editable agent name, template-curated skill checklist with ⓘ descriptions, persona, Save→restart) + left model dropdown fed by the default-participant template's `allowed_models`. Three new endpoints: `GET /api/simple-config`, `PUT /api/drafts/:folder/name` (writes `assistant_name` + group name), `POST /api/simple-restart` (exported `killGroupContainer`). Agent replies green/labeled, model-only replies blue-gray/dashed via CSS vars. Tab strip auto-hides when a student has exactly one visible tab. Instructor curates via the template slot + `tabsVisibleToStudents`. Spec: docs/superpowers/specs/2026-06-11-simple-my-agent-tab-design.md.
```

- [ ] **Step 3: Commit (state.md volatile section auto-refreshes via pre-commit)**

```bash
git add state.md
git commit -m "docs(state): decision-log entry for the My Agent simple tab"
```

- [ ] **Step 4: Deploy**

The two new endpoints are host-side → restart the service; the tab JS/CSS are static → browser refresh.

```bash
pnpm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-581fefa4
```

(Service label per memory: `com.nanoclaw-v2-581fefa4`, NOT the generic `com.nanoclaw`.)

- [ ] **Step 5: Live verify (manual, in the browser)**

Owner seat first, then a participant seat:

1. Open the playground → **My Agent** tab appears. Chat works (send a message in agent mode → green bubble with "🤖 \<name\> — your agent").
2. Flip **Use agent** OFF → panel grays, send a message → blue-gray dashed bubble with "⚡ \<model\> — model only…"; attaching a file in OFF mode produces the existing "Attachments are not yet wired in direct mode" note.
3. Skills checklist shows the template's shortlist with current checked state; ⓘ expands descriptions one at a time.
4. Edit the agent name → blur → next agent reply label uses the new name; `ncl groups list` (via `./bin/ncl`) shows the renamed group.
5. Edit persona + toggle a skill → **Save my agent** → "Saved!" status; send a message → container respawns (check `logs/nanoclaw.log` for the kill + respawn) and behavior reflects the new skills/persona.
6. Model dropdown lists the template's `allowed_models`; changing it changes both agent replies and direct replies (label updates).
7. As the instructor: set a participant's `tabsVisibleToStudents` to `["simple"]` → that student sees a single page with **no tab strip**.

- [ ] **Step 6: Done check against the spec**

Re-read `docs/superpowers/specs/2026-06-11-simple-my-agent-tab-design.md` § Testing — every line there must be covered by a passing test or the live-verify steps above.

---

## Self-Review (completed at plan-writing time)

1. **Spec coverage** — Component 1 (simple.js: Tasks 5–7), Component 2 (simple-config: Tasks 2, 4), Component 3 (name + restart: Tasks 1, 3, 4), tab-strip auto-hide (Task 5), reply differentiation (Task 7), instructor story (no code — existing surfaces), testing section (Tasks 2–3, 6–7 unit; Task 8 manual). ✔
2. **Placeholder scan** — the only intentional stubs are the three Task 6 placeholders explicitly replaced in Task 7 Step 3 (named, tracked, deleted). ✔
3. **Type consistency** — `handleGetSimpleConfig(folder)` / `handlePutAgentName(folder, body)` / `handleSimpleRestart(folder)` match Task 4's route calls; `renderSkillRows`/`checkedSkills`/`applyUseAgentToggle`/`syncHiddenModelSelects`/`setBubbleLabels` names match between Tasks 6–7 implementations and tests; `killGroupContainer(folder, reason)` matches Task 3's mock assertion. ✔
