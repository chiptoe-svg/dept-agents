# Simple Tab "Agent Above the Model" Layering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the My Agent tab visually teach that the agent sits between the student and the model — agent mode is an elevated green card with the model layer peeking out beneath; toggling the agent off animates the layer away, dropping the chat onto a flat gray model card and sinking the side panel.

**Architecture:** Pure presentational change confined to the simple tab's two files. `mountSimple` wraps the chat host in a `.simple-stack` (agent card with slim header + a model strip below); `applyUseAgentToggle` — already the single toggle switch point — additionally toggles one class (`.agent-off`) on the `.simple-mode` wrapper and refreshes the layer labels; everything else is CSS keyed off that class with ~300 ms transitions. Zero `chat.js` changes.

**Tech Stack:** Vanilla JS (ES modules, no framework), hand-written CSS, vitest + happy-dom for frontend tests.

**Spec:** `docs/superpowers/specs/2026-06-11-simple-tab-layering-design.md` — read it first.

---

## Context for the implementer (read before Task 1)

- **Repo:** `/Users/admin/projects/nanoclaw`. The simple tab shipped earlier today (spec `docs/superpowers/specs/2026-06-11-simple-my-agent-tab-design.md`); this plan layers a visual treatment on top of it.
- **Files you will touch (only these):**
  - `src/channels/playground/public/tabs/simple.js` — the tab (309 lines). Read the header comment; it documents the hidden-control contract with the embedded chat.
  - `src/channels/playground/public/tabs/simple.test.ts` — 11 passing happy-dom tests.
  - `src/channels/playground/public/style.css` — the simple-tab block is lines ~1658–1794 (`/* ── "My Agent" simple tab ── */`).
- **NEVER run `prettier --write` (or any formatter) on files under `src/channels/playground/public/`** — they are hand-formatted; a formatter run causes a ~1200-line collateral reformat. Match existing style by hand. The pre-commit hook only format-checks `src/**/*.ts`, which is fine.
- **Test command:** `pnpm exec vitest run src/channels/playground/public/tabs/simple.test.ts` (run from repo root).
- **happy-dom v20 quirks** (already handled in the test file — keep the patterns): no global `Option` constructor (a guarded polyfill exists at simple.test.ts:79); `select.selectedOptions` only updates when the `selected` **attribute** is toggled via `removeAttribute`/`setAttribute`, or set in markup — `sel.value =` alone leaves it stale.
- **Accent colors are deliberate hexes, not design tokens:** agent green family `#bfe3c9` (border) / `#2e7d46` (text) / `#e8f5ec` (fill); direct blue-gray family `#aab4d4` (border) / `#4a5a96` (text) / `#eef1f8` (fill). Layout grays use tokens: `var(--border)`, `var(--surface-alt)`, `var(--text-faint)`.
- **Branch:** create `simple-tab-layering` off `main` before the first commit (`git checkout -b simple-tab-layering`). Do not commit to main.
- **Deploy model:** these are static assets served from source — a browser refresh picks them up; no host build/restart needed for manual verification. `pnpm run build` must still pass (repo hygiene).

---

### Task 1: Layer-label helper + toggle extension (`setLayerLabels`, `.agent-off`)

**Files:**
- Modify: `src/channels/playground/public/tabs/simple.js:71-76` (`applyUseAgentToggle`) and add one new exported function after `setBubbleLabels` (after line 249)
- Test: `src/channels/playground/public/tabs/simple.test.ts`

- [ ] **Step 1: Create the branch**

```bash
cd /Users/admin/projects/nanoclaw && git checkout -b simple-tab-layering
```

- [ ] **Step 2: Write the failing tests**

Append to `src/channels/playground/public/tabs/simple.test.ts` (bottom of file), and add `setLayerLabels` to the import list at the top (line 3–11):

```ts
describe('setLayerLabels / applyUseAgentToggle layering', () => {
  function layeredWrapper() {
    const wrapper = document.createElement('div');
    wrapper.className = 'simple-mode';
    wrapper.innerHTML = `
      <button id="mode-agent"></button>
      <button id="mode-direct"></button>
      <div class="simple-panel-body"></div>
      <div class="simple-card-header"></div>
      <div class="simple-model-strip"></div>
      <input id="simple-agent-name" value="JaneBot">
      <select id="simple-model-sel"><option selected>GPT-5.5</option></select>
    `;
    return wrapper;
  }

  it('writes the strip text and an ON header', () => {
    const wrapper = layeredWrapper();
    setLayerLabels(wrapper, 'JaneBot', 'GPT-5.5');
    expect(wrapper.querySelector('.simple-model-strip')!.textContent).toBe('⚡ GPT-5.5 — underneath');
    expect(wrapper.querySelector('.simple-card-header')!.textContent).toBe('🤖 JaneBot');
  });

  it('renders the model label in the header when the wrapper is .agent-off', () => {
    const wrapper = layeredWrapper();
    wrapper.classList.add('agent-off');
    setLayerLabels(wrapper, 'JaneBot', 'GPT-5.5');
    expect(wrapper.querySelector('.simple-card-header')!.textContent).toBe('⚡ GPT-5.5 — model only');
    expect(wrapper.querySelector('.simple-model-strip')!.textContent).toBe('⚡ GPT-5.5 — underneath');
  });

  it('toggle OFF adds .agent-off and swaps the header; ON restores it', () => {
    const wrapper = layeredWrapper();
    applyUseAgentToggle(wrapper, false);
    expect(wrapper.classList.contains('agent-off')).toBe(true);
    expect(wrapper.querySelector('.simple-card-header')!.textContent).toBe('⚡ GPT-5.5 — model only');

    applyUseAgentToggle(wrapper, true);
    expect(wrapper.classList.contains('agent-off')).toBe(false);
    expect(wrapper.querySelector('.simple-card-header')!.textContent).toBe('🤖 JaneBot');
  });
});
```

Note: the `<option selected>` in markup is how happy-dom populates `selectedOptions` (see quirks above) — `currentModelLabel` reads `selectedOptions[0].textContent`, so this yields `'GPT-5.5'`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/channels/playground/public/tabs/simple.test.ts`
Expected: FAIL — `setLayerLabels` is not exported (import error), 3 new tests fail; the existing 11 still pass once the import is satisfied.

- [ ] **Step 4: Implement**

In `src/channels/playground/public/tabs/simple.js`, replace `applyUseAgentToggle` (lines 66–76) with:

```js
/**
 * Flip between agent and direct-model chat by clicking the embedded chat's
 * hidden mode buttons (chat.js's setMode handles the rest). OFF also grays
 * the panel body — you can't edit an agent you're not talking to — and adds
 * .agent-off to the wrapper, which drives the layering CSS (the agent card
 * flattens onto the model layer; see the layering block in style.css).
 */
export function applyUseAgentToggle(wrapper, useAgent) {
  const btn = wrapper.querySelector(useAgent ? '#mode-agent' : '#mode-direct');
  if (btn) btn.click();
  const body = wrapper.querySelector('.simple-panel-body');
  if (body) body.classList.toggle('simple-disabled', !useAgent);
  wrapper.classList.toggle('agent-off', !useAgent);
  const nameEl = wrapper.querySelector('#simple-agent-name');
  setLayerLabels(wrapper, (nameEl && nameEl.value.trim()) || 'Your agent', currentModelLabel(wrapper) || 'model');
}
```

After `setBubbleLabels` (line 249), add:

```js
/**
 * Layering chrome text — the slim header on the agent card and the model
 * strip peeking out beneath it. The header names whichever layer you're
 * talking to (agent ON → the agent; .agent-off → the bare model).
 */
export function setLayerLabels(wrapper, agentName, modelLabel) {
  const strip = wrapper.querySelector('.simple-model-strip');
  const header = wrapper.querySelector('.simple-card-header');
  if (strip) strip.textContent = `⚡ ${modelLabel} — underneath`;
  if (header) {
    header.textContent = wrapper.classList.contains('agent-off')
      ? `⚡ ${modelLabel} — model only`
      : `🤖 ${agentName}`;
  }
}
```

(`currentModelLabel` is a module-local `function` declaration below — hoisting makes the forward reference fine. The null-guards keep the existing `applyUseAgentToggle` test, whose scaffold has no name input / header / strip, passing unchanged.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/channels/playground/public/tabs/simple.test.ts`
Expected: PASS — 14 tests (11 existing + 3 new).

- [ ] **Step 6: Commit**

```bash
git add src/channels/playground/public/tabs/simple.js src/channels/playground/public/tabs/simple.test.ts
git commit -m "feat(simple-tab): layer labels + .agent-off toggle class

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Stack DOM in `mountSimple` + layering CSS

**Files:**
- Modify: `src/channels/playground/public/tabs/simple.js:81-108` (the `mountSimple` innerHTML)
- Modify: `src/channels/playground/public/style.css:1682-1685` (`.simple-chat-host`) and append a layering block after line 1794 (end of the simple-tab section)

No new unit test — this is markup + CSS; behavior is covered by Task 1/3 tests and the suite must stay green. Visual verification happens in Task 4.

- [ ] **Step 1: Restructure the layout markup**

In `mountSimple`, replace the `.simple-layout` opening (currently):

```html
      <div class="simple-layout">
        <div class="simple-chat-host"></div>
```

with:

```html
      <div class="simple-layout">
        <div class="simple-stack">
          <div class="simple-agent-card">
            <div class="simple-card-header"></div>
            <div class="simple-chat-host"></div>
          </div>
          <div class="simple-model-strip"></div>
        </div>
```

and close the new `.simple-stack` div: the line after the closing `</aside>` currently reads `</div>` (closing `.simple-layout`) — the `</div>` for `.simple-stack` goes **before** `<aside class="simple-panel">`. The full layout block after the edit:

```html
      <div class="simple-layout">
        <div class="simple-stack">
          <div class="simple-agent-card">
            <div class="simple-card-header"></div>
            <div class="simple-chat-host"></div>
          </div>
          <div class="simple-model-strip"></div>
        </div>
        <aside class="simple-panel">
          ... (panel markup unchanged) ...
        </aside>
      </div>
```

`mountChat(el.querySelector('.simple-chat-host'))` further down is unchanged — the selector still matches.

- [ ] **Step 2: Update `.simple-chat-host` sizing in style.css**

The chat host used to be the flex child of `.simple-layout`; now `.simple-stack` takes that role and the host flexes inside the card. Replace lines 1682–1685:

```css
.simple-chat-host {
  flex: 2.2;
  min-width: 0;
}
```

with:

```css
.simple-chat-host {
  flex: 1;
  min-width: 0;
}
```

- [ ] **Step 3: Append the layering CSS block**

Append after the `.simple-mode .bubble-direct::before` rule (line 1794), still inside the simple-tab section:

```css
/* ── Layering: the agent card rides above the model layer ──
   The left column is a stack: agent card (slim header + chat) on top,
   a thin strip of the model layer peeking out beneath. Toggling the
   agent off adds .agent-off to .simple-mode (applyUseAgentToggle):
   the green framing drains away, the strip collapses, and the chat
   sits flat on the exposed model card. Accent hexes are the deliberate
   bubble accent families (see the bubble rules above), not tokens.
   Note: border-style (solid↔dashed) doesn't interpolate — the color
   and shadow transitions carry the animation. */
.simple-stack {
  flex: 2.2;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.simple-agent-card {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  border: 1px solid #bfe3c9;
  border-radius: 8px;
  background: #fdfffe;
  box-shadow: 0 3px 10px rgba(46, 125, 70, 0.18);
  overflow: hidden; /* clean rounded corners; chat modals live in #modal-root, so nothing is clipped */
  transition: border-color 0.3s ease, box-shadow 0.3s ease, background-color 0.3s ease;
}
.simple-card-header {
  font-size: 11px;
  font-weight: 600;
  color: #2e7d46;
  padding: 4px 10px;
  border-bottom: 1px solid #bfe3c9;
  min-height: 1em;
  transition: color 0.3s ease, border-color 0.3s ease;
}
.simple-model-strip {
  font-size: 11px;
  color: var(--text-faint);
  background: var(--surface-alt);
  border: 1px solid var(--border);
  border-top: none;
  border-radius: 0 0 8px 8px;
  margin: 0 10px; /* narrower than the card — reads as the layer underneath */
  padding: 3px 10px;
  overflow: hidden;
  max-height: 2em;
  transition: max-height 0.3s ease, padding 0.3s ease, opacity 0.3s ease;
}

/* Panel fused to the agent card: same elevation, same green framing. */
.simple-mode .simple-panel {
  border-color: #bfe3c9;
  background: #fdfffe;
  box-shadow: 0 3px 10px rgba(46, 125, 70, 0.18);
  transition: border-color 0.3s ease, box-shadow 0.3s ease, background-color 0.3s ease;
}

/* OFF — the agent layer retracts: chat flattens onto the model card
   (gray, dashed — the bubble-direct family), the strip disappears
   (you're ON the model layer now), the panel sinks and grays. */
.simple-mode.agent-off .simple-agent-card {
  border: 1px dashed #aab4d4;
  background: transparent;
  box-shadow: none;
}
.simple-mode.agent-off .simple-card-header {
  color: #4a5a96;
  border-bottom: 1px dashed #aab4d4;
}
.simple-mode.agent-off .simple-model-strip {
  max-height: 0;
  padding-top: 0;
  padding-bottom: 0;
  opacity: 0;
  border-width: 0;
}
.simple-mode.agent-off .simple-panel {
  border-color: var(--border);
  background: var(--surface-alt);
  box-shadow: inset 0 2px 6px rgba(0, 0, 0, 0.08);
}

@media (prefers-reduced-motion: reduce) {
  .simple-agent-card,
  .simple-card-header,
  .simple-model-strip,
  .simple-mode .simple-panel {
    transition: none;
  }
}
```

- [ ] **Step 4: Run the suite and build**

Run: `pnpm exec vitest run src/channels/playground/public/tabs/simple.test.ts && pnpm run build`
Expected: 14 tests PASS, `tsc` exits 0 (the JS/CSS files aren't type-checked, but the build guards the repo).

- [ ] **Step 5: Commit**

```bash
git add src/channels/playground/public/tabs/simple.js src/channels/playground/public/style.css
git commit -m "feat(simple-tab): agent-card stack DOM + layering CSS

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Wire layer labels into the model-change, rename, and init paths

**Files:**
- Modify: `src/channels/playground/public/tabs/simple.js` — `saveName` (line ~168) and `applySelection` inside `initModelDropdown` (line ~285-290)
- Test: `src/channels/playground/public/tabs/simple.test.ts` — extend `buildPanelWrapper` and the `initModelDropdown — model change` test

- [ ] **Step 1: Extend the test scaffold and write the failing assertions**

In `buildPanelWrapper()` (simple.test.ts:147-164), add the two layering elements to the innerHTML (anywhere inside, e.g. after `<select id="model-sel"></select>`):

```html
    <div class="simple-card-header"></div>
    <div class="simple-model-strip"></div>
```

In the `initModelDropdown — model change` test, after the existing hidden-select assertions (line ~296), append:

```ts
    // Layer labels track the dropdown: strip shows the new model,
    // ON-state header shows the agent name.
    expect(wrapper.querySelector('.simple-model-strip')!.textContent).toBe('⚡ GPT-5.5 — underneath');
    expect(wrapper.querySelector('.simple-card-header')!.textContent).toBe('🤖 TestBot');
```

(`buildPanelWrapper`'s name input has `value="TestBot"`; the wrapper has no `.agent-off`, so the header shows the agent name.)

- [ ] **Step 2: Run the tests to verify the new assertions fail**

Run: `pnpm exec vitest run src/channels/playground/public/tabs/simple.test.ts`
Expected: FAIL — strip/header textContent are `''` because nothing calls `setLayerLabels` on model change yet. (The Task 1 tests still pass — they call `setLayerLabels` directly.)

- [ ] **Step 3: Wire the call sites**

In `initModelDropdown`'s `applySelection` (simple.js:285-290), add a `setLayerLabels` call alongside the existing `setBubbleLabels`:

```js
  const applySelection = () => {
    const opt = sel.selectedOptions[0];
    if (!opt) return;
    syncHiddenModelSelects(wrapper, opt.dataset.provider, opt.value);
    const agentName = wrapper.querySelector('#simple-agent-name').value.trim() || 'Your agent';
    setBubbleLabels(wrapper, agentName, opt.textContent);
    setLayerLabels(wrapper, agentName, opt.textContent);
  };
```

In `saveName` (simple.js:166-169), mirror it next to the existing `setBubbleLabels` call:

```js
      if (r.ok) {
        lastSavedName = name;
        setBubbleLabels(wrapper, name, currentModelLabel(wrapper));
        setLayerLabels(wrapper, name, currentModelLabel(wrapper) || 'model');
        return true;
      } else {
```

(`applySelection()` already runs once at init — that covers the initial header/strip text after the config loads; no extra init call needed.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/channels/playground/public/tabs/simple.test.ts`
Expected: PASS — 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/channels/playground/public/tabs/simple.js src/channels/playground/public/tabs/simple.test.ts
git commit -m "feat(simple-tab): layer labels track model change and rename

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Full verification, live check, state.md

**Files:**
- Modify: `state.md` (decision log — one entry at the TOP of the log, newest-first)

- [ ] **Step 1: Full suite + build**

Run: `pnpm test && pnpm run build`
Expected: all test files pass (1232 tests = 1229 + 3 new), `tsc` clean.

- [ ] **Step 2: Live visual verification**

Static assets only — refresh the browser at `http://127.0.0.1:3002` (host already running; no restart). On the **My Agent** tab verify:

1. Agent ON: chat surface is a green-framed raised card with shadow; slim header reads `🤖 <agent name>`; a thin gray strip below reads `⚡ <model> — underneath`; the side panel has the same green border + shadow (fused look).
2. Flip **Use agent** OFF: ~300 ms transition — green drains to gray dashed framing, shadow drops, strip collapses, header swaps to `⚡ <model> — model only`, panel grays and looks sunken (inset shadow). Flip ON: everything returns.
3. Change the model dropdown: strip and (in OFF state) header text update to the new display name.
4. Rename the agent (blur to save): ON-state header updates to the new name.
5. Chat still works in both modes — send one agent message and one direct message; scroll area sizes correctly inside the card (the chat column must not overflow or collapse — see the spec's chat-column-height risk).

- [ ] **Step 3: state.md decision-log entry**

Add at the top of the decision log (newest-first), one entry:

```markdown
- **2026-06-11** — **Simple tab layering: agent above the model.** The My Agent tab now renders agent mode as an elevated green card (slim `🤖 <name>` header) with a model strip peeking beneath, panel fused at the same elevation; toggling the agent off animates the layer away (`.agent-off` class, pure CSS) onto a flat gray model card. No chat.js changes. Spec: docs/superpowers/specs/2026-06-11-simple-tab-layering-design.md.
```

- [ ] **Step 4: Commit**

```bash
git add state.md
git commit -m "docs(state): decision-log entry for simple-tab layering

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## After all tasks

Final holistic review of the branch, then `superpowers:finishing-a-development-branch` (verify tests → merge/PR/keep/discard options).
