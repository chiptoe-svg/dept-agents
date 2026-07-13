# A3 — File-Centric Member Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give members a new lean, inline chat tab (`member-chat.js`) focused on agent communication with first-class file attach/receive — attach any typical work file (docs/sheets/slides/images/data, 25 MB cap, executables blocked) and download agent-produced files inline — replacing the reused `simple` tab.

**Architecture:** One backend change generalizes the existing `POST /messages` attach handler from image/PDF-only to a typical-files allowlist (saved to the group's `attachments/` with a `[File: …]` text marker the agent reads; no document conversion). A new lean frontend component reuses the existing send/stream/download endpoints and mirrors `chat.js`'s proven SSE + attach + file-render patterns without the owner clutter. Member tabs gain a role-based `chat` mount (member vs owner) and drop `simple`.

**Tech Stack:** Node/pnpm host (TypeScript), vanilla ES-module playground frontend, vitest + `happy-dom` for frontend tests.

**Spec:** `docs/superpowers/specs/2026-07-12-a3-member-chat-design.md`.

## Global Constraints

- **Typical-files allowlist (server is the gate).** Accept only these extensions: `pdf, doc, docx, txt, rtf, md, odt, csv, tsv, xls, xlsx, ods, ppt, pptx, odp, key, png, jpg, jpeg, gif, webp, svg, heic, bmp, tiff, json, xml, yaml, yml`. Anything else (executables etc.) is rejected into the per-file error list and not written. Default-deny (an allowlist, not a blocklist).
- **25 MB total cap** preserved (existing behavior). Images keep the existing inline/vision path unchanged. PDFs keep their existing `[PDF: …]` marker unchanged.
- **No document conversion in A3** — the file lands in the workspace with a `[File: attachments/<name>]` marker; PDFs read via the existing `pdf-reader` container skill, images inline. Office files land raw. (docling/markitdown/vision are a later phase, as skills.)
- **No in-chat model picker.** The member chat shows a read-only "Running on: …" indicator from `GET /api/me/agent`'s `agent.modelProvider` (added in A2): `clemson`/null → "Clemson campus model (free)", `openai-codex`/`openai` → "Your ChatGPT", `anthropic` → "Department account".
- **`MEMBER_TABS === ['home', 'chat', 'persona', 'skills']`**, members land on `home`. The `chat` tab mounts `member-chat.js` for members and the existing `chat.js` for owners/TAs (role-based, like `home`). `simple` drops out of the member set. Owner/TA tabs, `chat.js`, and `simple.js` are unchanged.
- **Member-facing copy uses department vocabulary** — no "class"/"student"/"instructor".
- **Frontend tests:** first line `// @vitest-environment happy-dom`; import from the `.js` module; build DOM with `document.createElement`; mock `fetch`/`EventSource` with `vi`. Never import `app.js` in a test — test `tab-gating.js` (already extracted in A2).
- **Isolation unchanged:** `POST /messages` and the stream/download routes stay `requireGroupAccess`/`canReadDraft`-gated by folder; the new component only ever addresses the member's own `window.__pg.agent.folder`.
- Host build/test: `pnpm run build` clean and `pnpm test` green before a task is done (run them yourself). Clean any stray `groups/` fixture dirs your run creates (leave `_default_participant`, `owner_01`).
- Commit messages end (after a blank line) with:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01WXUAU8TQduy8SMSVWoNYvn
  ```

---

## File Structure

- **Modify `src/channels/playground/api-routes.ts`** (~lines 276–330) — generalize the attach loop's final `else` branch from "reject non-image/non-PDF" to an allowlist branch that saves the file + emits a `[File: …]` marker; add a `fileMarkers` array to the composed text.
- **Create `src/channels/playground/attachment-allowlist.ts`** + test — the extension allowlist + `isAllowedAttachment(name)` predicate (small, testable, importable by the handler and its test).
- **Create `src/channels/playground/public/tabs/member-chat.js`** — the lean member chat: pure render helpers + a `mountMemberChat(el)` that wires history/SSE/send using the existing endpoints (mirrors `chat.js`).
- **Create `src/channels/playground/public/tabs/member-chat.test.ts`** — happy-dom tests for the pure render helpers.
- **Modify `src/channels/playground/public/tab-gating.js`** — `MEMBER_TABS = ['home','chat','persona','skills']` (drop `simple`, add `chat`).
- **Modify `src/channels/playground/public/tab-gating.test.ts`** — update the expected member set.
- **Modify `src/channels/playground/public/app.js`** — `mounters.chat` becomes role-based (member → `mountMemberChat`, owner/TA → existing `mountChat`).
- **Create `docs/superpowers/reviews/2026-07-12-a3-verification.md`** (Task 4).

---

### Task 1: Backend — generalize attach to a typical-files allowlist

**Files:**
- Create: `src/channels/playground/attachment-allowlist.ts`, `src/channels/playground/attachment-allowlist.test.ts`
- Modify: `src/channels/playground/api-routes.ts` (the attach loop ~line 276–330)

**Interfaces:**
- Produces: `export const ATTACHMENT_ALLOWLIST: ReadonlySet<string>` (lowercase extensions) and `export function isAllowedAttachment(name: string): boolean` — true iff the file's extension is on the allowlist.

- [ ] **Step 1: Write the failing allowlist tests**

Create `src/channels/playground/attachment-allowlist.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isAllowedAttachment } from './attachment-allowlist.js';

describe('isAllowedAttachment', () => {
  it('accepts typical work files (case-insensitive)', () => {
    for (const n of ['a.pdf', 'b.DOCX', 'c.pptx', 'deck.KEY', 'data.csv', 'x.xlsx', 'notes.md', 'q.json'])
      expect(isAllowedAttachment(n)).toBe(true);
  });
  it('rejects executables and unknown types', () => {
    for (const n of ['evil.exe', 'run.sh', 'lib.dll', 'app.app', 'x.bat', 'y.msi', 'z', 'noext'])
      expect(isAllowedAttachment(n)).toBe(false);
  });
  it('rejects path-y or empty names safely', () => {
    expect(isAllowedAttachment('')).toBe(false);
    expect(isAllowedAttachment('../../etc/passwd')).toBe(false); // no allowed extension
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/channels/playground/attachment-allowlist.test.ts`
Expected: FAIL — `Cannot find module './attachment-allowlist.js'`.

- [ ] **Step 3: Implement the allowlist**

Create `src/channels/playground/attachment-allowlist.ts`:

```ts
/**
 * Typical work-file allowlist for member chat attachments. Default-deny:
 * only these extensions are accepted (executables/binaries are rejected by
 * omission). The server is the real gate; the frontend `accept=` is a hint.
 */
export const ATTACHMENT_ALLOWLIST: ReadonlySet<string> = new Set([
  // docs
  'pdf', 'doc', 'docx', 'txt', 'rtf', 'md', 'odt',
  // spreadsheets
  'csv', 'tsv', 'xls', 'xlsx', 'ods',
  // slides
  'ppt', 'pptx', 'odp', 'key',
  // images
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic', 'bmp', 'tiff',
  // data / text
  'json', 'xml', 'yaml', 'yml',
]);

export function isAllowedAttachment(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return false;
  const ext = name.slice(dot + 1).toLowerCase();
  return ATTACHMENT_ALLOWLIST.has(ext);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/channels/playground/attachment-allowlist.test.ts`
Expected: PASS.

- [ ] **Step 5: Generalize the attach handler's `else` branch**

In `src/channels/playground/api-routes.ts`:

1. Import the predicate near the other imports: `import { isAllowedAttachment } from './attachment-allowlist.js';`
2. Add a `fileMarkers` array beside `pdfMarkers` (~line 273):
   ```ts
   const pdfMarkers: string[] = [];
   const fileMarkers: string[] = [];
   ```
3. Replace the final `else` branch (currently `fileErrors.push(\`file[${i}]: unsupported mimeType ...\`)`) with an allowlist branch that mirrors the PDF branch's safe-name + save logic but emits a `[File: …]` marker:
   ```ts
   } else {
     // Any other allowlisted file type: save to attachments/ and reference
     // it by a text marker the agent reads from /workspace/agent/attachments/.
     // Off-allowlist (executables etc.) is rejected — default-deny.
     const providedName = f.name || `playground_${messageId}_${i}`;
     if (!isAllowedAttachment(providedName)) {
       fileErrors.push(`file[${i}]: blocked file type (${providedName})`);
       continue;
     }
     const fallbackName = `playground_${messageId}_${i}`;
     let safeName = providedName.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
     if (!isSafeAttachmentName(safeName)) safeName = fallbackName;
     const savePath = path.join(attachDir, safeName);
     try {
       fs.writeFileSync(savePath, buffer);
       fileMarkers.push(`[File: attachments/${safeName}]`);
     } catch (err) {
       fileErrors.push(`file[${i}]: save failed — ${(err as Error).message}`);
     }
   }
   ```
4. Include the new markers in the composed text (~line 324): change
   ```ts
   const composedText = [...pdfMarkers, text].filter(Boolean).join('\n');
   ```
   to
   ```ts
   const composedText = [...pdfMarkers, ...fileMarkers, text].filter(Boolean).join('\n');
   ```

Leave the `image/*` and `application/pdf` branches and the 25 MB cap unchanged.

- [ ] **Step 6: Add a handler test for the generalized behavior**

Find the existing test file for the messages/attach route (search: `grep -rl "messages" src/channels/playground/*.test.ts src/channels/playground/**/*.test.ts`). If one exists that posts attachments, extend it; otherwise add a focused test in a new `src/channels/playground/api-routes.attach.test.ts` that calls the route handler with a fake `files` array and asserts on the filesystem + the composed content. Mirror how the existing playground route tests build a request/session (read one first). Assertions:
- A `.csv` (allowlisted, non-image) → a file appears in `groups/<folder>/attachments/` and the emitted inbound content text contains `[File: attachments/<name>]`.
- A `.exe` (off-allowlist) → NO file written, and `attachmentErrors` includes a "blocked file type" entry.
- An `image/png` → still takes the inline path (content has `images[]`, no `[File: …]` marker for it).

> If wiring a full route test is impractical in this harness, at minimum unit-test the branch logic by extracting the per-file decision — but prefer a real route test mirroring the existing ones.

- [ ] **Step 7: Full build + test**

Run: `pnpm run build && pnpm test`
Expected: tsc clean; full suite green.

- [ ] **Step 8: Commit**

```bash
git add src/channels/playground/attachment-allowlist.ts src/channels/playground/attachment-allowlist.test.ts src/channels/playground/api-routes.ts
git add src/channels/playground/api-routes.attach.test.ts 2>/dev/null || true
git commit -m "feat(playground): accept typical work files as chat attachments (allowlist, [File:] marker)"
```

---

### Task 2: The lean member chat component

**Files:**
- Create: `src/channels/playground/public/tabs/member-chat.js`, `src/channels/playground/public/tabs/member-chat.test.ts`

**Interfaces:**
- Produces:
  - `renderMessage(host: HTMLElement, msg: ChatMsg): void` — pure; append one message bubble (user or agent), markdown text + any file cards.
  - `renderFileCard(host: HTMLElement, file: { name: string, url: string }): void` — pure; a download card/link.
  - `renderAttachChips(host: HTMLElement, files: Array<{ name: string }>, onRemove: (i: number) => void): void` — pure; the removable chips above the composer.
  - `modelLabel(modelProvider: string | null): string` — pure; the "Running on" text.
  - `mountMemberChat(el: HTMLElement): void` — wires history + SSE + send using the existing endpoints.
  - `ChatMsg = { role: 'user' | 'agent', text: string, files?: Array<{ name: string, url: string }> }`

**Reuse note for the implementer:** `chat.js` already implements the exact SSE consumption, base64 attach, and file-URL reconstruction this component needs. Before writing `mountMemberChat`, READ:
- `src/channels/playground/public/tabs/chat.js` lines ~300–340 (reconstructing file download URLs from `content.files` + message id → `/api/drafts/<folder>/files/<id>/<name>`) and the `EventSource('/api/drafts/<folder>/stream')` handling (search `EventSource` / `event:`),
- and lines ~419+ (the `attached[]` base64 pattern for `POST /messages`).
Mirror those exact request/event shapes; do NOT invent new ones. The composer POSTs `POST /api/drafts/<folder>/messages` with `{ text, files: [{ name, mimeType, base64 }] }`; history loads from `GET /api/drafts/<folder>/recent?limit=50`; live output streams from `GET /api/drafts/<folder>/stream`.

- [ ] **Step 1: Write the failing render tests**

Create `src/channels/playground/public/tabs/member-chat.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { renderMessage, renderFileCard, renderAttachChips, modelLabel } from './member-chat.js';

describe('renderMessage', () => {
  it('renders a user message with its text', () => {
    const host = document.createElement('div');
    renderMessage(host, { role: 'user', text: 'hello agent' });
    const bubble = host.querySelector('[data-role="user"]');
    expect(bubble).toBeTruthy();
    expect(host.textContent).toContain('hello agent');
  });
  it('renders an agent message with a file download card', () => {
    const host = document.createElement('div');
    renderMessage(host, { role: 'agent', text: 'here you go', files: [{ name: 'report.pdf', url: '/api/drafts/f/files/m/report.pdf' }] });
    expect(host.querySelector('[data-role="agent"]')).toBeTruthy();
    const link = host.querySelector('a[download]');
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe('/api/drafts/f/files/m/report.pdf');
    expect(link.textContent).toContain('report.pdf');
  });
});

describe('renderFileCard', () => {
  it('is a download link with the filename', () => {
    const host = document.createElement('div');
    renderFileCard(host, { name: 'data.csv', url: '/x/data.csv' });
    const a = host.querySelector('a[download]');
    expect(a.getAttribute('href')).toBe('/x/data.csv');
    expect(host.textContent).toContain('data.csv');
  });
});

describe('renderAttachChips', () => {
  it('renders one removable chip per file and fires onRemove', () => {
    const host = document.createElement('div');
    const onRemove = vi.fn();
    renderAttachChips(host, [{ name: 'a.docx' }, { name: 'b.png' }], onRemove);
    const chips = host.querySelectorAll('[data-chip]');
    expect(chips.length).toBe(2);
    expect(host.textContent).toContain('a.docx');
    host.querySelectorAll('[data-remove]')[0].click();
    expect(onRemove).toHaveBeenCalledWith(0);
  });
});

describe('modelLabel', () => {
  it('maps the model provider to a friendly label', () => {
    expect(modelLabel('clemson')).toContain('Clemson campus model');
    expect(modelLabel(null)).toContain('Clemson campus model');
    expect(modelLabel('openai-codex')).toContain('Your ChatGPT');
    expect(modelLabel('openai')).toContain('Your ChatGPT');
    expect(modelLabel('anthropic')).toContain('Department account');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/channels/playground/public/tabs/member-chat.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `member-chat.js` (pure render helpers + mount)**

Create `src/channels/playground/public/tabs/member-chat.js`. The pure helpers (complete):

```js
/**
 * Lean member chat — inline conversation with the member's agent, with
 * first-class file attach/receive. Reuses the existing send/stream/download
 * endpoints and mirrors chat.js's SSE + attach patterns, without the owner
 * controls (no model/provider dropdowns, export, or trace).
 */
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('data') || k === 'download') n.setAttribute(k, v === true ? '' : v);
    else n[k] = v;
  }
  for (const c of kids) n.append(c);
  return n;
}

export function modelLabel(modelProvider) {
  if (modelProvider === 'openai-codex' || modelProvider === 'openai') return 'Your ChatGPT';
  if (modelProvider === 'anthropic') return 'Department account';
  return 'Clemson campus model (free)';
}

/** Append one download card into `host`. */
export function renderFileCard(host, file) {
  const card = el('div', { class: 'mc-file-card', 'data-file': '' });
  card.append(el('a', { class: 'mc-file-link', href: file.url, download: file.name, text: `📎 ${file.name}` }));
  host.append(card);
}

/** Append one message bubble (user or agent) into `host`. */
export function renderMessage(host, msg) {
  const bubble = el('div', { class: `mc-msg mc-${msg.role}`, 'data-role': msg.role });
  if (msg.text) bubble.append(el('div', { class: 'mc-text', text: msg.text }));
  for (const f of msg.files || []) renderFileCard(bubble, f);
  host.append(bubble);
}

/** Render the removable attach chips above the composer. */
export function renderAttachChips(host, files, onRemove) {
  host.replaceChildren();
  files.forEach((f, i) => {
    const chip = el('span', { class: 'mc-chip', 'data-chip': '' });
    chip.append(el('span', { text: `📎 ${f.name}` }));
    chip.append(el('button', { 'data-remove': '', title: 'Remove', text: '×', onclick: () => onRemove(i) }));
    host.append(chip);
  });
}
```

Then add `mountMemberChat(el0)` in the same file. Build the shell (message list, attach chips row, a hidden multi `<input type="file">` with an `accept` hint listing the allowlisted types, a textarea, a Send button, and a small "Running on: …" indicator), then wire behavior mirroring `chat.js`:
- On mount: `folder = window.__pg.agent.folder`; fetch `GET /api/me/agent` for `modelProvider` → set the indicator via `modelLabel`; fetch `GET /api/drafts/${folder}/recent?limit=50`, map each stored message to a `ChatMsg` (reconstruct file URLs from `content.files` + id exactly as `chat.js` does at ~320–330) and `renderMessage` each.
- Open `new EventSource('/api/drafts/${folder}/stream')`; on each streamed agent message, map → `ChatMsg` → `renderMessage` (append or update); handle the `event: hello` and reconnect the same way `chat.js` does.
- Attach: clicking 📎 opens the file input; selected files are base64-encoded into an `attached[]` array (same pattern as `chat.js` ~419+) and shown via `renderAttachChips`.
- Send: `POST /api/drafts/${folder}/messages` `{ text, files: attached.map(a => ({ name, mimeType, base64 })) }`; on 200, render the user's message locally, clear the input + chips; surface `attachmentErrors` inline if present.
- Enter sends; Shift+Enter newlines. Empty state: a friendly prompt when there's no history.

Match the exact `recent`/`stream` payload shapes you read from `chat.js` — the render helpers above expect the normalized `ChatMsg` shape, and the mount function is responsible for the mapping.

- [ ] **Step 4: Run render tests to verify they pass**

Run: `pnpm exec vitest run src/channels/playground/public/tabs/member-chat.test.ts`
Expected: PASS (render helpers). (`mountMemberChat` is exercised live in Task 4.)

- [ ] **Step 5: Build**

Run: `pnpm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/channels/playground/public/tabs/member-chat.js src/channels/playground/public/tabs/member-chat.test.ts
git commit -m "feat(playground): lean member chat component (inline, file attach/receive)"
```

---

### Task 3: Wire the member chat into the tabs (drop `simple`)

**Files:**
- Modify: `src/channels/playground/public/tab-gating.js`, `src/channels/playground/public/tab-gating.test.ts`, `src/channels/playground/public/app.js`

**Interfaces:**
- Consumes: `mountMemberChat` from `./tabs/member-chat.js` (Task 2); `hasFullAccess` from `./tab-gating.js` (A2).

- [ ] **Step 1: Update the tab-gating test first**

In `src/channels/playground/public/tab-gating.test.ts`, change the member-set expectations from `['home','simple','persona','skills']` to `['home','chat','persona','skills']` (and any assertion that `MEMBER_TABS` starts with `home` stays true). Run it to see it fail against the current source.

Run: `pnpm exec vitest run src/channels/playground/public/tab-gating.test.ts`
Expected: FAIL.

- [ ] **Step 2: Update `MEMBER_TABS`**

In `src/channels/playground/public/tab-gating.js`, change:
```js
export const MEMBER_TABS = ['home', 'simple', 'persona', 'skills'];
```
to:
```js
export const MEMBER_TABS = ['home', 'chat', 'persona', 'skills'];
```

- [ ] **Step 3: Run the gating test to verify it passes**

Run: `pnpm exec vitest run src/channels/playground/public/tab-gating.test.ts`
Expected: PASS.

- [ ] **Step 4: Role-based `chat` mount in `app.js`**

In `src/channels/playground/public/app.js`:
1. Import: `import { mountMemberChat } from './tabs/member-chat.js';`
2. Change the `mounters.chat` entry from `chat: mountChat` to a role-based wrapper (mirroring the existing `home` wrapper from A2):
   ```js
   chat: (tabEl) => (hasFullAccess(window.__pg?.user?.role) ? mountChat(tabEl) : mountMemberChat(tabEl)),
   ```
   (Owners/TAs keep the existing `mountChat`; members get `mountMemberChat`.)

> The `chat` tab button + `#tab-chat` panel already exist in index.html (chat is in `TABS`), so no HTML change is needed. `simple` leaving `MEMBER_TABS` hides its button for members automatically via `applyTabGating`. The member `chat` button label is fine as "Chat".

- [ ] **Step 5: Full build + test**

Run: `pnpm run build && pnpm test`
Expected: tsc clean; full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/channels/playground/public/tab-gating.js src/channels/playground/public/tab-gating.test.ts src/channels/playground/public/app.js
git commit -m "feat(playground): members get the lean chat tab, drop the simple tab"
```

---

### Task 4: Live verification

**Files:** Create `docs/superpowers/reviews/2026-07-12-a3-verification.md`. Service label: `com.nanoclaw-v2-581fefa4`.

- [ ] **Step 1: Rebuild + restart** (`pnpm run build` then `launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-581fefa4`).

- [ ] **Step 2: Member tab set + served component**

Provision a throwaway member (`./bin/ncl users provision --display-name "A3 Canary" --email a3canary@clemson.edu`), redeem the token into a cookie jar (mirror prior live checks). Confirm the served `tab-gating.js` (`/playground/tab-gating.js`) has `MEMBER_TABS = ['home','chat','persona','skills']`, and that `member-chat.js` is served under `/playground/tabs/member-chat.js`. Load the member session in a browser (Playwright) and confirm the nav shows Home / Chat / Persona / Skills and the Chat tab renders the composer + "Running on: Clemson campus model (free)" indicator.

- [ ] **Step 3: Attach a typical file → agent reads it**

As the canary, send a message with a small `.csv` attached (via the UI or a scripted `POST /api/drafts/<folder>/messages` with `files:[{name:'data.csv',mimeType:'text/csv',base64:...}]`). Confirm: a file lands in `groups/<canary>/attachments/`, the agent's turn shows it read the file (reference the CSV contents in the reply), and the reply streams into the chat.

- [ ] **Step 4: Blocked type is rejected**

`POST` a message with a `.exe` attachment → confirm the response's `attachmentErrors` includes a "blocked file type" entry and no `.exe` is written to `attachments/`.

- [ ] **Step 5: Receive a file**

Ask the agent to produce a file (e.g., "write a two-line file called hello.txt and send it to me"). Confirm the agent's message renders an inline download card linking to `/api/drafts/<folder>/files/<id>/hello.txt`, and the download returns the file.

- [ ] **Step 6: Tear down the canary** (revoke token, delete group + fs, stop container — mirror prior canary teardown). Write the verification doc + commit.

---

## Self-Review

**1. Spec coverage:**
- Lean member chat (inline, SSE, attach chips, received-file cards, model indicator, no picker) → Task 2.
- Member tabs `['home','chat','persona','skills']`, role-based chat mount, drop `simple` → Task 3.
- Typical-files allowlist attach (save + `[File:]` marker, block executables, 25 MB, image/PDF unchanged) → Task 1.
- No document conversion → nothing added (files land raw; PDF via existing pdf-reader) — consistent with Task 1.
- Live proof incl. attach-read, blocked-type, receive → Task 4.

**2. Placeholder scan:** No TBD/TODO. The pure render helpers and the backend branch are complete code; `mountMemberChat` is specified as concrete behavior + explicit `chat.js` line references to mirror (the SSE/stream payload shapes live in unchanged code the implementer reads, not invented here) — this is a direction-to-existing-code, not a placeholder.

**3. Type consistency:** `ChatMsg` (`{ role, text, files? }`) is used consistently across `renderMessage`, its tests, and `mountMemberChat`'s mapping; `modelLabel(modelProvider)` matches A2's `/api/me/agent` `modelProvider`; `isAllowedAttachment(name)` / `ATTACHMENT_ALLOWLIST` names match between the module, its test, and the handler; `MEMBER_TABS` value matches between `tab-gating.js`, its test, and the Global Constraints.
