# Richer Live Trace Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render each agent tool use in the Chat trace pane as ONE card with a success/error badge and a tool-aware preview, instead of two cards with no status and a generic preview.

**Architecture:** Pure client-side change to `src/channels/playground/public/tabs/chat.js`. Unify the `toolcall_*` card (keyed by `contentIndex`) and the `tool_execution_*` card (keyed by `toolCallId`) into a single card keyed by `toolCallId`; add a status badge driven by `tool_execution_end.isError`; add small tool-aware preview helpers that defer to the existing `formatTracePreview`. Make the renderer testable by exporting the relevant functions and adding a `happy-dom` vitest test (none exist today).

**Tech Stack:** Browser ES module (`chat.js`), vitest + `happy-dom` (already a dev dep), per-file `// @vitest-environment happy-dom`.

**Spec:** `docs/superpowers/specs/2026-06-11-richer-trace-cards-design.md`

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `src/channels/playground/public/tabs/chat.js` | Chat tab + trace renderer | Add pure helpers; unify tool card; status badge; tool-aware previews; export the tested fns |
| `src/channels/playground/public/tabs/chat-trace.test.ts` | Trace-renderer tests | Create (happy-dom) |

No backend/SSE/DB/container changes. Served as static JS — a browser refresh deploys it.

---

## Task 1: Pure helpers (preview + result classification) + exports + unit tests

**Files:**
- Modify: `src/channels/playground/public/tabs/chat.js`
- Test: `src/channels/playground/public/tabs/chat-trace.test.ts` (create)

Run tests with: `pnpm exec vitest run src/channels/playground/public/tabs/chat-trace.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/channels/playground/public/tabs/chat-trace.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import {
  previewForToolArgs,
  previewForToolResult,
  classifyToolResult,
  traceResultText,
} from './chat.js';

describe('traceResultText', () => {
  it('extracts text from a string, an AgentToolResult content array, and falls back to JSON', () => {
    expect(traceResultText('hello')).toBe('hello');
    expect(traceResultText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('a b');
    expect(traceResultText({ foo: 1 })).toContain('foo');
    expect(traceResultText(null)).toBe('');
  });
});

describe('classifyToolResult', () => {
  it('prefers the native isError flag', () => {
    expect(classifyToolResult({ isError: true, result: 'whatever' })).toBe('error');
    expect(classifyToolResult({ isError: false, result: 'Fetch failed: x' })).toBe('ok');
  });
  it('falls back to error-string prefixes when isError is absent', () => {
    expect(classifyToolResult({ result: { content: [{ type: 'text', text: 'Fetch failed: HTTP 500' }] } })).toBe('error');
    expect(classifyToolResult({ result: 'blocked by egress policy: internal address 10.0.0.1' })).toBe('error');
    expect(classifyToolResult({ result: 'Web search failed: 422' })).toBe('error');
    expect(classifyToolResult({ result: 'Search results for "x": ...' })).toBe('ok');
  });
});

describe('previewForToolArgs', () => {
  it('surfaces the meaningful field per tool, defers to the generic formatter otherwise', () => {
    expect(previewForToolArgs('web_search', { query: 'weather in paris' })).toContain('weather in paris');
    expect(previewForToolArgs('fetch_url', { url: 'https://example.com/x' })).toContain('https://example.com/x');
    expect(previewForToolArgs('bash', { cmd: 'ls -la' })).toContain('ls -la');
    // unknown tool → generic formatter still returns something non-empty, no throw
    expect(previewForToolArgs('mystery', { query: 'q' })).toContain('q');
  });
});

describe('previewForToolResult', () => {
  it('shows the first error line when status is error', () => {
    expect(previewForToolResult('fetch_url', { content: [{ type: 'text', text: 'Fetch failed: HTTP 500\nmore' }] }, 'error'))
      .toContain('Fetch failed: HTTP 500');
  });
  it('shows a result count for web_search successes when derivable', () => {
    const r = { content: [{ type: 'text', text: 'Search results for "x":\n\n1. A\n2. B\n3. C' }] };
    expect(previewForToolResult('web_search', r, 'ok')).toMatch(/result/i);
  });
  it('falls back to the generic preview for unknown tools', () => {
    expect(previewForToolResult('mystery', 'plain text result', 'ok')).toContain('plain text');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/channels/playground/public/tabs/chat-trace.test.ts`
Expected: FAIL — `previewForToolArgs`/`previewForToolResult`/`classifyToolResult`/`traceResultText` are not exported.

- [ ] **Step 3: Implement the helpers in `chat.js`**

Add these near the existing `formatTracePreview` / `formatTracePayloadFull` (so they sit with the other trace formatters), and mark each `export`:

```js
/**
 * Extract a plain-text view of a tool result for classification/preview.
 * Handles: string, AgentToolResult { content: [{type:'text', text}] }, or
 * any object (compact JSON). Mirrors formatTracePreview's input handling but
 * returns the full (untruncated) text so callers can scan/slice it.
 */
export function traceResultText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (result && Array.isArray(result.content)) {
    return result.content
      .filter((b) => b && typeof b === 'object' && typeof b.text === 'string')
      .map((b) => b.text)
      .join(' ');
  }
  if (Array.isArray(result) && result.every((b) => b && typeof b === 'object' && 'text' in b)) {
    return result.map((b) => b.text).join(' ');
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

// NanoClaw tools' error-string prefixes — the fallback signal when a
// tool_execution_end event lacks the native isError flag.
const TRACE_ERROR_RE = /^\s*(Web search failed|Fetch failed|blocked by egress policy|Error\b|HTTP [45]\d\d)/i;

/**
 * Classify a tool_execution_end event as 'ok' | 'error'. Prefers the native
 * `isError` boolean; falls back to scanning the result text for known
 * NanoClaw tool error prefixes.
 */
export function classifyToolResult(event) {
  if (event && typeof event.isError === 'boolean') return event.isError ? 'error' : 'ok';
  const text = traceResultText(event && event.result);
  return TRACE_ERROR_RE.test(text) ? 'error' : 'ok';
}

/**
 * One-line summary of a tool call's ARGS. The generic formatTracePreview
 * already surfaces query/command/url/path from arg objects; this adds the
 * bash `cmd` alias and keeps tool intent explicit, deferring otherwise.
 */
export function previewForToolArgs(name, args) {
  if (args && typeof args === 'object') {
    if (name === 'web_search' && typeof args.query === 'string') return truncate(args.query, 80);
    if (name === 'fetch_url' && typeof args.url === 'string') return truncate(args.url, 80);
    if ((name === 'bash' || name === 'terminal') && typeof (args.cmd ?? args.command) === 'string') {
      return truncate(String(args.cmd ?? args.command), 80);
    }
  }
  return formatTracePreview(args);
}

/**
 * One-line summary of a tool RESULT. On error: the first line of the result
 * text. For web_search successes: a result count when derivable. Otherwise
 * the generic preview.
 */
export function previewForToolResult(name, result, status) {
  const text = traceResultText(result);
  if (status === 'error') {
    const firstLine = text.split('\n')[0].trim();
    return truncate(firstLine || 'error', 80);
  }
  if (name === 'web_search') {
    const matches = text.match(/^\s*\d+\.\s/gm);
    if (matches && matches.length > 0) return `${matches.length} result${matches.length === 1 ? '' : 's'}`;
  }
  return formatTracePreview(result);
}
```

(`truncate` and `formatTracePreview` already exist in `chat.js`; reuse them. Do NOT duplicate their logic.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run src/channels/playground/public/tabs/chat-trace.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/channels/playground/public/tabs/chat.js src/channels/playground/public/tabs/chat-trace.test.ts
git commit -m "feat(trace): tool-aware preview + result-classification helpers (exported, tested)"
```

---

## Task 2: Unify the tool card (one card per toolCallId)

**Files:**
- Modify: `src/channels/playground/public/tabs/chat.js`
- Test: `src/channels/playground/public/tabs/chat-trace.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `chat-trace.test.ts`:

```ts
import { appendPiEvent } from './chat.js';

function freshTrace() {
  const ul = document.createElement('ul');
  // appendPiEvent appends into trace._currentTurnUl when present.
  const turnUl = document.createElement('ul');
  ul._currentTurnUl = turnUl;
  ul.appendChild(turnUl);
  return ul;
}
function pi(trace, event) {
  appendPiEvent(trace, event);
}

describe('unified tool card', () => {
  it('renders ONE card for a tool call + its execution, keyed by toolCallId', () => {
    const trace = freshTrace();
    pi(trace, { type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0 } });
    pi(trace, { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0, toolCall: { id: 'tc1', name: 'web_search', arguments: { query: 'paris' } } } });
    pi(trace, { type: 'tool_execution_start', toolCallId: 'tc1', toolName: 'web_search', args: { query: 'paris' } });
    pi(trace, { type: 'tool_execution_end', toolCallId: 'tc1', isError: false, result: { content: [{ type: 'text', text: 'Search results for "paris":\n\n1. A\n2. B' }] } });

    const cards = trace.querySelectorAll('[data-tool-call-id="tc1"]');
    expect(cards.length).toBe(1);
    const card = cards[0];
    // The single card carries both the args (query) and the result (count).
    expect(card.textContent).toContain('paris');
    expect(card.textContent).toMatch(/result/i);
  });

  it('keeps parallel tool calls in separate cards', () => {
    const trace = freshTrace();
    pi(trace, { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0, toolCall: { id: 'tcA', name: 'fetch_url', arguments: { url: 'https://a' } } } });
    pi(trace, { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 1, toolCall: { id: 'tcB', name: 'fetch_url', arguments: { url: 'https://b' } } } });
    pi(trace, { type: 'tool_execution_end', toolCallId: 'tcA', isError: false, result: 'ok-a' });
    pi(trace, { type: 'tool_execution_end', toolCallId: 'tcB', isError: false, result: 'ok-b' });
    expect(trace.querySelectorAll('[data-tool-call-id="tcA"]').length).toBe(1);
    expect(trace.querySelectorAll('[data-tool-call-id="tcB"]').length).toBe(1);
  });

  it('renders a card when execution arrives with no preceding toolcall_end', () => {
    const trace = freshTrace();
    pi(trace, { type: 'tool_execution_start', toolCallId: 'tcX', toolName: 'web_search', args: { query: 'q' } });
    pi(trace, { type: 'tool_execution_end', toolCallId: 'tcX', isError: false, result: 'done' });
    expect(trace.querySelectorAll('[data-tool-call-id="tcX"]').length).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/channels/playground/public/tabs/chat-trace.test.ts`
Expected: FAIL — today there are two cards (no `data-tool-call-id` on the toolcall card path / a second exec card), so `cards.length` ≠ 1.

- [ ] **Step 3: Add a shared card builder + unify state**

First, **export `appendPiEvent`** so the test can drive it: change `function appendPiEvent(` to `export function appendPiEvent(` (the `piHandle*` internals stay private).

In `chat.js`, in `appendPiEvent`'s state init (the `trace._piState = { … }` object), replace `toolCallCards` / `toolExecCards` usage with a unified map plus a transient pending map:

```js
    trace._piState = {
      messageBubble: null,
      messageTextEl: null,
      thinkingDetails: null,
      thinkingBodyEl: null,
      pendingToolCards: {}, // contentIndex → card, only until toolcall_end gives us the id
      toolCards: {},        // toolCallId → card (the unified card)
    };
```

Add a shared builder near the tool handlers:

```js
/**
 * Build one unified tool card: <li><details><summary>[badge][name][preview]</summary>
 * <pre args><pre result hidden></details></li>. Returns the card handle the
 * toolcall_* and tool_execution_* handlers both write into.
 */
function createToolCard(target, toolName) {
  const li = document.createElement('li');
  li.className = 'trace trace-tool_use';

  const details = document.createElement('details');
  details.className = 'trace-details';
  const summaryEl = document.createElement('summary');
  summaryEl.className = 'trace-summary';

  const badgeEl = document.createElement('span');
  badgeEl.className = 'trace-tool-badge';
  badgeEl.textContent = '…'; // pending until execution ends

  const kindEl = document.createElement('span');
  kindEl.className = 'trace-kind';
  kindEl.textContent = toolName ? `tool · ${toolName}` : 'tool call · pending…';

  const previewEl = document.createElement('span');
  previewEl.className = 'trace-preview';
  previewEl.textContent = '';

  summaryEl.append(badgeEl, kindEl, previewEl);
  details.appendChild(summaryEl);

  const argsEl = document.createElement('pre');
  argsEl.className = 'trace-body';
  argsEl.textContent = '';
  details.appendChild(argsEl);

  const resultEl = document.createElement('pre');
  resultEl.className = 'trace-body';
  resultEl.style.display = 'none';
  details.appendChild(resultEl);

  li.appendChild(details);
  target.appendChild(li);
  return { li, badgeEl, kindEl, previewEl, argsEl, resultEl, toolName };
}
```

- [ ] **Step 4: Rewrite the toolcall handlers to use the unified card**

Replace `piHandleToolcallStart` and `piHandleToolcallEnd`:

```js
function piHandleToolcallStart(trace, ame, st) {
  const target = trace._currentTurnUl || trace;
  const card = createToolCard(target, null);
  st.pendingToolCards[ame.contentIndex] = card;
  trace.scrollTop = trace.scrollHeight;
}

function piHandleToolcallEnd(trace, ame, st) {
  const tc = ame.toolCall;
  if (!tc) return;
  // Reuse the pending card if toolcall_start created one; otherwise make one.
  let card = st.pendingToolCards[ame.contentIndex];
  if (!card) {
    card = createToolCard(trace._currentTurnUl || trace, null);
  }
  delete st.pendingToolCards[ame.contentIndex];

  const name = tc.name || 'unknown';
  const args = tc.arguments != null ? tc.arguments : {};
  card.toolName = name;
  card.kindEl.textContent = `tool · ${name}`;
  card.previewEl.textContent = previewForToolArgs(name, args);
  card.argsEl.textContent = formatTracePayloadFull(args);

  // Rekey into the unified map so tool_execution_* finds the SAME card.
  if (tc.id) {
    card.li.dataset.toolCallId = tc.id;
    st.toolCards[tc.id] = card;
  }
  if (trace._currentTurnUl) finalizeTurn(trace._currentTurnUl.closest('.trace-turn'));
  trace.scrollTop = trace.scrollHeight;
}
```

- [ ] **Step 5: Rewrite the tool-execution handlers to reuse the unified card**

Replace `piHandleToolExecutionStart`, `piHandleToolExecutionUpdate`, `piHandleToolExecutionEnd`:

```js
function piHandleToolExecutionStart(trace, event, st) {
  const { toolCallId, toolName, args } = event;
  let card = st.toolCards[toolCallId];
  if (!card) {
    // Execution without a preceding toolcall_end (e.g. host-injected tool).
    card = createToolCard(trace._currentTurnUl || trace, toolName || null);
    if (toolName) card.kindEl.textContent = `tool · ${toolName}`;
    if (args != null) card.argsEl.textContent = formatTracePayloadFull(args);
    card.li.dataset.toolCallId = toolCallId;
    st.toolCards[toolCallId] = card;
  }
  card.badgeEl.textContent = '…';
  card.previewEl.textContent = card.previewEl.textContent || 'running…';
  if (trace._currentTurnUl) finalizeTurn(trace._currentTurnUl.closest('.trace-turn'));
  trace.scrollTop = trace.scrollHeight;
}

function piHandleToolExecutionUpdate(trace, event, st) {
  const card = st.toolCards[event.toolCallId];
  if (!card) return;
  if (event.partialResult != null) {
    card.previewEl.textContent = formatTracePreview(event.partialResult);
  }
  trace.scrollTop = trace.scrollHeight;
}

function piHandleToolExecutionEnd(trace, event, st) {
  let card = st.toolCards[event.toolCallId];
  if (!card) {
    card = createToolCard(trace._currentTurnUl || trace, event.toolCallId || null);
    card.li.dataset.toolCallId = event.toolCallId || '';
    st.toolCards[event.toolCallId] = card;
  }
  const name = card.toolName || 'unknown';
  const result = event.result;
  // (Status badge wiring is added in Task 3.)
  card.previewEl.textContent = previewForToolResult(name, result, 'ok');
  if (result != null) {
    card.resultEl.textContent = formatTracePayloadFull(result);
    card.resultEl.style.display = '';
  }
  if (trace._currentTurnUl) finalizeTurn(trace._currentTurnUl.closest('.trace-turn'));
  trace.scrollTop = trace.scrollHeight;
}
```

Also remove the now-dead references to `st.toolCallCards` / `st.toolExecCards` elsewhere (search the file — `turn_start`'s reset sets `st.toolCallCards = {}`; change that to `st.pendingToolCards = {}` and do NOT clear `st.toolCards` at turn boundaries, since executions can cross turns).

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm exec vitest run src/channels/playground/public/tabs/chat-trace.test.ts`
Expected: PASS (one card per toolCallId; parallel calls separate; exec-without-toolcall_end renders one).

- [ ] **Step 7: Commit**

```bash
git add src/channels/playground/public/tabs/chat.js src/channels/playground/public/tabs/chat-trace.test.ts
git commit -m "feat(trace): unify tool call + execution into one card keyed by toolCallId"
```

---

## Task 3: Success/error status badge

**Files:**
- Modify: `src/channels/playground/public/tabs/chat.js`
- Test: `src/channels/playground/public/tabs/chat-trace.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `chat-trace.test.ts`:

```ts
describe('status badge', () => {
  it('marks an errored execution with the error class + ✗', () => {
    const trace = freshTrace();
    pi(trace, { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0, toolCall: { id: 'e1', name: 'fetch_url', arguments: { url: 'http://192.168.64.1' } } } });
    pi(trace, { type: 'tool_execution_end', toolCallId: 'e1', isError: true, result: { content: [{ type: 'text', text: 'Fetch failed: blocked by egress policy' }] } });
    const card = trace.querySelector('[data-tool-call-id="e1"]');
    expect(card.classList.contains('trace-tool-error')).toBe(true);
    expect(card.querySelector('.trace-tool-badge').textContent).toContain('✗');
  });
  it('marks a successful execution with the ok class + ✓', () => {
    const trace = freshTrace();
    pi(trace, { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0, toolCall: { id: 'k1', name: 'web_search', arguments: { query: 'x' } } } });
    pi(trace, { type: 'tool_execution_end', toolCallId: 'k1', isError: false, result: 'Search results for "x":\n\n1. A' });
    const card = trace.querySelector('[data-tool-call-id="k1"]');
    expect(card.classList.contains('trace-tool-ok')).toBe(true);
    expect(card.querySelector('.trace-tool-badge').textContent).toContain('✓');
  });
  it('uses the error-string fallback when isError is absent', () => {
    const trace = freshTrace();
    pi(trace, { type: 'tool_execution_start', toolCallId: 'f1', toolName: 'web_search', args: {} });
    pi(trace, { type: 'tool_execution_end', toolCallId: 'f1', result: 'Web search failed: 422' });
    expect(trace.querySelector('[data-tool-call-id="f1"]').classList.contains('trace-tool-error')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/channels/playground/public/tabs/chat-trace.test.ts`
Expected: FAIL — no `trace-tool-error`/`trace-tool-ok` class or badge glyph is set yet.

- [ ] **Step 3: Wire the badge into `piHandleToolExecutionEnd`**

In `piHandleToolExecutionEnd` (Task 2), replace the `// (Status badge wiring is added in Task 3.)` line + the preview line with:

```js
  const status = classifyToolResult(event); // 'ok' | 'error'
  card.li.classList.add(status === 'error' ? 'trace-tool-error' : 'trace-tool-ok');
  card.badgeEl.textContent = status === 'error' ? '✗' : '✓';
  card.previewEl.textContent = previewForToolResult(name, result, status);
```

- [ ] **Step 4: Add the two CSS classes**

Find where the existing `trace-*` accent rules live (search the playground CSS for `trace-tool_result` / `.trace-tool_use`; it's the stylesheet served with the playground — locate via `grep -rn "trace-tool_result" src/channels/playground/public`). Following the existing border-left accent pattern, add:

```css
.trace-tool-ok    { border-left-color: #87a96b; }   /* success — matches trace-tool_result accent */
.trace-tool-error { border-left-color: #c0504d; }   /* error — red accent */
.trace-tool-badge { margin-right: 4px; font-weight: 600; }
```

(If the trace cards don't currently carry a left border, add `border-left: 3px solid transparent;` to the base `.trace` rule so the accent shows — match whatever the existing `.trace-tool_use` / `.trace-tool_result` rules already do; do not restyle unrelated rows.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run src/channels/playground/public/tabs/chat-trace.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/channels/playground/public/tabs/chat.js src/channels/playground/public/tabs/chat-trace.test.ts src/channels/playground/public/
git commit -m "feat(trace): success/error status badge on tool cards (isError + fallback)"
```

---

## Task 4: Tool-aware result preview wiring + no-regression + verify

**Files:**
- Modify: `src/channels/playground/public/tabs/chat.js` (only if Task 2/3 left the preview wiring incomplete)
- Test: `src/channels/playground/public/tabs/chat-trace.test.ts`

(The result preview is already wired in Task 3's `previewForToolResult(name, result, status)` call. This task adds the no-regression guard and the final verification.)

- [ ] **Step 1: Write the no-regression test**

Append to `chat-trace.test.ts`:

```ts
describe('no regression: text-only turn', () => {
  it('renders the assistant bubble for a plain message turn', () => {
    const trace = freshTrace();
    pi(trace, { type: 'message_start', message: { role: 'assistant' } });
    pi(trace, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello world' } });
    pi(trace, { type: 'message_end', message: { usage: { input: 10, output: 3, cost: { total: 0.0001 } } } });
    expect(trace.textContent).toContain('Hello world');
  });
});
```

- [ ] **Step 2: Run the full trace test file**

Run: `pnpm exec vitest run src/channels/playground/public/tabs/chat-trace.test.ts`
Expected: PASS — all Task 1–4 tests green.

- [ ] **Step 3: Build + full host suite (no regression elsewhere)**

Run: `pnpm run build && pnpm test 2>&1 | tail -3`
Expected: build clean (tsc), full suite green (existing count + the new trace tests).

- [ ] **Step 4: Manual smoke (optional, documented)**

The renderer is browser JS; the automated happy-dom tests cover the logic. For a live eyeball: open the Chat tab in the playground, send a message that triggers a `web_search` + a blocked `fetch_url` (e.g. ask it to fetch `http://192.168.64.1:3001/openai/v1/models`), and confirm: one card per tool, ✓ on the search, ✗ + red on the blocked fetch, query/url in the previews. (No deploy step needed beyond a browser refresh — static JS.)

- [ ] **Step 5: Commit**

```bash
git add src/channels/playground/public/tabs/chat-trace.test.ts
git commit -m "test(trace): no-regression coverage for text-only turns"
```

---

## Notes / invariants

- **Pure client-side.** No backend/SSE/DB/container change. A browser refresh deploys it; no host restart, no image rebuild.
- **DRY:** reuse `truncate`, `formatTracePreview`, `formatTracePayloadFull`, `finalizeTurn` — do not duplicate them. The new helpers defer to `formatTracePreview` for the default case.
- **Import safety:** `chat.js` must remain side-effect-free on import (only `let sse=null` + function declarations + exports) so the happy-dom test can import it. If a future edit adds module-level DOM access, the test's `@vitest-environment happy-dom` still provides `document`, but avoid network/`window.__pg` access at module scope.
- **Out of scope:** per-tool duration, persistence/replay, cross-agent view, backend changes, direct-chat trace, full renderer extraction (see spec Boundaries).
- **Parallel tool calls** each get their own `toolCardId`-keyed card — covered by a Task 2 test.
