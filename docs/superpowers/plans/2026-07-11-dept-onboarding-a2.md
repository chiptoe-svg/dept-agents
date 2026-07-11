# A2 — Member Onboarding / Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give department members a first-run **Home** setup dashboard (OAuth hero to connect their ChatGPT, a Telegram card, a disabled Google placeholder, a model-status chip, and Go-to-Chat), expand the member tab set to `['home','simple','persona','skills']` landing on Home, and make a newly-provisioned member's default model the free Clemson `qwen3.6-35b-a3b` so the agent works before any login.

**Architecture:** Pure frontend assembly of connect flows that already exist (Plan 4 `cred-dialog` + `/provider-auth/codex/*`; `class-telegram-pair` `/api/me/telegram*`). A new member-only dashboard component (`tabs/member-home.js`) plus a tiny extracted `tab-gating.js` for testable role→tabs logic. One server-side line changes the provisioning default model. No new endpoints, no new credential handling.

**Tech Stack:** Vanilla ES modules (browser, no framework), vitest + `happy-dom` for frontend tests, Node/pnpm host, TypeScript for `src/*.ts`.

**Spec:** `docs/superpowers/specs/2026-07-11-dept-onboarding-setup-design.md`.

## Global Constraints

- **Reuse, don't rebuild** the connect flows: `openCredDialog` (from `../components/cred-dialog.js`), `GET /provider-auth/codex/status`, `GET /api/me/providers`, `GET /api/me/telegram`, `POST /api/me/telegram/pair-code`. No new credential storage or OAuth code.
- **Exact response shapes** (verbatim): `GET /provider-auth/codex/status` → `{ hasApiKey: boolean, hasOAuth: boolean, active: 'apiKey'|'oauth'|null }` (connected ⇔ `active !== null`). `GET /api/me/telegram` → `{ paired: boolean, botUsername: string, telegramHandle?: string }`. `POST /api/me/telegram/pair-code` → `{ code: string, expiresAt: number }`.
- **Member-facing copy uses department vocabulary** — "campus model", "your ChatGPT", never "class"/"student"/"instructor"/"ask instructor".
- **Nothing gates.** No dashboard state blocks chat; the Clemson default keeps the agent alive.
- **Frontend tests:** first line `// @vitest-environment happy-dom`; import functions from the `.js` module; build DOM with `document.createElement`; mock `fetch`/`globalThis.fetch` with `vi`. Never import `app.js` in a test (it runs `init()` at module load) — test the extracted `tab-gating.js` instead.
- **MEMBER_TABS** is exactly `['home', 'simple', 'persona', 'skills']`; members land on `home`.
- **Clemson default model** is `qwen3.6-35b-a3b` with `model_provider: 'clemson'` (from `src/providers/clemson-spec.ts`).
- Host build/test: `pnpm run build` clean and `pnpm test` green before a task is done (run them yourself). Clean any stray `groups/` fixture dirs your run creates (leave `_default_participant`, `owner_01`, `user_01`).
- Commit messages end (after a blank line) with:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01WXUAU8TQduy8SMSVWoNYvn
  ```

---

## File Structure

- **Create `src/channels/playground/public/tabs/member-home.js`** — the member Home dashboard. Exports `renderDashboard(host, state)` (pure) and `mountMemberHome(el)` (fetches + wires). Sole responsibility: compose existing connect flows into the member landing.
- **Create `src/channels/playground/public/tabs/member-home.test.ts`** — happy-dom unit tests for the pure render + the telegram pair sub-render.
- **Create `src/channels/playground/public/tab-gating.js`** — `TABS`, `MEMBER_TABS`, `hasFullAccess(role)`, `tabsForRole(role)`. Extracted so the gating is unit-testable without importing `app.js`.
- **Create `src/channels/playground/public/tab-gating.test.ts`** — tests for the gating helpers.
- **Modify `src/channels/playground/public/app.js`** — import from `tab-gating.js`; route the `home` tab to `mountMemberHome` for non-full-access users; land members on `home`; relabel the `simple` tab button to "Chat" for members.
- **Modify `src/provisioning/provision-user.ts:~118`** — set the provisioned default model to Clemson `qwen3.6-35b-a3b`.
- **Modify `src/provisioning/provision-user.test.ts`** — assert the new default model/provider.

---

### Task 1: Member Home dashboard component

**Files:**
- Create: `src/channels/playground/public/tabs/member-home.js`
- Test: `src/channels/playground/public/tabs/member-home.test.ts`

**Interfaces:**
- Consumes: `openCredDialog({ providerId, providerSpec, currentCredState, onSaved })` from `../components/cred-dialog.js`.
- Produces:
  - `renderDashboard(host: HTMLElement, state: DashboardState): void` — pure; clears `host` and builds the dashboard DOM.
  - `renderTelegramPair(host: HTMLElement, { code, botUsername }): void` — pure; renders the pair-code instruction block.
  - `mountMemberHome(el: HTMLElement): void` — fetches state, calls `renderDashboard`, wires actions.
  - `DashboardState = { displayName: string, chatgptConnected: boolean, telegram: { paired: boolean, botUsername: string, label?: string }, onConnectChatgpt: () => void, onConnectTelegram: () => void, onGoToChat: () => void }`

- [ ] **Step 1: Write the failing tests**

Create `src/channels/playground/public/tabs/member-home.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { renderDashboard, renderTelegramPair } from './member-home.js';

function baseState(over = {}) {
  return {
    displayName: 'Dr. Smith',
    chatgptConnected: false,
    telegram: { paired: false, botUsername: 'CUInstructorBot' },
    onConnectChatgpt: vi.fn(),
    onConnectTelegram: vi.fn(),
    onGoToChat: vi.fn(),
    ...over,
  };
}

describe('renderDashboard', () => {
  it('greets the member by display name', () => {
    const host = document.createElement('div');
    renderDashboard(host, baseState());
    expect(host.textContent).toContain('Welcome, Dr. Smith');
  });

  it('when ChatGPT is NOT connected: hero is prominent and chip shows the campus model', () => {
    const host = document.createElement('div');
    renderDashboard(host, baseState({ chatgptConnected: false }));
    const hero = host.querySelector('[data-hero]');
    expect(hero).toBeTruthy();
    expect(hero.dataset.hero).toBe('prominent');
    const btn = host.querySelector('[data-action="connect-chatgpt"]');
    expect(btn).toBeTruthy();
    expect(host.textContent).toContain('Connect your ChatGPT');
    // Reassurance + chip
    expect(host.textContent).toContain('free Clemson campus model');
    expect(host.querySelector('[data-model-chip]').textContent).toContain('Clemson campus model (free)');
    // Dept vocabulary only
    expect(host.textContent).not.toMatch(/instructor|student|class\b/i);
  });

  it('when ChatGPT IS connected: hero collapses and chip shows Your ChatGPT', () => {
    const host = document.createElement('div');
    renderDashboard(host, baseState({ chatgptConnected: true }));
    expect(host.querySelector('[data-hero]').dataset.hero).toBe('collapsed');
    expect(host.textContent).toContain('ChatGPT connected');
    expect(host.querySelector('[data-model-chip]').textContent).toContain('Your ChatGPT');
  });

  it('clicking the connect button invokes onConnectChatgpt', () => {
    const host = document.createElement('div');
    const st = baseState();
    renderDashboard(host, st);
    host.querySelector('[data-action="connect-chatgpt"]').click();
    expect(st.onConnectChatgpt).toHaveBeenCalledOnce();
  });

  it('telegram not paired: shows a Connect button wired to onConnectTelegram', () => {
    const host = document.createElement('div');
    const st = baseState({ telegram: { paired: false, botUsername: 'CUInstructorBot' } });
    renderDashboard(host, st);
    const t = host.querySelector('[data-action="connect-telegram"]');
    expect(t).toBeTruthy();
    t.click();
    expect(st.onConnectTelegram).toHaveBeenCalledOnce();
  });

  it('telegram paired: shows linked status, no connect button', () => {
    const host = document.createElement('div');
    renderDashboard(host, baseState({ telegram: { paired: true, botUsername: 'CUInstructorBot', label: '@drsmith' } }));
    expect(host.textContent).toContain('Telegram');
    expect(host.textContent.toLowerCase()).toContain('linked');
    expect(host.querySelector('[data-action="connect-telegram"]')).toBeNull();
  });

  it('Google card is present but disabled and non-interactive', () => {
    const host = document.createElement('div');
    renderDashboard(host, baseState());
    const g = host.querySelector('[data-card="google"] button');
    expect(g).toBeTruthy();
    expect(g.disabled).toBe(true);
    expect(host.querySelector('[data-card="google"]').textContent).toContain('Available soon');
  });

  it('Go to Chat button invokes onGoToChat', () => {
    const host = document.createElement('div');
    const st = baseState();
    renderDashboard(host, st);
    host.querySelector('[data-action="go-to-chat"]').click();
    expect(st.onGoToChat).toHaveBeenCalledOnce();
  });
});

describe('renderTelegramPair', () => {
  it('renders the code and the bot username instruction', () => {
    const host = document.createElement('div');
    renderTelegramPair(host, { code: 'ABC123XYZ0', botUsername: 'CUInstructorBot' });
    expect(host.textContent).toContain('ABC123XYZ0');
    expect(host.textContent).toContain('CUInstructorBot');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/channels/playground/public/tabs/member-home.test.ts`
Expected: FAIL — `Cannot find module './member-home.js'`.

- [ ] **Step 3: Implement `member-home.js`**

Create `src/channels/playground/public/tabs/member-home.js`:

```js
/**
 * Member Home — the department member's landing/setup dashboard.
 *
 * Composes connect flows that already exist (Plan 4 cred-dialog + codex
 * OAuth; class-telegram-pair). Steers the member to connect their own
 * ChatGPT; the free Clemson campus model keeps the agent working meanwhile,
 * so nothing here gates. Google is a disabled "Available soon" placeholder
 * until the one-time GCP step lands.
 */
import { openCredDialog } from '../components/cred-dialog.js';

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('data') || k === 'disabled') node.setAttribute(k, v === true ? '' : v);
    else node[k] = v;
  }
  for (const c of children) node.append(c);
  return node;
}

/** Pure: build the member dashboard into `host` from `state`. */
export function renderDashboard(host, state) {
  host.replaceChildren();
  const { displayName, chatgptConnected, telegram } = state;

  host.append(el('h2', { class: 'pg-greeting', text: `Welcome, ${displayName}` }));

  // Hero — connect ChatGPT (prominent) or collapsed status.
  const hero = el('section', { class: 'pg-hero', 'data-hero': chatgptConnected ? 'collapsed' : 'prominent' });
  if (chatgptConnected) {
    hero.append(el('span', { text: '✓ ChatGPT connected — usage on your account. ' }));
    hero.append(el('button', { 'data-action': 'connect-chatgpt', text: 'Manage', onclick: state.onConnectChatgpt }));
  } else {
    hero.append(el('h3', { text: 'Connect your ChatGPT' }));
    hero.append(el('p', { text: 'Put your AI usage on your own account.' }));
    hero.append(el('button', { class: 'pg-primary', 'data-action': 'connect-chatgpt', text: 'Connect your ChatGPT', onclick: state.onConnectChatgpt }));
  }
  host.append(hero);

  host.append(el('p', { class: 'pg-reassure', text: 'Your agent already works on the free Clemson campus model — connecting is optional but recommended.' }));

  const chip = el('div', { class: 'pg-model-chip', 'data-model-chip': '' });
  chip.append(el('span', { text: 'Running on: ' }));
  chip.append(el('b', { text: chatgptConnected ? 'Your ChatGPT' : 'Clemson campus model (free)' }));
  host.append(chip);

  // Secondary: Telegram + Google.
  const more = el('section', { class: 'pg-connections' });
  more.append(el('h4', { text: 'More connections' }));

  const tgCard = el('div', { class: 'pg-card', 'data-card': 'telegram' });
  tgCard.append(el('span', { text: 'Telegram' }));
  if (telegram.paired) {
    tgCard.append(el('span', { text: ` — ✓ Linked${telegram.label ? ' as ' + telegram.label : ''}` }));
  } else {
    tgCard.append(el('button', { 'data-action': 'connect-telegram', text: 'Connect', onclick: state.onConnectTelegram }));
  }
  more.append(tgCard);

  const gCard = el('div', { class: 'pg-card', 'data-card': 'google' });
  gCard.append(el('span', { text: 'Google Docs/Sheets — Available soon' }));
  gCard.append(el('button', { disabled: true, text: 'Connect' }));
  more.append(gCard);

  host.append(more);

  host.append(el('button', { class: 'pg-goto-chat', 'data-action': 'go-to-chat', text: 'Go to Chat →', onclick: state.onGoToChat }));
}

/** Pure: render the Telegram pair-code instruction block into `host`. */
export function renderTelegramPair(host, { code, botUsername }) {
  host.replaceChildren();
  host.append(el('p', { text: `Message @${botUsername} on Telegram with this code:` }));
  host.append(el('code', { class: 'pg-pair-code', text: code }));
  host.append(el('p', { class: 'pg-pair-hint', text: 'This code expires in ~15 minutes. This panel updates once you are linked.' }));
}

async function getJson(url, fallback) {
  try {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (!r.ok) return fallback;
    return await r.json();
  } catch {
    return fallback;
  }
}

/** Tab mount entry: fetch state, render, wire actions. */
export async function mountMemberHome(el0) {
  const user = (window.__pg && window.__pg.user) || {};
  const displayName = user.email || user.id || 'there';

  const [codex, tg, providers] = await Promise.all([
    getJson('/provider-auth/codex/status', { active: null }),
    getJson('/api/me/telegram', { paired: false, botUsername: '' }),
    getJson('/api/me/providers', { providers: [] }),
  ]);
  const codexSpec = (providers.providers || []).find((p) => p.id === 'codex') || { id: 'codex', displayName: 'ChatGPT', credentialFileShape: 'oauth-token' };

  const state = {
    displayName,
    chatgptConnected: codex.active !== null,
    telegram: { paired: !!tg.paired, botUsername: tg.botUsername || '', label: tg.telegramHandle ? '@' + tg.telegramHandle : undefined },
    onConnectChatgpt: () =>
      openCredDialog({
        providerId: 'codex',
        providerSpec: codexSpec,
        currentCredState: { hasApiKey: !!codex.hasApiKey, hasOAuth: !!codex.hasOAuth, active: codex.active },
        onSaved: () => mountMemberHome(el0),
      }),
    onConnectTelegram: async () => {
      const panel = document.createElement('div');
      el0.append(panel);
      // POST mints a fresh single-use code (GET only reports status).
      const minted = await fetch('/api/me/telegram/pair-code', {
        method: 'POST',
        credentials: 'same-origin',
      }).then((x) => x.json());
      renderTelegramPair(panel, { code: minted.code, botUsername: state.telegram.botUsername });
      // Poll until the member DMs the code to the bot and gets linked.
      const poll = setInterval(async () => {
        const s = await getJson('/api/me/telegram', { paired: false });
        if (s.paired) {
          clearInterval(poll);
          mountMemberHome(el0);
        }
      }, 4000);
    },
    onGoToChat: () => document.querySelector('[data-tab="simple"]')?.click(),
  };
  renderDashboard(el0, state);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/channels/playground/public/tabs/member-home.test.ts`
Expected: PASS (all render + pair tests).

- [ ] **Step 5: Build**

Run: `pnpm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/channels/playground/public/tabs/member-home.js src/channels/playground/public/tabs/member-home.test.ts
git commit -m "feat(playground): member Home setup dashboard (connect ChatGPT/Telegram, campus-model default)"
```

---

### Task 2: Tab gating + wire member Home into the app

**Files:**
- Create: `src/channels/playground/public/tab-gating.js`
- Create: `src/channels/playground/public/tab-gating.test.ts`
- Modify: `src/channels/playground/public/app.js:14-18` (TABS/mounters/MEMBER_TABS), `:37`, `:39-55` (`applyTabGating`), `:98` (landing)

**Interfaces:**
- Consumes: `mountMemberHome` from `./tabs/member-home.js` (Task 1).
- Produces (in `tab-gating.js`):
  - `export const TABS: string[]` — the full ordered tab list (unchanged from app.js).
  - `export const MEMBER_TABS = ['home', 'simple', 'persona', 'skills']`
  - `export function hasFullAccess(role: string): boolean` — `role === 'owner' || role === 'ta'`.
  - `export function tabsForRole(role: string): string[]` — `hasFullAccess(role) ? TABS : MEMBER_TABS`.

- [ ] **Step 1: Write the failing tests**

Create `src/channels/playground/public/tab-gating.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { TABS, MEMBER_TABS, hasFullAccess, tabsForRole } from './tab-gating.js';

describe('tab gating', () => {
  it('members get exactly home, simple, persona, skills and land on home', () => {
    expect(MEMBER_TABS).toEqual(['home', 'simple', 'persona', 'skills']);
    expect(tabsForRole('member')).toEqual(MEMBER_TABS);
    expect(tabsForRole('member')[0]).toBe('home');
  });

  it('owners and TAs get the full tab set', () => {
    expect(tabsForRole('owner')).toEqual(TABS);
    expect(tabsForRole('ta')).toEqual(TABS);
    expect(hasFullAccess('owner')).toBe(true);
    expect(hasFullAccess('ta')).toBe(true);
    expect(hasFullAccess('member')).toBe(false);
  });

  it('the full tab set still contains every member tab', () => {
    for (const t of MEMBER_TABS) expect(TABS).toContain(t);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/channels/playground/public/tab-gating.test.ts`
Expected: FAIL — `Cannot find module './tab-gating.js'`.

- [ ] **Step 3: Create `tab-gating.js`**

```js
/** Tab list + role gating for the playground. Extracted from app.js so the
 *  gating is unit-testable without importing app.js (which runs init() on
 *  load). Department server: owners/TAs see everything; members get the
 *  Home/Chat/Persona/Skills set. */
export const TABS = ['home', 'simple', 'chat', 'persona', 'skills', 'models', 'agents', 'sources', 'retrieval', 'benchmarks', 'status'];

export const MEMBER_TABS = ['home', 'simple', 'persona', 'skills'];

export function hasFullAccess(role) {
  return role === 'owner' || role === 'ta';
}

export function tabsForRole(role) {
  return hasFullAccess(role) ? TABS : MEMBER_TABS;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/channels/playground/public/tab-gating.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `app.js`**

Edit `src/channels/playground/public/app.js`:

1. Add imports near the top (after the existing tab imports):
   ```js
   import { mountMemberHome } from './tabs/member-home.js';
   import { TABS, MEMBER_TABS, hasFullAccess, tabsForRole } from './tab-gating.js';
   ```
2. **Delete** the local `const TABS = [...]` (line 14) and the local `const MEMBER_TABS = ['simple'];` (line 37) — they now come from `tab-gating.js`.
3. Change the `mounters.home` entry so members get the member dashboard while owners/TAs keep the owner home:
   ```js
   const mounters = {
     home: (tabEl) => (hasFullAccess(window.__pg?.user?.role) ? mountHome(tabEl) : mountMemberHome(tabEl)),
     simple: mountSimple, chat: mountChat, persona: mountPersona, skills: mountSkills,
     models: mountModels, agents: mountAgents, sources: mountSources,
     retrieval: mountRetrieval, benchmarks: mountBenchmarks, status: mountStatus,
   };
   ```
4. Replace the body of `applyTabGating` so it uses `tabsForRole`, and relabel the `simple` tab button to "Chat" for members:
   ```js
   function applyTabGating(user) {
     allowedTabs = tabsForRole(user.role);
     for (const t of TABS) {
       const btn = document.querySelector(`[data-tab="${t}"]`);
       if (btn) btn.hidden = !allowedTabs.includes(t);
     }
     // Members see the chat surface labeled "Chat" rather than "My Agent".
     if (!hasFullAccess(user.role)) {
       const chatBtn = document.querySelector('[data-tab="simple"]');
       if (chatBtn) chatBtn.textContent = 'Chat';
     }
     const activeBtn = document.querySelector('[data-tab].active');
     const currentTab = activeBtn?.dataset?.tab;
     if (currentTab && !allowedTabs.includes(currentTab)) {
       showTab(allowedTabs[0] || 'home');
     }
     const tabBar = document.getElementById('tab-bar');
     if (tabBar) tabBar.hidden = allowedTabs.length === 1;
   }
   ```
   (Members now have 4 tabs, so the tab bar is visible — the `length === 1` hide no longer triggers for them, which is correct.)
5. The landing line at the end of `init()` is already `showTab(allowedTabs.includes('home') ? 'home' : allowedTabs[0] || 'home')` — leave it; members' `allowedTabs` includes `home`, so they land on Home.

- [ ] **Step 6: Full build + test**

Run: `pnpm run build && pnpm test`
Expected: tsc clean; full suite green (includes both new test files).

- [ ] **Step 7: Commit**

```bash
git add src/channels/playground/public/tab-gating.js src/channels/playground/public/tab-gating.test.ts src/channels/playground/public/app.js
git commit -m "feat(playground): members get Home/Chat/Persona/Skills tabs, land on Home"
```

---

### Task 3: Provisioned default model = Clemson `qwen3.6-35b-a3b`

**Files:**
- Modify: `src/provisioning/provision-user.ts:~118`
- Modify: `src/provisioning/provision-user.test.ts`

**Interfaces:**
- Consumes: `updateContainerConfigScalars(agentGroupId, scalars)` (already imported in `provision-user.ts`); the `container_configs` columns `model` and `model_provider` (`src/db/container-configs.ts`).

- [ ] **Step 1: Add the failing assertion to the provisioning test**

In `src/provisioning/provision-user.test.ts`, alongside the existing `provider === 'pi'` assertion (around line 44-46), add a check on the default model. Extend the existing `SELECT` to also read `model` and `model_provider`:

```ts
const cfg = db
  .prepare('SELECT provider, model, model_provider FROM container_configs WHERE agent_group_id=?')
  .get(r.agentGroupId) as { provider: string; model: string; model_provider: string };
expect(cfg.provider).toBe('pi');
expect(cfg.model).toBe('qwen3.6-35b-a3b');
expect(cfg.model_provider).toBe('clemson');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/provisioning/provision-user.test.ts`
Expected: FAIL — `model` / `model_provider` are null (only `provider` is set today).

- [ ] **Step 3: Set the default model on provision**

In `src/provisioning/provision-user.ts`, change the existing scalars call (line ~118) from:

```ts
    updateContainerConfigScalars(agentGroupId, { provider: 'pi' });
```

to:

```ts
    // Free, on-campus default so a newly-provisioned member's agent works
    // before they connect their own ChatGPT. Deep model selection is A1;
    // qwen3.6-35b-a3b is the Clemson catalog's agentic pick.
    updateContainerConfigScalars(agentGroupId, {
      provider: 'pi',
      model: 'qwen3.6-35b-a3b',
      model_provider: 'clemson',
    });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run src/provisioning/provision-user.test.ts`
Expected: PASS.

- [ ] **Step 5: Full build + test**

Run: `pnpm run build && pnpm test`
Expected: tsc clean; full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/provisioning/provision-user.ts src/provisioning/provision-user.test.ts
git commit -m "feat(provisioning): default new members to the free Clemson campus model"
```

---

### Task 4: Live verification

**This task has no unit tests — it verifies the running host.** Service label: `com.nanoclaw-v2-581fefa4`.

- [ ] **Step 1: Rebuild + restart**

```bash
pnpm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-581fefa4
```

- [ ] **Step 2: Verify a member lands on the Home dashboard**

Provision a throwaway member and redeem their token into a cookie jar (mirror the pattern used in prior live checks — `./bin/ncl users provision --display-name "A2 Canary" --email a2canary@clemson.edu`, then redeem the printed URL against `http://127.0.0.1:3002/?token=…` with `curl -c jar -L`). Then:
- `GET http://127.0.0.1:3002/api/me/agent` with the jar → confirm role `member` and their own folder.
- Load `http://127.0.0.1:3002/` with the jar in a real browser session OR assert the served `app.js`/`tab-gating.js` expose `MEMBER_TABS = ['home','simple','persona','skills']`. Confirm the member's landing renders the Home dashboard (greeting + "Connect your ChatGPT" hero + "Clemson campus model (free)" chip + Telegram Connect + Google "Available soon" disabled).

- [ ] **Step 3: Verify the connect entry points resolve for the member**

With the member jar:
- `GET /provider-auth/codex/status` → 200 `{hasApiKey:false,hasOAuth:false,active:null}` (drives the prominent hero).
- `GET /api/me/telegram` → 200 `{paired:false,botUsername:...}`.
- `POST /api/me/telegram/pair-code` → 200 `{code,expiresAt}` (the Connect flow works).

- [ ] **Step 4: Verify the provisioned default model**

`pnpm exec tsx scripts/q.ts data/v2.db "SELECT model, model_provider FROM container_configs WHERE agent_group_id=(SELECT agent_group_id FROM agent_group_members WHERE user_id='playground:a2_canary' LIMIT 1);"` → `qwen3.6-35b-a3b|clemson`.

- [ ] **Step 5: Confirm a turn works on the campus default (pre-OAuth)**

Post a message as the canary (`POST /api/drafts/<canary-folder>/messages`, session jar) and confirm a reply is produced — its `provider` should be `clemson` (the free default), proving the agent works before any ChatGPT connection.

- [ ] **Step 6: Tear down the canary**

Revoke the canary token and remove the throwaway identity (mirror the Plan-3 canary cleanup). Record results in `docs/superpowers/reviews/2026-07-11-a2-onboarding-verification.md`.

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/reviews/2026-07-11-a2-onboarding-verification.md
git commit -m "docs(review): live verification — A2 member onboarding"
```

---

## Self-Review

**1. Spec coverage:**
- Member Home dashboard (hero, reassurance, chip, Telegram, Google placeholder, Go-to-Chat) → Task 1.
- `MEMBER_TABS = ['home','simple','persona','skills']` landing on Home; persona/skills reused as-is (no code change — they already read `window.__pg.agent.folder`) → Task 2. (Persona/skills need only to be in the member tab list; they are, and their DOM already exists in index.html since they're in `TABS`.)
- Clemson default model on provision → Task 3.
- Live proof incl. pre-OAuth turn on the campus model → Task 4.
- Google disabled placeholder, dept vocabulary, no-gate → asserted in Task 1 tests.

**2. Placeholder scan:** No TBD/TODO; every code step is complete transcribable code (the `onConnectTelegram` mint/poll flow is spelled out in full).

**3. Type consistency:** `DashboardState` fields (`displayName`, `chatgptConnected`, `telegram.{paired,botUsername,label}`, the three `on*` handlers) match between `renderDashboard`, its tests, and `mountMemberHome`. `tabsForRole`/`hasFullAccess`/`MEMBER_TABS` names match between `tab-gating.js`, its tests, and the `app.js` wiring. Response shapes (`codex.active`, `tg.paired`, `minted.code`) match the verified endpoint contracts in Global Constraints.

**Out of scope (unchanged from spec):** A3 file-centric chat, A1 benchmark/local/DGX model selection, live Google OAuth, `class_*`/`student-*` identifier renames.
