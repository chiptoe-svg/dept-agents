# Member Setup Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the member top nav from four tabs to two — **Setup** (the renamed Home dashboard) and **MyAgent** (the renamed Chat) — and move **Persona** and **Skills** off the top bar into an "Advanced" section inside the Setup dashboard that opens the existing full editors.

**Architecture:** Split "nav-visible" tabs from "reachable" tabs: members' top bar shows only `home` (labeled "Setup") + `chat` (labeled "MyAgent"), while `persona`/`skills` stay reachable via `showTab` (so the Advanced buttons open them). Tab **ids** (`home`/`chat`/`persona`/`skills`) are unchanged — only member labels + which buttons appear. Owners/TAs are untouched.

**Tech Stack:** Vanilla ES-module playground frontend, vitest + `happy-dom` for tests.

## Global Constraints

- **Tab ids do NOT change** — `home`, `chat`, `persona`, `skills` stay as ids; owners still use `home.js`/`chat.js` on `home`/`chat`. This is a member-label + member-nav change only.
- **Member reachable set unchanged:** `MEMBER_TABS = ['home','chat','persona','skills']` (what `showTab` permits). **Member nav set:** `MEMBER_NAV_TABS = ['home','chat']` (buttons shown in the top bar). Persona/Skills are reachable but not in the nav.
- **Member labels:** the `home` tab button reads **"Setup"**, the `chat` tab button reads **"MyAgent"** (for members only; owner labels unchanged). The vestigial `simple`→"Chat" relabel is removed.
- **Advanced = entry points (option a):** the Setup dashboard's Advanced section has "Edit persona" / "Edit skills" buttons that open the *existing* persona/skills tab editors (by clicking their hidden nav buttons); the editors themselves (`persona.js`/`skills.js`) are NOT modified.
- **Owner/TA experience unchanged.**
- Frontend tests: `// @vitest-environment happy-dom`; never import `app.js` in a test (it runs `init()` on load) — test `tab-gating.js` + the `member-home.js` render helpers.
- Member-facing copy is department vocabulary (no class/student/instructor).
- `pnpm run build` clean and `pnpm test` green before a task is done. Clean stray `groups/` fixture dirs (leave `_default_participant`, `owner_01`).
- Commit messages end (after a blank line) with:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01WXUAU8TQduy8SMSVWoNYvn
  ```

---

## File Structure

- **Modify `src/channels/playground/public/tab-gating.js`** — add `MEMBER_NAV_TABS` + `navTabsForRole(role)`; keep `MEMBER_TABS` (reachable) as-is.
- **Modify `src/channels/playground/public/tab-gating.test.ts`** — cover the nav vs reachable split.
- **Modify `src/channels/playground/public/app.js`** — nav-button visibility uses `navTabsForRole` (not `allowedTabs`); relabel `home`→"Setup" and `chat`→"MyAgent" for members; drop the `simple`→"Chat" relabel.
- **Modify `src/channels/playground/public/tabs/member-home.js`** — add an "Advanced" `<details>` with "Edit persona"/"Edit skills" buttons wired to open the persona/skills tabs; relabel "Go to Chat →" → "Go to MyAgent →".
- **Modify `src/channels/playground/public/tabs/member-home.test.ts`** — cover the Advanced section + relabel.

---

### Task 1: Nav-vs-reachable split + member relabels

**Files:**
- Modify: `src/channels/playground/public/tab-gating.js`, `src/channels/playground/public/tab-gating.test.ts`, `src/channels/playground/public/app.js`

**Interfaces:**
- Produces (in `tab-gating.js`): `export const MEMBER_NAV_TABS = ['home', 'chat']`; `export function navTabsForRole(role: string): string[]` — `hasFullAccess(role) ? TABS : MEMBER_NAV_TABS`. `MEMBER_TABS`/`tabsForRole` (reachable) unchanged.

- [ ] **Step 1: Write the failing tab-gating tests**

Add to `src/channels/playground/public/tab-gating.test.ts`:

```ts
import { MEMBER_NAV_TABS, navTabsForRole } from './tab-gating.js';

describe('nav vs reachable split', () => {
  it('members reach persona/skills but the top nav shows only Setup(home) + MyAgent(chat)', () => {
    expect(MEMBER_TABS).toEqual(['home', 'chat', 'persona', 'skills']); // reachable (showTab)
    expect(MEMBER_NAV_TABS).toEqual(['home', 'chat']);                   // nav bar
    expect(navTabsForRole('member')).toEqual(['home', 'chat']);
    // persona/skills are reachable but NOT in the nav
    expect(tabsForRole('member')).toContain('persona');
    expect(navTabsForRole('member')).not.toContain('persona');
    expect(navTabsForRole('member')).not.toContain('skills');
  });
  it('owners/TAs see the full nav', () => {
    expect(navTabsForRole('owner')).toEqual(TABS);
    expect(navTabsForRole('ta')).toEqual(TABS);
  });
});
```

(Ensure `TABS`, `MEMBER_TABS`, `tabsForRole` are imported in the existing test header.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/channels/playground/public/tab-gating.test.ts`
Expected: FAIL — `MEMBER_NAV_TABS`/`navTabsForRole` are not exported.

- [ ] **Step 3: Add the nav set to `tab-gating.js`**

Append to `src/channels/playground/public/tab-gating.js` (after `MEMBER_TABS`):

```js
// The tabs shown in the member's top nav bar. Persona/Skills stay in
// MEMBER_TABS (reachable via showTab, opened from the Setup > Advanced
// section) but are NOT top-level nav buttons.
export const MEMBER_NAV_TABS = ['home', 'chat'];

export function navTabsForRole(role) {
  return hasFullAccess(role) ? TABS : MEMBER_NAV_TABS;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/channels/playground/public/tab-gating.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire nav visibility + relabels in `app.js`**

In `src/channels/playground/public/app.js`:

1. Extend the import: add `MEMBER_NAV_TABS, navTabsForRole` to the existing `from './tab-gating.js'` line.
2. In `applyTabGating(user)`, replace the button-visibility loop and the member relabel block. Change:
   ```js
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
   ```
   to:
   ```js
   allowedTabs = tabsForRole(user.role);         // reachable via showTab (incl. persona/skills for members)
   const navTabs = navTabsForRole(user.role);    // shown in the top nav bar
   for (const t of TABS) {
     const btn = document.querySelector(`[data-tab="${t}"]`);
     if (btn) btn.hidden = !navTabs.includes(t);
   }
   // Members: relabel the two nav tabs. Persona/Skills live under Setup > Advanced.
   if (!hasFullAccess(user.role)) {
     const setupBtn = document.querySelector('[data-tab="home"]');
     if (setupBtn) setupBtn.textContent = 'Setup';
     const agentBtn = document.querySelector('[data-tab="chat"]');
     if (agentBtn) agentBtn.textContent = 'MyAgent';
   }
   ```
   Leave the rest of `applyTabGating` (the jump-to-first-allowed fallback, the tab-bar-hide) unchanged. (`allowedTabs` still includes `home` for members, so the landing `showTab(allowedTabs.includes('home') ? 'home' : …)` still lands on Setup; a member on the reachable persona/skills tab won't be bounced by the fallback since those are in `allowedTabs`.)

- [ ] **Step 6: Full build + test**

Run: `pnpm run build && pnpm test`
Expected: tsc clean; full suite green.

- [ ] **Step 7: Commit**

```bash
git add src/channels/playground/public/tab-gating.js src/channels/playground/public/tab-gating.test.ts src/channels/playground/public/app.js
git commit -m "feat(playground): member top nav = Setup + MyAgent; persona/skills reachable but off the bar"
```

---

### Task 2: Setup dashboard "Advanced" section + MyAgent relabel

> **Amendment (post-review, user decision):** the "Go to MyAgent →" button is **removed entirely**, not relabeled/fixed — it's redundant now that the top nav has a **MyAgent** tab (Task 1). So `renderDashboard` drops the go-to button, `mountMemberHome`'s state drops `onGoToChat`, and the go-to test is removed. The Advanced section (Edit persona / Edit skills) stays. (The original steps below still describe the Advanced section correctly; ignore the go-to-button parts.)

**Files:**
- Modify: `src/channels/playground/public/tabs/member-home.js`, `src/channels/playground/public/tabs/member-home.test.ts`

**Interfaces:**
- Consumes: the reachable `persona`/`skills` tabs (opened by clicking their hidden nav buttons — `document.querySelector('[data-tab="persona"]')?.click()`), which works because those tabs are in `MEMBER_TABS` (Task 1) so `showTab` permits them.
- Produces: `DashboardState` gains `onEditPersona: () => void` and `onEditSkills: () => void`; `renderDashboard` renders an Advanced `<details>` with two buttons wired to them, and the final button reads "Go to MyAgent →".

- [ ] **Step 1: Add failing render tests**

Add to `src/channels/playground/public/tabs/member-home.test.ts` (extend `baseState` with the two new handlers, and add cases). In `baseState`, add:
```ts
onEditPersona: vi.fn(),
onEditSkills: vi.fn(),
```
Then:

```ts
it('renders an Advanced section with persona/skills entry points', () => {
  const host = document.createElement('div');
  const st = baseState();
  renderDashboard(host, st);
  const adv = host.querySelector('[data-advanced]');
  expect(adv).toBeTruthy();
  expect(adv.tagName.toLowerCase()).toBe('details');
  const p = host.querySelector('[data-action="edit-persona"]');
  const s = host.querySelector('[data-action="edit-skills"]');
  expect(p).toBeTruthy();
  expect(s).toBeTruthy();
  p.click();
  expect(st.onEditPersona).toHaveBeenCalledOnce();
  s.click();
  expect(st.onEditSkills).toHaveBeenCalledOnce();
});

it('labels the chat entry button "Go to MyAgent"', () => {
  const host = document.createElement('div');
  renderDashboard(host, baseState());
  const btn = host.querySelector('[data-action="go-to-chat"]');
  expect(btn.textContent).toContain('Go to MyAgent');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/channels/playground/public/tabs/member-home.test.ts`
Expected: FAIL — no `[data-advanced]`; the go-to button still says "Go to Chat".

- [ ] **Step 3: Add the Advanced section + relabel in `member-home.js`**

In `renderDashboard`, add the Advanced `<details>` immediately BEFORE the final "Go to Chat" button, and change that button's text. Find:
```js
  host.append(el('button', { class: 'pg-goto-chat', 'data-action': 'go-to-chat', text: 'Go to Chat →', onclick: state.onGoToChat }));
```
Replace with:
```js
  // Advanced: open the member's own Persona / Skills editors (existing tabs,
  // kept off the top nav — reached from here).
  const adv = el('details', { class: 'pg-advanced', 'data-advanced': '' });
  adv.append(el('summary', { text: 'Advanced' }));
  adv.append(el('button', { class: 'pg-advanced-btn', 'data-action': 'edit-persona', text: 'Edit persona', onclick: state.onEditPersona }));
  adv.append(el('button', { class: 'pg-advanced-btn', 'data-action': 'edit-skills', text: 'Edit skills', onclick: state.onEditSkills }));
  host.append(adv);

  host.append(el('button', { class: 'pg-goto-chat', 'data-action': 'go-to-chat', text: 'Go to MyAgent →', onclick: state.onGoToChat }));
```

- [ ] **Step 4: Wire the handlers in `mountMemberChat`'s state (in `mountMemberHome`)**

In `mountMemberHome`, in the `state` object, add the two handlers next to `onGoToChat`:
```js
    onEditPersona: () => document.querySelector('[data-tab="persona"]')?.click(),
    onEditSkills: () => document.querySelector('[data-tab="skills"]')?.click(),
    onGoToChat: () => document.querySelector('[data-tab="chat"]')?.click(),
```
(The `onGoToChat` line already exists — leave it; the persona/skills clicks open the reachable-but-nav-hidden tabs, which `showTab` permits.)

- [ ] **Step 5: Run render tests to verify they pass**

Run: `pnpm exec vitest run src/channels/playground/public/tabs/member-home.test.ts`
Expected: PASS.

- [ ] **Step 6: Full build + test**

Run: `pnpm run build && pnpm test`
Expected: tsc clean; full suite green.

- [ ] **Step 7: Commit**

```bash
git add src/channels/playground/public/tabs/member-home.js src/channels/playground/public/tabs/member-home.test.ts
git commit -m "feat(playground): Setup dashboard Advanced section (persona/skills); Go to MyAgent"
```

---

### Task 3: Live verification

**Files:** Create `docs/superpowers/reviews/2026-07-12-setup-restructure-verification.md`. Service label: `com.nanoclaw-v2-581fefa4`.

- [ ] **Step 1: Rebuild + restart** (`pnpm run build` then `launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-581fefa4`).

- [ ] **Step 2: Provision a throwaway member, load the browser (Playwright)**

Provision (`./bin/ncl users provision --display-name "Setup Canary" --email setupcanary@clemson.edu`), redeem the token into a session (mirror prior live checks). In a real browser session confirm:
- The top nav shows exactly **Setup** and **MyAgent** (no Persona/Skills buttons in the bar).
- The **Setup** page shows the connect cards, the "Running on" indicator, and an **Advanced** disclosure; expanding it shows **Edit persona** / **Edit skills**.
- Clicking **Edit persona** opens the persona editor (the member's own); clicking **Edit skills** opens the skills editor; the **Setup** nav button returns to the dashboard.
- **MyAgent** opens the file-capable chat; its "Go to MyAgent →" entry on Setup navigates there.

- [ ] **Step 3: Confirm scope in the served assets**

`curl` the served `tab-gating.js` and confirm `MEMBER_NAV_TABS = ['home', 'chat']` and `MEMBER_TABS` still `['home','chat','persona','skills']`; confirm `member-home.js` carries the Advanced section + "Go to MyAgent".

- [ ] **Step 4: Tear down the canary** (revoke token, delete group + fs, stop container — mirror prior teardown). Write the verification doc + commit.

---

## Self-Review

**1. Spec coverage:**
- Member nav → Setup + MyAgent, persona/skills off the bar but reachable → Task 1 (nav-vs-reachable split + relabels).
- Setup Advanced section with persona/skills entry points (option a, existing editors reused) + Go-to-MyAgent relabel → Task 2.
- Owner tabs unchanged → Tasks 1/2 only touch member branches; tab ids unchanged.
- Live proof of the 2-tab nav + Advanced entry + MyAgent → Task 3.

**2. Placeholder scan:** No TBD/TODO; every code step shows the exact edit.

**3. Type consistency:** `MEMBER_NAV_TABS`/`navTabsForRole` names match between `tab-gating.js`, its test, and the `app.js` import; `onEditPersona`/`onEditSkills` match between `member-home.js` `renderDashboard`, `mountMemberHome`'s state, and the render tests; the `[data-advanced]`/`[data-action="edit-persona"|"edit-skills"|"go-to-chat"]` selectors match between the render code and the tests. Tab ids (`home`/`chat`/`persona`/`skills`) are unchanged, so `showTab`/`mounters`/index.html panels all still resolve.
