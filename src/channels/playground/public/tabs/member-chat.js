/**
 * Lean member chat — inline, ChatGPT-style conversation with the member's
 * agent, with first-class file attach/receive. Reuses the existing
 * send/stream/recent/file-download endpoints and mirrors chat.js's SSE +
 * attach + file-URL patterns, without the owner-only controls (no
 * model/provider dropdowns, export, or trace panel — see chat.js for those).
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
    chip.append(el('button', { type: 'button', 'data-remove': '', title: 'Remove', text: '×', onclick: () => onRemove(i) }));
    host.append(chip);
  });
}

// Mirrors the server-side allowlist in attachment-allowlist.ts (docs,
// spreadsheets, slides, images, data). This is a picker hint only — the
// server is the real gate, so a mismatch here is cosmetic, not a security
// issue. Keep in sync if that file's categories change.
const MEMBER_ATTACH_ACCEPT = [
  '.pdf', '.doc', '.docx', '.txt', '.rtf', '.md', '.odt',
  '.csv', '.tsv', '.xls', '.xlsx', '.ods',
  '.ppt', '.pptx', '.odp', '.key',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.heic', '.bmp', '.tiff',
  '.json', '.xml', '.yaml', '.yml',
].join(',');

/** Normalize a stored/streamed `content` field (string or {text}) to plain text. */
function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return content == null ? '' : JSON.stringify(content);
}

/**
 * /recent rows carry only filenames in content.files; reconstruct the
 * download URL the same way chat.js does at ~320-330: files are staged at
 * /api/drafts/<folder>/files/<messageId>/<filename>.
 */
function filesFromRecentContent(content, id, folder) {
  if (!content || !Array.isArray(content.files) || !id) return undefined;
  const files = content.files
    .filter((f) => typeof f === 'string')
    .map((filename) => ({
      name: filename,
      url: `/api/drafts/${encodeURIComponent(folder)}/files/${encodeURIComponent(id)}/${encodeURIComponent(filename)}`,
    }));
  return files.length > 0 ? files : undefined;
}

/** Map one /recent row to the normalized ChatMsg shape. */
function chatMsgFromRecent(m, folder) {
  return {
    role: 'agent',
    text: textFromContent(m.content),
    files: filesFromRecentContent(m.content, m.id, folder),
  };
}

/**
 * Map one live SSE `message` event payload to the normalized ChatMsg shape.
 * Live pushes already arrive with files: [{filename, url}] (adapter.ts
 * stages them and builds the URL server-side) — no reconstruction needed.
 */
function chatMsgFromSse(data) {
  const files = Array.isArray(data.files)
    ? data.files
        .filter((f) => f && typeof f.filename === 'string' && typeof f.url === 'string')
        .map((f) => ({ name: f.filename, url: f.url }))
    : undefined;
  return {
    role: 'agent',
    text: textFromContent(data.content),
    files: files && files.length > 0 ? files : undefined,
  };
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error);
    r.onload = () => {
      const result = r.result;
      const idx = typeof result === 'string' ? result.indexOf('base64,') : -1;
      if (idx < 0) return reject(new Error('FileReader did not return a data URL'));
      resolve(result.slice(idx + 'base64,'.length));
    };
    r.readAsDataURL(file);
  });
}

let sse = null; // single EventSource per mount, mirrors chat.js's module-level singleton

/** Tab mount entry: wires history load + SSE + send using the existing endpoints. */
export function mountMemberChat(host) {
  const folder = window.__pg.agent.folder;

  host.replaceChildren();

  const modelValueEl = el('b', { text: modelLabel(null) });
  const modelChip = el('div', { class: 'mc-model-chip' }, el('span', { text: 'Running on: ' }), modelValueEl);

  const log = el('div', { class: 'mc-log' });
  const emptyState = el('div', { class: 'mc-empty', text: "Ask your agent anything — attach a file and it can read it, or hand a file back to you." });
  log.append(emptyState);

  const chipsRow = el('div', { class: 'mc-chips-row' });

  const fileInput = el('input', {
    type: 'file',
    multiple: true,
    hidden: true,
    accept: MEMBER_ATTACH_ACCEPT,
  });
  const attachBtn = el('button', {
    type: 'button',
    class: 'mc-attach-btn',
    title: 'Attach a file',
    text: '📎',
    onclick: () => fileInput.click(),
  });
  const textarea = el('textarea', {
    class: 'mc-input',
    rows: 1,
    placeholder: 'Message your agent…',
    autocomplete: 'off',
  });
  const sendBtn = el('button', { type: 'button', class: 'mc-send-btn', text: 'Send' });
  const inputRow = el('div', { class: 'mc-input-row' }, attachBtn, fileInput, textarea, sendBtn);
  const hint = el('div', { class: 'mc-hint', text: 'Large slide decks: share via Google or attach a PDF export instead.' });
  const composer = el('div', { class: 'mc-composer' }, chipsRow, inputRow, hint);

  host.append(modelChip, log, composer);

  // --- attach state ---
  const attached = []; // [{ file }] — base64 read lazily at send time (chat.js pattern)

  function updateChips() {
    renderAttachChips(chipsRow, attached.map((a) => ({ name: a.file.name })), (i) => {
      attached.splice(i, 1);
      updateChips();
    });
  }

  function appendMessage(msg) {
    const placeholder = log.querySelector('.mc-empty');
    if (placeholder) placeholder.remove();
    renderMessage(log, msg);
    log.scrollTop = log.scrollHeight;
  }

  function appendNote(text) {
    const placeholder = log.querySelector('.mc-empty');
    if (placeholder) placeholder.remove();
    log.append(el('div', { class: 'mc-note', text }));
    log.scrollTop = log.scrollHeight;
  }

  fileInput.addEventListener('change', () => {
    // Total-attachment size pre-check (mirrors chat.js ~459-465): reject
    // before base64-encoding so a member doesn't buffer + upload hundreds
    // of MB just to get the server's "aborted" back. File TYPE is NOT
    // gated here — the accept= hint plus the server allowlist are the gate.
    const TWENTY_FIVE_MB = 25 * 1024 * 1024;
    for (const file of fileInput.files) {
      const remaining = TWENTY_FIVE_MB - attached.reduce((sum, a) => sum + a.file.size, 0);
      if (file.size > remaining) {
        appendNote(`${file.name} (${Math.round(file.size / 1024)} KB) skipped — total attachments would exceed 25 MB`);
        continue;
      }
      attached.push({ file });
    }
    fileInput.value = '';
    updateChips();
  });

  async function send() {
    const text = textarea.value.trim();
    if (!text && attached.length === 0) return;
    appendMessage({ role: 'user', text: text || `(${attached.length} attachment${attached.length === 1 ? '' : 's'})` });
    textarea.value = '';

    // Read pending files to base64 at send time, not attach time — avoids
    // double-buffering for files the member immediately removes.
    let files;
    try {
      files = await Promise.all(
        attached.map(async ({ file }) => ({
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          base64: await readFileAsBase64(file),
        })),
      );
    } catch (err) {
      appendNote(`Attachment encode failed: ${String(err)}`);
      return;
    }

    try {
      const r = await fetch(`/api/drafts/${encodeURIComponent(folder)}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ text, files }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        appendNote(`Send failed: ${err.error || r.status}`);
        return;
      }
      const data = await r.json().catch(() => ({}));
      if (Array.isArray(data.attachmentErrors)) {
        for (const msg of data.attachmentErrors) appendNote(`Attachment issue: ${msg}`);
      }
      attached.length = 0;
      updateChips();
    } catch {
      appendNote('Send failed — check your connection.');
    }
  }

  sendBtn.addEventListener('click', send);
  // ↵ sends, ⇧↵ inserts a newline — matches chat.js's convention.
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  // --- model indicator ---
  fetch('/api/me/agent', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      modelValueEl.textContent = modelLabel(data && data.agent ? data.agent.modelProvider : null);
    })
    .catch(() => {
      // Silently keep the default label — chat still functions.
    });

  // --- history + live stream ---
  // Highest outbound seq rendered so far — used both to dedupe the initial
  // /recent load and to bound the SSE reconnect catch-up (chat.js pattern).
  let lastSeenSeq = 0;

  fetch(`/api/drafts/${encodeURIComponent(folder)}/recent?limit=50`, { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : { messages: [] }))
    .then(({ messages }) => {
      // Same seq guard as catchUpFromRecent — if the SSE 'open' catch-up
      // (limit=20, sinceSeq=0) resolves before this slower limit=50 fetch,
      // the overlapping tail would otherwise render twice. Skipping rows
      // already seen (JS handles each response atomically) makes either
      // resolve-order safe.
      for (const m of messages || []) {
        if (m.seq <= lastSeenSeq) continue;
        lastSeenSeq = m.seq;
        appendMessage(chatMsgFromRecent(m, folder));
      }
    })
    .catch(() => {
      // History is best-effort — live stream still works without it.
    });

  if (sse) {
    try { sse.close(); } catch { /* ignore */ }
  }
  sse = new EventSource(`/api/drafts/${encodeURIComponent(folder)}/stream`);

  // Reconnect catch-up: the host's SSE pushes are fire-and-forget, so any
  // reply that lands while the EventSource is reconnecting is otherwise
  // lost. Hitting /recent on every 'open' (initial connect AND reconnect)
  // fills the gap — same pattern as chat.js's wireSse.
  const catchUpFromRecent = async () => {
    try {
      const r = await fetch(
        `/api/drafts/${encodeURIComponent(folder)}/recent?limit=20&sinceSeq=${lastSeenSeq}`,
        { credentials: 'same-origin' },
      );
      if (!r.ok) return;
      const { messages } = await r.json();
      for (const m of messages || []) {
        if (m.seq <= lastSeenSeq) continue;
        lastSeenSeq = m.seq;
        appendMessage(chatMsgFromRecent(m, folder));
      }
    } catch {
      // Network blip — the next reconnect retries.
    }
  };
  sse.addEventListener('open', () => { catchUpFromRecent(); });

  // The server also emits a plain `event: hello` handshake line with no
  // listener attached here — same as chat.js, it's inert; 'open' already
  // drives the reconnect catch-up.
  sse.addEventListener('message', (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    if (data.kind === 'trace') return; // no trace panel in the lean member chat
    appendMessage(chatMsgFromSse(data));
  });
  sse.addEventListener('error', () => {
    // Auto-reconnect by browser default; no action needed.
  });
}
