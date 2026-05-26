import { showDraftBanner } from '../draft-banner.js';

let sse = null; // single EventSource per agent

/**
 * Re-fetch the Chat tab's provider/model dropdowns. Called by the tab
 * switcher every time the user lands on Chat so whitelist changes (made
 * in the Models tab) take effect without a page reload.
 */
export function refreshChatModels(el) {
  const folder = window.__pg && window.__pg.agent && window.__pg.agent.folder;
  if (!folder || !el || !el.querySelector('#provider-sel')) return;
  loadModelDropdowns(el, folder);
}

export function mountChat(el) {
  const folder = window.__pg.agent.folder;
  const agentName = window.__pg.agent.name;

  el.innerHTML = `
    <div class="chat-toolbar">
      <span>Chat with: <strong>${escapeHtml(agentName)}</strong></span>
      <div class="mode-toggle" role="tablist" aria-label="Chat mode">
        <button type="button" id="mode-agent" class="mode-btn active" role="tab" aria-selected="true">Agent</button>
        <button type="button" id="mode-direct" class="mode-btn" role="tab" aria-selected="false" title="Direct LLM call — no agent system prompt, skills, or tools">Chat (no agent)</button>
      </div>
      <span class="spacer"></span>
      <label>provider <select id="provider-sel"></select></label>
      <label>model <select id="model-sel"></select></label>
      <label class="reasoning-label" title="Direct-mode only. Higher = more reasoning tokens (charged as output).">reasoning
        <select id="reasoning-sel">
          <option value="default">default</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
        </select>
      </label>
      <a id="export-btn" class="btn btn-ghost" title="Download your agent as a zip — works in Claude Code, OpenAI Codex, Gemini CLI, and more">Export ↓</a>
    </div>
    <div class="chat-layout">
      <div class="chat-column">
        <ul id="chat-log" class="chat-log"></ul>
        <form id="chat-form">
          <div id="attach-chips" class="attach-chips"></div>
          <div class="chat-input-row">
            <label class="attach-btn" title="Attach image or PDF">
              📎
              <input id="attach-input" type="file" accept="image/*,application/pdf" multiple hidden>
            </label>
            <textarea id="chat-input" rows="1" placeholder="ask your agent…" autocomplete="off"></textarea>
            <button type="submit" class="btn btn-primary">Send</button>
          </div>
          <span class="send-hint"><kbd>↵</kbd> to send · <kbd>⇧↵</kbd> newline</span>
        </form>
      </div>
      <aside class="trace-panel">
        <header class="trace-header">
          <span class="label">Trace</span>
          <button id="trace-clear-btn" class="btn btn-ghost" type="button">Clear</button>
        </header>
        <ul id="trace-log" class="trace-log">
          <li class="trace-empty">Tool calls, system events, and non-chat agent output will appear here as the agent works.</li>
        </ul>
      </aside>
    </div>
  `;

  loadModelDropdowns(el, folder);
  wireSse(el, folder);
  wireChatForm(el, folder);
  wireTraceClear(el);
  el.querySelector('#export-btn').href = `/api/drafts/${folder}/export`;
}

function loadModelDropdowns(el, folder) {
  fetch(`/api/drafts/${folder}/models`, { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : { catalog: [], allowedModels: [] }))
    .then((data) => {
      const provSel = el.querySelector('#provider-sel');
      const modelSel = el.querySelector('#model-sel');

      // Merge curated catalog entries with live-discovered entries
      // (provider /v1/models that aren't in BUILTIN_ENTRIES — e.g. extra
      // mlx-omni-server models like Qwen3.6-27B or gemma-4-31B). Without
      // this merge, a whitelisted discovered model would silently fail
      // to appear in the dropdown — the user checked it in the Models tab
      // but couldn't actually select it for chat.
      const catalog = data.catalog || [];
      const discovered = (data.discovered || []).map((d) => ({ provider: d.provider, id: d.id }));
      const combined = [...catalog, ...discovered];
      // Stash the merged catalog so appendAgentTraceCall (called from the SSE
      // handler in wireSse — a separate scope) can look up cost fields by
      // provider+model when rendering an agent-mode call entry.
      if (window.__pg) window.__pg.catalog = combined;
      const allow = (data.allowedModels && data.allowedModels.length > 0)
        ? new Set(data.allowedModels.map((a) => `${a.provider}/${a.model}`))
        : null;
      const visible = allow ? combined.filter((m) => allow.has(`${m.provider}/${m.id}`)) : combined;

      // Filter providers by class-controls — owner sees everything;
      // students see only what the instructor authorized.
      const ac = window.__pg && window.__pg.activeClass;
      const isOwner = window.__pg && window.__pg.user && window.__pg.user.role === 'owner';
      // v2 shape: providers is a map of { allow, provideDefault, allowByo }.
      const providerAllowed = isOwner || !ac
        ? null
        : (p) => !!(ac.providers && ac.providers[p] && ac.providers[p].allow);
      // Hide providers the host can't authenticate (no API key / OAuth, or
      // the local server is offline) — selecting one would only produce a
      // failed call. Applies to everyone, owner included. A provider absent
      // from the map stays visible (defensive: don't hide on partial data).
      const providerAuth = data.providerAuth || {};
      const providers = [...new Set(visible.map((m) => m.provider))].filter(
        (p) => (!providerAllowed || providerAllowed(p)) && providerAuth[p] !== false,
      );
      provSel.innerHTML = '';
      for (const p of providers) provSel.add(new Option(p, p));

      // Pre-select the currently active provider+model returned by the API,
      // falling back to the first catalog entries when none is set. Without
      // this the dropdowns default to whatever happens to be first alphabetically
      // (`claude` / `claude-haiku-4-5`), misrepresenting agents currently
      // configured for a different provider — confusing AND a footgun, since
      // clicking elsewhere then `Apply` would silently rewrite the active model.
      const active = data.activeModel;
      if (active && providers.includes(active.provider)) {
        provSel.value = active.provider;
      }

      const renderModels = () => {
        modelSel.innerHTML = '';
        for (const m of visible.filter((mm) => mm.provider === provSel.value)) {
          modelSel.add(new Option(m.displayName || m.id, m.id));
        }
        if (active && active.provider === provSel.value) {
          // Use Array.from to test for membership without triggering a change event.
          const ids = Array.from(modelSel.options).map((o) => o.value);
          if (ids.includes(active.model)) modelSel.value = active.model;
        }
      };
      // Track last-confirmed provider so a cancelled switch can revert the select.
      let lastProvider = provSel.value;
      provSel.addEventListener('change', async () => {
        const newProvider = provSel.value;
        if (newProvider === lastProvider) {
          renderModels();
          return;
        }
        const log = el.querySelector('#chat-log');
        // Only warn when there's a live conversation to lose — switching on
        // a fresh chat costs nothing, so don't pop a modal for it.
        if (log && log.querySelector('.msg.user, .msg.agent')) {
          const ok = await showProviderSwitchModal(lastProvider, newProvider);
          if (!ok) {
            provSel.value = lastProvider;
            return;
          }
        }
        try {
          const r = await fetch(`/api/drafts/${folder}/provider`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ provider: newProvider }),
          });
          if (!r.ok) throw new Error(`status ${r.status}`);
          lastProvider = newProvider;
          renderModels();
          // Fresh container = fresh conversation. Clear the chat log.
          const log = el.querySelector('#chat-log');
          if (log) log.innerHTML = '';
          appendSystemNote(log, `— provider switched to ${newProvider}; container respawning —`);
        } catch (err) {
          appendSystemNote(el.querySelector('#chat-log'), `Provider switch failed: ${String(err)}`);
          provSel.value = lastProvider;
        }
      });
      renderModels();

      // Track last-confirmed model so a cancelled switch can revert the select.
      let lastModel = modelSel.value;
      modelSel.addEventListener('change', async () => {
        const log = el.querySelector('#chat-log');
        const newModel = modelSel.value;
        if (newModel === lastModel) return;

        // In agent mode the model is persisted to container.json +
        // agent_groups.model. The codex/local provider re-reads container.json
        // each turn, so a same-provider switch applies on the next message —
        // no respawn, conversation intact. The claude provider freezes its
        // model at container spawn, so switching it needs a respawn: warn
        // first and clear the dropped conversation.
        // In direct mode the dropdown directly controls the request body, no
        // persisted state changes and no container involved.
        const isAgentMode = el.querySelector('#mode-agent')?.classList.contains('active');
        if (isAgentMode) {
          const needsRespawn = provSel.value === 'claude';
          // Only warn (respawn case) when there's a live conversation to lose.
          if (needsRespawn && log.querySelector('.msg.user, .msg.agent')) {
            const ok = await showModelSwitchModal(lastModel, newModel);
            if (!ok) {
              modelSel.value = lastModel;
              return;
            }
          }
          try {
            const r = await fetch(`/api/drafts/${folder}/active-model`, {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ provider: provSel.value, model: newModel }),
            });
            if (!r.ok) throw new Error(`status ${r.status}`);
            lastModel = newModel;
            if (needsRespawn) {
              log.replaceChildren();
              appendSystemNote(log, `— model switched to ${newModel}; container respawning —`);
            } else {
              appendChatNote(log, `— model switched to ${newModel}; next reply will use it —`);
            }
          } catch (err) {
            appendChatNote(log, `Model switch failed: ${String(err)}`);
            modelSel.value = lastModel;
            return;
          }
        } else {
          lastModel = newModel;
          appendChatNote(log, `— model changed to ${newModel}; next reply will use it —`);
        }
        // Pulse the dropdown briefly to signal the change.
        modelSel.classList.add('model-changed');
        setTimeout(() => modelSel.classList.remove('model-changed'), 1500);
      });
    })
    .catch(() => {
      // Silently swallow — chat still functions without the dropdowns.
    });
}

function wireSse(el, folder) {
  if (sse) {
    try { sse.close(); } catch { /* ignore */ }
  }
  sse = new EventSource(`/api/drafts/${folder}/stream`);
  const log = el.querySelector('#chat-log');
  const trace = el.querySelector('#trace-log');
  // Clear trace empty-state on first event of any kind.
  let traceEmpty = trace.querySelector('.trace-empty');

  sse.addEventListener('message', (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    if (data.kind === 'trace') {
      if (traceEmpty) { traceEmpty.remove(); traceEmpty = null; }
      appendTraceEvent(trace, data.content || data);
    } else {
      // Chat-kind agent reply. Mirror the bubble's provider/model/tokens
      // footer into the trace pane so a plain hello→hi turn (no tool calls,
      // no system events) still shows the underlying LLM call — matches
      // direct-mode's appendDirectTraceCall behavior.
      appendAgentReply(log, data);
      if (data.provider && data.model) {
        if (traceEmpty) { traceEmpty.remove(); traceEmpty = null; }
        appendAgentTraceCall(trace, data);
      }
    }
  });
  sse.addEventListener('error', () => {
    // Auto-reconnect by browser default; no action needed.
  });
}

function wireChatForm(el, folder) {
  const form = el.querySelector('#chat-form');
  const input = el.querySelector('#chat-input');
  const log = el.querySelector('#chat-log');

  // Chat mode toggle. Agent = existing playground flow (POST messages → SSE
  // back). Direct = POST /api/direct-chat with conversation history,
  // synchronous reply with token usage inline.
  let currentMode = 'agent';
  const directHistory = []; // [{ role: 'user'|'assistant', content }]
  const modeAgentBtn = el.querySelector('#mode-agent');
  const modeDirectBtn = el.querySelector('#mode-direct');
  function setMode(mode) {
    currentMode = mode;
    modeAgentBtn.classList.toggle('active', mode === 'agent');
    modeAgentBtn.setAttribute('aria-selected', mode === 'agent');
    modeDirectBtn.classList.toggle('active', mode === 'direct');
    modeDirectBtn.setAttribute('aria-selected', mode === 'direct');
    input.placeholder = mode === 'agent' ? 'ask your agent…' : 'direct LLM call — no agent, no skills, no tools';
  }
  modeAgentBtn.addEventListener('click', () => setMode('agent'));
  modeDirectBtn.addEventListener('click', () => setMode('direct'));

  // ↵ submits, Shift+↵ inserts a newline. Matches the convention in
  // Telegram, Slack, iMessage. ⌘↵ / Ctrl-↵ also still submits for muscle
  // memory from the previous behavior.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  // Attachment state: each entry is { file, base64 } where base64 is filled
  // lazily so big files don't double-buffer in memory at click time.
  const attached = [];
  const chipsEl = el.querySelector('#attach-chips');
  const attachInput = el.querySelector('#attach-input');

  function renderChips() {
    chipsEl.innerHTML = '';
    for (let i = 0; i < attached.length; i++) {
      const { file } = attached[i];
      const chip = document.createElement('span');
      chip.className = 'attach-chip';
      chip.innerHTML = `<span class="attach-name">${escapeHtml(file.name)}</span><span class="attach-size">${Math.round(file.size / 1024)} KB</span><button type="button" class="attach-remove" aria-label="Remove">×</button>`;
      chip.querySelector('.attach-remove').addEventListener('click', () => {
        attached.splice(i, 1);
        renderChips();
      });
      chipsEl.appendChild(chip);
    }
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

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  attachInput.addEventListener('change', () => {
    const TWENTY_FIVE_MB = 25 * 1024 * 1024;
    const remaining = TWENTY_FIVE_MB - attached.reduce((sum, a) => sum + a.file.size, 0);
    for (const file of attachInput.files) {
      if (file.size > remaining) {
        appendSystemNote(log, `${file.name} (${Math.round(file.size / 1024)} KB) skipped — total attachments would exceed 25 MB`);
        continue;
      }
      const allowed = file.type.startsWith('image/') || file.type === 'application/pdf';
      if (!allowed) {
        appendSystemNote(log, `${file.name} (${file.type || 'unknown'}) skipped — only images and PDFs supported`);
        continue;
      }
      attached.push({ file, base64: null });
    }
    attachInput.value = '';
    renderChips();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text && attached.length === 0) return;
    appendUserBubble(log, text || `(${attached.length} attachment${attached.length === 1 ? '' : 's'})`);
    input.value = '';

    if (currentMode === 'direct') {
      // Direct LLM mode — bypass the agent entirely. No system prompt, no
      // skills, no tools. Attachments are not yet supported in direct
      // mode (would need to be forwarded as image_url content blocks);
      // skip them with a note if the user dropped files in here.
      if (attached.length > 0) {
        appendSystemNote(log, 'Attachments are not yet wired in direct mode — text-only sends through.');
        attached.length = 0;
        renderChips();
      }
      directHistory.push({ role: 'user', content: text });
      const provSel = el.querySelector('#provider-sel');
      const modelSel = el.querySelector('#model-sel');
      const trace = el.querySelector('#trace-log');
      startNewTurn(trace);
      const traceLi = appendDirectTraceCall(trace, provSel.value, modelSel.value, directHistory.length);
      // Client-side timing — direct-chat.ts doesn't return latencyMs (it's a
      // synchronous HTTP round-trip) so we measure wall-clock from the fetch
      // dispatch. Includes proxy + upstream + parse, which is what the user
      // actually waited for. Mirrors how agent-mode latencyMs is reported.
      const startedAt = Date.now();
      try {
        const reasoningSel = el.querySelector('#reasoning-sel');
        const reasoningEffort = reasoningSel && reasoningSel.value !== 'default' ? reasoningSel.value : undefined;
        const r = await fetch('/api/direct-chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            provider: provSel.value,
            model: modelSel.value,
            messages: directHistory,
            agentFolder: folder,
            ...(reasoningEffort ? { reasoningEffort } : {}),
          }),
        });
        const latencyMs = Date.now() - startedAt;
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          appendSystemNote(log, `Direct chat failed: ${err.error || r.status}`);
          finalizeDirectTraceCall(traceLi, { error: err.error || `HTTP ${r.status}`, latencyMs });
          return;
        }
        const data = await r.json();
        directHistory.push({ role: 'assistant', content: data.text });
        appendDirectReply(log, data);
        finalizeDirectTraceCall(traceLi, { ...data, latencyMs });
      } catch (err) {
        appendSystemNote(log, `Direct chat failed: ${String(err)}`);
        finalizeDirectTraceCall(traceLi, { error: String(err), latencyMs: Date.now() - startedAt });
      }
      return;
    }

    // Agent mode — start a new turn group in the trace pane.
    startNewTurn(el.querySelector('#trace-log'));

    // Read pending files to base64. Done at send time, not at attach time,
    // to avoid double-buffering for files the user might immediately remove.
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
      appendSystemNote(log, `Attachment encode failed: ${String(err)}`);
      return;
    }

    // Clear attachments only after a successful upload; if the request
    // fails the user keeps their chips and can retry.
    try {
      const r = await fetch(`/api/drafts/${folder}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ text, files }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        appendSystemNote(log, `Send failed: ${err.error || r.status}`);
        return;
      }
      const data = await r.json().catch(() => ({}));
      if (data.attachmentErrors) {
        for (const msg of data.attachmentErrors) appendSystemNote(log, `Attachment issue: ${msg}`);
      }
      attached.length = 0;
      renderChips();
    } catch {
      appendSystemNote(log, 'Send failed — check connection.');
    }
  });
}

function appendDirectReply(log, data) {
  const li = document.createElement('li');
  li.className = 'bubble bubble-agent bubble-direct';
  const text = data.text || '(empty reply)';
  const cost =
    data.costUsd < 0.001 ? `$${data.costUsd.toFixed(5)}` : `$${data.costUsd.toFixed(4)}`;
  const cachedNote = data.tokensCached > 0 ? ` (${data.tokensCached} cached)` : '';
  // Split reasoning tokens from visible output so students see where the
  // output cost actually went. tokensReasoning is already counted in
  // tokensOut by the API contract, so we display "X reasoning of Y out"
  // rather than treating them as separate buckets.
  const reasoning = data.tokensReasoning || 0;
  const outNote = reasoning > 0 ? `${data.tokensOut} out (${reasoning} reasoning)` : `${data.tokensOut} out`;
  const effortBadge = data.reasoningEffort ? `<span class="reasoning-badge">reasoning: ${data.reasoningEffort}</span>` : '';
  li.innerHTML = `
    <div class="bubble-text"></div>
    <div class="bubble-meta">
      <code>${escapeHtml(data.model)}</code> ${effortBadge} ·
      ${data.tokensIn} in${escapeHtml(cachedNote)} · ${outNote} ·
      <strong>${cost}</strong>
    </div>
  `;
  li.querySelector('.bubble-text').textContent = text;
  log.appendChild(li);
  log.scrollTop = log.scrollHeight;
}

function wireTraceClear(el) {
  el.querySelector('#trace-clear-btn').addEventListener('click', () => {
    const trace = el.querySelector('#trace-log');
    trace.innerHTML = '<li class="trace-empty">Trace cleared.</li>';
    trace._currentTurnUl = null;
    trace._piState = null;
  });
}

/**
 * Finalize the previous turn: sum data-* attrs from child <li>s and fill in
 * the footer. Called by startNewTurn when a new user message is submitted.
 */
function finalizeTurn(turnEl) {
  if (!turnEl) return;
  const foot = turnEl.querySelector('.trace-turn-foot');
  if (!foot) return;
  // Codex's `tokenUsage.total` (which we surface as agent_call) is the
  // THREAD CUMULATIVE total — every call codex has ever made on this
  // thread since it started, not the current turn's cost. Per-turn cost
  // is the sum of model_call deltas within this turn.
  //
  // For claude (single API call per user turn), no per-call model_call
  // events fire — the agent_call IS the turn. Detect that case and fall
  // back to agent_call's tokens.
  const modelCalls = turnEl.querySelectorAll('.trace-model-call');
  const agentCall = turnEl.querySelector('.trace-agent-call');
  let tokensIn = 0, tokensOut = 0, tokensCached = 0, tokensReasoning = 0, cost = 0;
  if (modelCalls.length > 0) {
    // Codex-style turn — sum the per-call deltas.
    for (const li of modelCalls) {
      tokensIn       += parseFloat(li.dataset.tokensIn       || '0') || 0;
      tokensOut      += parseFloat(li.dataset.tokensOut      || '0') || 0;
      tokensCached   += parseFloat(li.dataset.tokensCached   || '0') || 0;
      tokensReasoning += parseFloat(li.dataset.tokensReasoning || '0') || 0;
      cost           += parseFloat(li.dataset.cost           || '0') || 0;
    }
  } else if (agentCall) {
    // Claude-style turn — agent_call IS the turn (single API call).
    tokensIn  = parseFloat(agentCall.dataset.tokensIn  || '0') || 0;
    tokensOut = parseFloat(agentCall.dataset.tokensOut || '0') || 0;
    cost      = parseFloat(agentCall.dataset.cost      || '0') || 0;
  } else {
    // Neither — non-LLM events only (tool calls without a model summary).
    for (const li of turnEl.querySelectorAll('[data-cost]')) {
      cost += parseFloat(li.dataset.cost || '0') || 0;
    }
  }
  if (tokensIn === 0 && tokensOut === 0 && cost === 0) {
    foot.textContent = '(no usage)';
    return;
  }
  const parts = [];
  if (tokensIn > 0) parts.push(`${tokensIn} in`);
  if (tokensCached > 0) parts.push(`${tokensCached} cached`);
  // Reasoning is a subset of output tokens, not a separate bucket — show it
  // in parens after `out`, matching how each model-call row renders it.
  if (tokensOut > 0) {
    parts.push(tokensReasoning > 0 ? `${tokensOut} out (${tokensReasoning} reasoning)` : `${tokensOut} out`);
  }
  if (cost > 0) parts.push(cost < 0.001 ? `$${cost.toFixed(5)}` : `$${cost.toFixed(4)}`);
  foot.textContent = `turn total: ${parts.join(' · ')}`;
}

/**
 * Start a new turn group in the trace pane. Finalizes the previous turn if
 * one exists, then appends a new .trace-turn container. Returns the inner
 * <ul> that events should be appended to.
 */
function startNewTurn(trace) {
  if (!trace) return null;
  // Remove the empty-state placeholder if present.
  const placeholder = trace.querySelector('.trace-empty');
  if (placeholder) placeholder.remove();

  // Finalize the previous turn.
  if (trace._currentTurnUl) {
    finalizeTurn(trace._currentTurnUl.closest('.trace-turn'));
  }

  const turnLi = document.createElement('li');
  turnLi.className = 'trace-turn';

  const head = document.createElement('div');
  head.className = 'trace-turn-head';
  head.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  turnLi.appendChild(head);

  const ul = document.createElement('ul');
  ul.className = 'trace-turn-events';
  turnLi.appendChild(ul);

  const foot = document.createElement('div');
  foot.className = 'trace-turn-foot';
  turnLi.appendChild(foot);

  trace.appendChild(turnLi);
  trace._currentTurnUl = ul;
  trace.scrollTop = trace.scrollHeight;
  return ul;
}

function appendUserBubble(log, text) {
  const li = document.createElement('li');
  li.className = 'msg user';
  li.textContent = text;
  log.appendChild(li);
  log.scrollTop = log.scrollHeight;
}

function appendAgentReply(log, data) {
  const li = document.createElement('li');
  li.className = 'msg agent';
  // Content may be a string or an object — handle both.
  let text;
  if (typeof data.content === 'string') text = data.content;
  else if (data.content && typeof data.content === 'object' && typeof data.content.text === 'string') text = data.content.text;
  else text = JSON.stringify(data.content);
  li.textContent = text;

  // Cost/speed annotation when fields are present.
  const parts = [];
  if (data.provider && data.model) parts.push(`${data.provider}/${data.model}`);
  if (data.tokens && typeof data.tokens.input === 'number' && typeof data.tokens.output === 'number') {
    parts.push(`${data.tokens.input + data.tokens.output} tok`);
  }
  if (typeof data.latencyMs === 'number') parts.push(`${(data.latencyMs / 1000).toFixed(1)}s`);
  if (parts.length > 0) {
    const annot = document.createElement('div');
    annot.className = 'cost-annot';
    annot.textContent = parts.join(' · ');
    li.appendChild(annot);
  }
  log.appendChild(li);
  log.scrollTop = log.scrollHeight;
}

function appendTraceEvent(trace, data) {
  // pi_event wrapper: { type: 'pi_event', event: <native pi-agent-core event> }
  // Route to the pi renderer and return early — existing paths are unaffected.
  if (data.type === 'pi_event') {
    return appendPiEvent(trace, data.event);
  }

  // model_call has its own renderer — it carries token deltas not an
  // input/content payload, so it doesn't fit the tool envelope template
  // below. Split off early.
  if (data.type === 'model_call') {
    return appendModelCallTrace(trace, data);
  }

  const li = document.createElement('li');
  const kind = data.kind || data.eventType || 'event';
  li.className = `trace trace-${kind}`;

  // Recognize tool envelopes emitted by the agent-runner (mirrors v2 logTrace).
  let summary = '';
  if (data.type === 'tool_use') {
    summary = `tool · ${data.toolName || data.tool || 'unknown'}`;
  } else if (data.type === 'tool_result') {
    summary = data.isError ? 'tool result · error' : 'tool result';
  } else if (kind === 'tool_use') {
    summary = `tool_call · ${data.toolName || data.tool || ''}`;
  } else if (kind === 'tool_result') {
    summary = `tool_result · ${data.isError ? 'error' : 'ok'}`;
  } else {
    summary = data.summary || data.message || kind;
  }

  // Native <details>/<summary> gives a built-in disclosure triangle for
  // free — collapsed view shows kind + a one-line preview; expanded view
  // shows the full untruncated payload (the actual tool input / result).
  // No payload → render the line plainly without a triangle.
  const payload = data.input ?? data.content;
  if (payload != null) {
    const details = document.createElement('details');
    details.className = 'trace-details';
    const summaryEl = document.createElement('summary');
    summaryEl.className = 'trace-summary';
    const kindEl = document.createElement('span');
    kindEl.className = 'trace-kind';
    kindEl.textContent = summary;
    summaryEl.appendChild(kindEl);
    const preview = document.createElement('span');
    preview.className = 'trace-preview';
    preview.textContent = formatTracePreview(payload);
    summaryEl.appendChild(preview);
    details.appendChild(summaryEl);
    const bodyEl = document.createElement('pre');
    bodyEl.className = 'trace-body';
    bodyEl.textContent = formatTracePayloadFull(payload);
    details.appendChild(bodyEl);
    li.appendChild(details);
  } else {
    const kindEl = document.createElement('div');
    kindEl.className = 'trace-kind';
    kindEl.textContent = summary;
    li.appendChild(kindEl);
  }

  const target = trace._currentTurnUl || trace;
  target.appendChild(li);
  // Eager-finalize so the turn-total footer updates live as events arrive.
  if (trace._currentTurnUl) finalizeTurn(trace._currentTurnUl.closest('.trace-turn'));
  trace.scrollTop = trace.scrollHeight;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pi-native event renderer (Option D)
//
// Pi-agent-core events arrive as:
//   { type: 'pi_event', event: { type: <pi-event-type>, ...fields } }
//
// Per-trace state is kept in trace._piState so multiple simultaneous pi turns
// can share the same trace element without stomping each other. State cleared
// on each turn_start.
//
// CSS patterns mirrored from existing tool_use / tool_result rendering:
//   - Cards use <details>/<summary> with classes trace-details / trace-summary
//     / trace-kind / trace-preview / trace-body — identical disclosure triangle.
//   - Event rows use .trace.trace-<kind> (border-left accent) for event kinds
//     that don't need expansion (turn_start, message_start, usage).
//   - Tool execution cards use .trace-event.trace-event-head/.trace-event-kind/
//     .trace-event-body matching the model-call / direct-call pattern.
//   - Streaming text bubble uses .trace-event with .trace-event-body for live
//     append — same inline-mono text style as trace-event-body.
//   - Thinking panel uses <details> collapsed by default, body in .trace-body
//     (matches existing trace-body pre style: monospaced, scrollable, max 400px).
//   - Error state uses .trace-error (red text, already defined).
//
// Synthetic test events — paste into the browser dev console while the
// playground is open to exercise each code path manually:
//
//   // 1. Streaming text delta (appends to live bubble)
//   window.__pgTestPiEvent({ type: 'pi_event', event: { type: 'message_start', message: { role: 'assistant' } } });
//   window.__pgTestPiEvent({ type: 'pi_event', event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello world' } } });
//   window.__pgTestPiEvent({ type: 'pi_event', event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ' — streaming!' } } });
//   window.__pgTestPiEvent({ type: 'pi_event', event: { type: 'message_end', message: { usage: { input: 120, output: 30, cacheRead: 0, cacheWrite: 0, cost: { total: 0.00042 } } } } });
//
//   // 2. Tool execution start + end
//   window.__pgTestPiEvent({ type: 'pi_event', event: { type: 'tool_execution_start', toolCallId: 'tc1', toolName: 'bash', args: { cmd: 'ls' } } });
//   window.__pgTestPiEvent({ type: 'pi_event', event: { type: 'tool_execution_end', toolCallId: 'tc1', result: { stdout: 'file.txt\nREADME.md' } } });
//
//   // 3. Tool call card (message_update variants)
//   window.__pgTestPiEvent({ type: 'pi_event', event: { type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0 } } });
//   window.__pgTestPiEvent({ type: 'pi_event', event: { type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0 } } });
//   window.__pgTestPiEvent({ type: 'pi_event', event: { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', toolCall: { name: 'bash', arguments: { cmd: 'ls' }, id: 'tc1' } } } });
//
//   // 4. Thinking delta (collapsible panel, default collapsed)
//   window.__pgTestPiEvent({ type: 'pi_event', event: { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'Let me think about this…' } } });
//
//   // Helper to route synthetic events through the same handler as SSE events.
//   // Attach once after the trace panel is visible:
//   //   window.__pgTestPiEvent = (data) => {
//   //     const trace = document.getElementById('trace-log');
//   //     if (!trace._currentTurnUl) {
//   //       // ensure a turn exists
//   //       trace._currentTurnUl = trace;
//   //     }
//   //     appendTraceEvent(trace, data);
//   //   };
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Top-level router for pi-agent-core native events. Dispatches on
 * event.type (the inner pi event type field). State is kept on
 * trace._piState so it survives across multiple call sites without
 * closure capture.
 *
 * @param {Element} trace  — the #trace-log <ul> element
 * @param {object}  event  — the native pi-agent-core event object
 */
function appendPiEvent(trace, event) {
  if (!trace || !event || !event.type) return;

  // Lazily initialize per-trace pi state.
  if (!trace._piState) {
    trace._piState = {
      messageBubble: null,      // current streaming assistant text <li>
      messageTextEl: null,      // .trace-event-body inside the bubble
      thinkingDetails: null,    // <details> for thinking content
      thinkingBodyEl: null,     // <pre> inside thinking details
      toolCallCards: {},        // contentIndex → { li, bodyEl }
      toolExecCards: {},        // toolCallId → { li, statusEl, argsEl, resultEl }
    };
  }
  const st = trace._piState;

  switch (event.type) {
    case 'agent_start':
    case 'agent_end':
      // Internal markers — no UI.
      break;

    case 'turn_start':
      return piHandleTurnStart(trace, event, st);

    case 'message_start':
      return piHandleMessageStart(trace, event, st);

    case 'message_update':
      return piHandleMessageUpdate(trace, event, st);

    case 'message_end':
      return piHandleMessageEnd(trace, event, st);

    case 'tool_execution_start':
      return piHandleToolExecutionStart(trace, event, st);

    case 'tool_execution_update':
      return piHandleToolExecutionUpdate(trace, event, st);

    case 'tool_execution_end':
      return piHandleToolExecutionEnd(trace, event, st);

    case 'turn_end':
      return piHandleTurnEnd(trace, event, st);

    default:
      // Unknown pi event — render as a compact generic trace line so new
      // events don't silently vanish while the renderer catches up.
      piAppendGenericEvent(trace, event);
  }
}

/**
 * turn_start: section divider showing turn number. Resets streaming state
 * so the next assistant message gets a fresh bubble.
 */
function piHandleTurnStart(trace, event, st) {
  const target = trace._currentTurnUl || trace;
  const li = document.createElement('li');
  li.className = 'trace trace-agent-call-head';

  // AGENT CALL header — mirrors the DIRECT CALL format. provider/model
  // are stamped onto the turn_start by pi.ts via _nanoclawMeta (pi-agent-core
  // doesn't carry them natively). Falls back to a plain divider when absent.
  const meta = event._nanoclawMeta;
  const head = document.createElement('div');
  head.className = 'trace-event-head';
  const kindSpan = document.createElement('span');
  kindSpan.className = 'trace-event-kind';
  kindSpan.textContent = 'AGENT CALL';
  head.appendChild(kindSpan);
  if (meta && (meta.provider || meta.model)) {
    const codeEl = document.createElement('code');
    codeEl.textContent = `${meta.provider || ''}/${meta.model || ''}`.replace(/^\/|\/$/g, '');
    head.appendChild(codeEl);
  } else if (event.turnId) {
    const codeEl = document.createElement('code');
    codeEl.textContent = `turn ${event.turnId}`;
    head.appendChild(codeEl);
  }
  li.appendChild(head);
  target.appendChild(li);

  // Reset per-turn pi streaming state.
  st.messageBubble = null;
  st.messageTextEl = null;
  st.thinkingDetails = null;
  st.thinkingBodyEl = null;
  st.toolCallCards = {};
  // Do NOT clear toolExecCards here — executions can cross turn boundaries.

  trace.scrollTop = trace.scrollHeight;
}

/**
 * message_start: begin a new assistant bubble in the trace panel.
 * Only creates a card for assistant messages — user messages flow through
 * the main chat log, not the trace pane.
 */
function piHandleMessageStart(trace, event, st) {
  const role = (event.message && event.message.role) || 'unknown';
  if (role !== 'assistant') return;

  const target = trace._currentTurnUl || trace;
  const li = document.createElement('li');
  li.className = 'trace-event trace-pi-message';

  // Use <details>/<summary> so the assistant body collapses behind a
  // disclosure triangle — matches the tool_use / TOOL EXEC rows for
  // visual consistency. Open during streaming so the user sees text
  // arrive live; auto-collapsed by piHandleMessageEnd once done.
  const details = document.createElement('details');
  details.className = 'trace-details trace-pi-message-details';
  details.open = true;

  const summaryEl = document.createElement('summary');
  summaryEl.className = 'trace-summary';
  const kindEl = document.createElement('span');
  kindEl.className = 'trace-kind';
  kindEl.textContent = 'assistant';
  summaryEl.appendChild(kindEl);
  // Preview span — filled with a one-line snippet of the streaming text
  // by piHandleTextDelta so the collapsed summary stays informative.
  const previewEl = document.createElement('span');
  previewEl.className = 'trace-preview';
  previewEl.textContent = '';
  summaryEl.appendChild(previewEl);
  details.appendChild(summaryEl);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'trace-event-body';
  bodyEl.style.cssText = 'white-space:pre-wrap;';
  bodyEl.textContent = '';
  details.appendChild(bodyEl);

  li.appendChild(details);
  target.appendChild(li);

  st.messageBubble = li;
  st.messageTextEl = bodyEl;
  st.messagePreviewEl = previewEl;
  st.messageDetails = details;
  // Reset thinking state for the new message.
  st.thinkingDetails = null;
  st.thinkingBodyEl = null;

  trace.scrollTop = trace.scrollHeight;
}

/**
 * message_update: dispatches on assistantMessageEvent.type.
 */
function piHandleMessageUpdate(trace, event, st) {
  const ame = event.assistantMessageEvent;
  if (!ame) return;

  switch (ame.type) {
    case 'text_delta':
      return piHandleTextDelta(trace, ame, st);
    case 'thinking_delta':
      return piHandleThinkingDelta(trace, ame, st);
    case 'toolcall_start':
      return piHandleToolcallStart(trace, ame, st);
    case 'toolcall_delta':
      // Nothing to show until toolcall_end carries the full args.
      break;
    case 'toolcall_end':
      return piHandleToolcallEnd(trace, ame, st);
    default:
      break;
  }
}

/** text_delta: append to the current streaming bubble (single growing element). */
function piHandleTextDelta(trace, ame, st) {
  if (!st.messageTextEl) {
    // No open bubble — create a minimal one so deltas aren't lost.
    piHandleMessageStart(trace, { message: { role: 'assistant' } }, st);
  }
  if (st.messageTextEl && typeof ame.delta === 'string') {
    st.messageTextEl.textContent += ame.delta;
    // Keep summary preview in sync with the first ~80 chars so the
    // post-collapse summary line is informative.
    if (st.messagePreviewEl) {
      const flat = st.messageTextEl.textContent.replace(/\s+/g, ' ').trim();
      st.messagePreviewEl.textContent = flat.length > 80 ? flat.slice(0, 80) + '…' : flat;
    }
  }
  trace.scrollTop = trace.scrollHeight;
}

/**
 * thinking_delta: append to a collapsible "Thinking" panel attached to
 * the current message bubble. Created on first delta, default collapsed.
 * Mirrors the <details>/<summary> disclosure pattern of tool_use cards.
 */
function piHandleThinkingDelta(trace, ame, st) {
  if (!st.thinkingDetails && st.messageBubble) {
    // Create the thinking collapsible panel inside the current bubble.
    const details = document.createElement('details');
    details.className = 'trace-details trace-pi-thinking';
    // Default collapsed (no `open` attribute).
    const summaryEl = document.createElement('summary');
    summaryEl.className = 'trace-summary';
    const kindEl = document.createElement('span');
    kindEl.className = 'trace-kind';
    kindEl.textContent = 'thinking';
    summaryEl.appendChild(kindEl);
    details.appendChild(summaryEl);
    const bodyEl = document.createElement('pre');
    bodyEl.className = 'trace-body';
    bodyEl.textContent = '';
    details.appendChild(bodyEl);
    st.messageBubble.appendChild(details);
    st.thinkingDetails = details;
    st.thinkingBodyEl = bodyEl;
  }
  if (st.thinkingBodyEl && typeof ame.delta === 'string') {
    st.thinkingBodyEl.textContent += ame.delta;
  }
  trace.scrollTop = trace.scrollHeight;
}

/**
 * toolcall_start: begin a tool call card in the trace, keyed on contentIndex.
 * Shows a pending card — finalized by toolcall_end.
 */
function piHandleToolcallStart(trace, ame, st) {
  const idx = ame.contentIndex;
  const target = trace._currentTurnUl || trace;

  const li = document.createElement('li');
  li.className = 'trace trace-tool_use';

  const details = document.createElement('details');
  details.className = 'trace-details';
  const summaryEl = document.createElement('summary');
  summaryEl.className = 'trace-summary';
  const kindEl = document.createElement('span');
  kindEl.className = 'trace-kind';
  kindEl.textContent = 'tool call · pending…';
  summaryEl.appendChild(kindEl);
  const previewEl = document.createElement('span');
  previewEl.className = 'trace-preview';
  previewEl.textContent = '';
  summaryEl.appendChild(previewEl);
  details.appendChild(summaryEl);
  const bodyEl = document.createElement('pre');
  bodyEl.className = 'trace-body';
  bodyEl.textContent = '';
  details.appendChild(bodyEl);
  li.appendChild(details);
  target.appendChild(li);

  st.toolCallCards[idx] = { li, kindEl, previewEl, bodyEl };
  trace.scrollTop = trace.scrollHeight;
}

/**
 * toolcall_end: finalize the tool call card with name + args. Marks the card
 * with the tool name and shows full args JSON in the expanded body.
 * Mirrors the existing tool_use disclosure style.
 */
function piHandleToolcallEnd(trace, ame, st) {
  const tc = ame.toolCall;
  if (!tc) return;

  // Try to match a pending card by contentIndex. Fall back to creating a new
  // card if toolcall_start was somehow missed.
  const idx = ame.contentIndex;
  let card = st.toolCallCards != null ? st.toolCallCards[idx] : null;
  if (!card) {
    piHandleToolcallStart(trace, ame, st);
    card = st.toolCallCards[idx];
    if (!card) return;
  }

  const name = tc.name || 'unknown';
  const args = tc.arguments != null ? tc.arguments : {};
  const argsStr = formatTracePayloadFull(args);
  const previewStr = formatTracePreview(args);

  card.kindEl.textContent = `tool call · ${name}`;
  card.previewEl.textContent = previewStr;
  card.bodyEl.textContent = argsStr;

  // Tag with tool-call id so tool_execution_end can find it.
  if (tc.id) card.li.dataset.toolCallId = tc.id;

  if (trace._currentTurnUl) finalizeTurn(trace._currentTurnUl.closest('.trace-turn'));
  trace.scrollTop = trace.scrollHeight;
}

/**
 * message_end: seal the bubble. Show usage line if message.usage is present.
 * Usage fields: input, output, cacheRead, cacheWrite, cost.total.
 */
function piHandleMessageEnd(trace, event, st) {
  // Auto-collapse the assistant body now that streaming is done — the
  // summary still shows the preview snippet, click to re-expand.
  if (st.messageDetails) st.messageDetails.open = false;

  const usage = event.message && event.message.usage;
  if (!usage || !st.messageBubble) return;

  const parts = [];
  if (typeof usage.input === 'number') parts.push(`${usage.input} in`);
  if (typeof usage.cacheRead === 'number' && usage.cacheRead > 0) parts.push(`${usage.cacheRead} cache-`);
  if (typeof usage.cacheWrite === 'number' && usage.cacheWrite > 0) parts.push(`${usage.cacheWrite} cache+`);
  if (typeof usage.output === 'number') parts.push(`${usage.output} out`);
  if (usage.cost && typeof usage.cost.total === 'number') {
    const c = usage.cost.total;
    parts.push(c < 0.001 ? `$${c.toFixed(5)}` : `$${c.toFixed(4)}`);
  }

  if (parts.length > 0) {
    const usageEl = document.createElement('div');
    usageEl.className = 'trace-event-body';
    usageEl.style.cssText = 'font-size:10px;color:#888;margin-top:3px;';
    usageEl.textContent = parts.join(' · ');
    st.messageBubble.appendChild(usageEl);
  }

  // Stash tokens on the bubble li for finalizeTurn to aggregate.
  if (typeof usage.input === 'number') st.messageBubble.dataset.tokensIn = usage.input;
  if (typeof usage.output === 'number') st.messageBubble.dataset.tokensOut = usage.output;
  if (usage.cacheRead > 0) st.messageBubble.dataset.tokensCacheRead = usage.cacheRead;
  if (usage.cacheWrite > 0) st.messageBubble.dataset.tokensCacheCreation = usage.cacheWrite;
  if (usage.cost && typeof usage.cost.total === 'number') st.messageBubble.dataset.cost = usage.cost.total;

  if (trace._currentTurnUl) finalizeTurn(trace._currentTurnUl.closest('.trace-turn'));
  trace.scrollTop = trace.scrollHeight;
}

/**
 * tool_execution_start: begin a tool execution status card, keyed on toolCallId.
 * Mirrors the .trace-event / .trace-event-head / .trace-event-kind / .trace-event-body
 * pattern used by appendModelCallTrace (head + body, optionally expandable).
 * Border-left uses .trace-tool_use accent colour (#4a90e2) until the result arrives.
 */
function piHandleToolExecutionStart(trace, event, st) {
  const { toolCallId, toolName, args } = event;
  const target = trace._currentTurnUl || trace;

  const li = document.createElement('li');
  li.className = 'trace-event trace-pi-tool-exec';

  // Head row: kind label + tool name.
  const head = document.createElement('div');
  head.className = 'trace-event-head';
  const kindSpan = document.createElement('span');
  kindSpan.className = 'trace-event-kind';
  kindSpan.textContent = 'tool exec';
  const codeEl = document.createElement('code');
  codeEl.textContent = toolName || toolCallId || '?';
  head.appendChild(kindSpan);
  head.appendChild(codeEl);
  li.appendChild(head);

  // Args disclosed via <details>/<summary>, same as tool_use cards.
  const argsPayload = args != null ? args : null;
  let statusEl;
  if (argsPayload != null) {
    const details = document.createElement('details');
    details.className = 'trace-details';
    const summaryEl = document.createElement('summary');
    summaryEl.className = 'trace-summary';
    statusEl = document.createElement('span');
    statusEl.className = 'trace-event-body trace-pending';
    statusEl.textContent = 'running…';
    summaryEl.appendChild(statusEl);
    details.appendChild(summaryEl);
    const argsEl = document.createElement('pre');
    argsEl.className = 'trace-body';
    argsEl.textContent = formatTracePayloadFull(argsPayload);
    details.appendChild(argsEl);
    // Placeholder for result (appended by tool_execution_end).
    const resultEl = document.createElement('pre');
    resultEl.className = 'trace-body';
    resultEl.style.display = 'none';
    details.appendChild(resultEl);
    li.appendChild(details);
    st.toolExecCards[toolCallId] = { li, statusEl, resultEl, details };
  } else {
    statusEl = document.createElement('div');
    statusEl.className = 'trace-event-body trace-pending';
    statusEl.textContent = 'running…';
    li.appendChild(statusEl);
    st.toolExecCards[toolCallId] = { li, statusEl, resultEl: null, details: null };
  }

  target.appendChild(li);
  if (trace._currentTurnUl) finalizeTurn(trace._currentTurnUl.closest('.trace-turn'));
  trace.scrollTop = trace.scrollHeight;
}

/**
 * tool_execution_update: stream partial result text into the status slot if
 * available. partialResult may be a string or object.
 */
function piHandleToolExecutionUpdate(trace, event, st) {
  const card = st.toolExecCards[event.toolCallId];
  if (!card) return;
  if (event.partialResult != null && card.statusEl) {
    card.statusEl.classList.remove('trace-pending');
    card.statusEl.textContent = formatTracePreview(event.partialResult);
  }
  trace.scrollTop = trace.scrollHeight;
}

/**
 * tool_execution_end: finalize the execution card. Show result in the body.
 * Removes pending style; adds full result as expandable body.
 * Border-left switches to .trace-tool_result accent (#87a96b) on success.
 */
function piHandleToolExecutionEnd(trace, event, st) {
  const card = st.toolExecCards[event.toolCallId];
  const result = event.result;

  if (!card) {
    // Card was never started (missed tool_execution_start) — render inline.
    const target = trace._currentTurnUl || trace;
    const li = document.createElement('li');
    li.className = 'trace trace-tool_result';
    const details = document.createElement('details');
    details.className = 'trace-details';
    const summaryEl = document.createElement('summary');
    summaryEl.className = 'trace-summary';
    const kindEl = document.createElement('span');
    kindEl.className = 'trace-kind';
    kindEl.textContent = `tool result · ${event.toolCallId || '?'}`;
    summaryEl.appendChild(kindEl);
    const previewEl = document.createElement('span');
    previewEl.className = 'trace-preview';
    previewEl.textContent = formatTracePreview(result);
    summaryEl.appendChild(previewEl);
    details.appendChild(summaryEl);
    const bodyEl = document.createElement('pre');
    bodyEl.className = 'trace-body';
    bodyEl.textContent = formatTracePayloadFull(result);
    details.appendChild(bodyEl);
    li.appendChild(details);
    target.appendChild(li);
    if (trace._currentTurnUl) finalizeTurn(trace._currentTurnUl.closest('.trace-turn'));
    trace.scrollTop = trace.scrollHeight;
    return;
  }

  // Update the existing card.
  card.li.classList.add('trace-pi-tool-exec-done');
  if (card.statusEl) {
    card.statusEl.classList.remove('trace-pending');
    card.statusEl.textContent = formatTracePreview(result);
  }
  if (card.resultEl && result != null) {
    card.resultEl.textContent = formatTracePayloadFull(result);
    card.resultEl.style.display = '';
  }
  // Leave the details collapsed — the summary preview is enough at a glance;
  // click to drill into args + full result. (Auto-opening on completion
  // meant tool-using turns produced a wall of inline JSON.)

  if (trace._currentTurnUl) finalizeTurn(trace._currentTurnUl.closest('.trace-turn'));
  trace.scrollTop = trace.scrollHeight;
}

/**
 * turn_end: section close. If cost is available from toolResults or message,
 * it will already be in the bubble's dataset via message_end — finalizeTurn
 * picks it up from there. No additional action needed beyond a scroll bump.
 */
function piHandleTurnEnd(trace, event, st) {
  if (trace._currentTurnUl) finalizeTurn(trace._currentTurnUl.closest('.trace-turn'));
  trace.scrollTop = trace.scrollHeight;
}

/**
 * Pi-agent-core's internal lifecycle markers — fired at adapter-specific
 * points (`save_point` after each tool exec, `settled` at end-of-turn,
 * `after_provider_response`/`before_provider_payload` around each model
 * call, etc.). Useful for debugging the harness itself; pure noise for
 * an end-user reading a trace. Filter them out so the trace looks the
 * same across anthropic / openai-codex / future providers.
 *
 * Real failures still get through because the synthetic `nanoclaw_error`
 * event (emitted by poll-loop on provider error) is NOT in this set.
 */
const PI_INTERNAL_EVENT_TYPES = new Set([
  'save_point',
  'settled',
  'after_provider_response',
  'before_provider_payload',
  'context',
  'before_compact',
  'after_compact',
]);

/** Fallback: render any unrecognised pi event as a compact generic line. */
function piAppendGenericEvent(trace, event) {
  if (event && PI_INTERNAL_EVENT_TYPES.has(event.type)) return;
  const target = trace._currentTurnUl || trace;
  const li = document.createElement('li');
  // nanoclaw_error is the synthetic event the poll-loop emits when a
  // provider error fires — gets the trace-error styling (red border,
  // bold kind label) so the user sees the failure instead of a missing
  // reply.
  const isError = event.type === 'nanoclaw_error';
  li.className = isError ? 'trace trace-error' : 'trace';

  const kindEl = document.createElement('div');
  kindEl.className = 'trace-kind';
  kindEl.textContent = isError ? 'ERROR' : `pi: ${event.type || 'unknown'}`;
  li.appendChild(kindEl);

  // For errors, render the message + classification as a body so the user
  // can read what went wrong without expanding anything.
  if (isError && (event.message || event.classification)) {
    const bodyEl = document.createElement('div');
    bodyEl.className = 'trace-event-body';
    bodyEl.style.cssText = 'color:#a40000;white-space:pre-wrap;font-size:11px;margin-top:2px;';
    const parts = [];
    if (event.message) parts.push(event.message);
    if (event.classification) parts.push(`(${event.classification})`);
    bodyEl.textContent = parts.join(' ');
    li.appendChild(bodyEl);
  }
  target.appendChild(li);
  trace.scrollTop = trace.scrollHeight;
}

/** Single-line preview shown next to the triangle when collapsed. */
function formatTracePreview(payload) {
  if (payload == null) return '';
  if (typeof payload === 'string') return truncate(payload.replace(/\s+/g, ' '), 80);
  if (Array.isArray(payload) && payload.every((b) => b && typeof b === 'object' && 'text' in b)) {
    return truncate(payload.map((b) => b.text).join(' ').replace(/\s+/g, ' '), 80);
  }
  // Pull a meaningful first field for objects (query for web_search,
  // command for bash, etc.). Falls back to compact JSON.
  if (typeof payload === 'object') {
    const obj = payload;
    for (const key of ['query', 'command', 'tool', 'path', 'url', 'message']) {
      if (typeof obj[key] === 'string' && obj[key]) return truncate(`${key}: ${obj[key]}`, 80);
    }
    try { return truncate(JSON.stringify(payload), 80); } catch { return String(payload); }
  }
  return truncate(String(payload), 80);
}

/** Full payload shown when expanded. No length cap (trace bodies are bounded by what the model produced). */
function formatTracePayloadFull(payload) {
  if (payload == null) return '';
  if (typeof payload === 'string') return payload;
  if (Array.isArray(payload) && payload.every((b) => b && typeof b === 'object' && 'text' in b)) {
    return payload.map((b) => b.text).join('\n');
  }
  try { return JSON.stringify(payload, null, 2); } catch { return String(payload); }
}

function truncate(s, max) {
  return s.length <= max ? s : s.slice(0, max) + `\n… (${s.length - max} more chars)`;
}

function appendSystemNote(log, text) {
  const li = document.createElement('li');
  li.className = 'msg system';
  li.textContent = text;
  log.appendChild(li);
}

function showModelSwitchModal(from, to) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    root.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal">
          <h3>⚠ Switch model?</h3>
          <p>Switching from <strong>${escapeHtml(from)}</strong> to <strong>${escapeHtml(to)}</strong> will <strong>reset this chat</strong> — the running container will be killed and the agent will start a fresh conversation with the new model.</p>
          <p class="hint">Your persona, skills, and library entries are not affected. Only the live conversation state is lost.</p>
          <div class="modal-actions">
            <button class="btn" id="modal-cancel">Cancel</button>
            <button class="btn btn-danger" id="modal-ok">Switch &amp; reset chat</button>
          </div>
        </div>
      </div>
    `;
    const cleanup = (result) => { root.innerHTML = ''; resolve(result); };
    root.querySelector('#modal-cancel').addEventListener('click', () => cleanup(false));
    root.querySelector('#modal-ok').addEventListener('click', () => cleanup(true));
  });
}

function showProviderSwitchModal(from, to) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    root.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal">
          <h3>⚠ Switch provider?</h3>
          <p>Switching from <strong>${escapeHtml(from)}</strong> to <strong>${escapeHtml(to)}</strong> will <strong>reset this chat</strong> — the running container will be killed and the agent will start a fresh conversation.</p>
          <p class="hint">Your persona, skills, and library entries are not affected. Only the live conversation state is lost.</p>
          <div class="modal-actions">
            <button class="btn" id="modal-cancel">Cancel</button>
            <button class="btn btn-danger" id="modal-ok">Switch &amp; reset chat</button>
          </div>
        </div>
      </div>
    `;
    const cleanup = (result) => { root.innerHTML = ''; resolve(result); };
    root.querySelector('#modal-cancel').addEventListener('click', () => cleanup(false));
    root.querySelector('#modal-ok').addEventListener('click', () => cleanup(true));
  });
}

function appendChatNote(log, text) {
  const li = document.createElement('li');
  li.className = 'chat-note';
  li.textContent = text;
  log.appendChild(li);
  log.scrollTop = log.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Direct-chat trace events. In agent mode the trace is populated by the
 * SSE stream (tool_use, system events, etc.); in direct mode there's
 * only one event per turn — the API call itself.
 */
/**
 * Synthetic trace event for an agent-mode LLM call. Built from the same
 * provider/model/tokens/latency fields the chat bubble's footer uses, so
 * a tool-less turn still leaves a record in the trace pane. Cost is
 * computed client-side by looking up the catalog entry stashed at
 * window.__pg.catalog (populated by loadModelDropdowns).
 */
/**
 * Renders a single LLM call mid-turn — emitted by the agent-runner each
 * time the underlying model responds (per thread/tokenUsage/updated.last
 * for codex). Sits between tool_use/tool_result entries, so a multi-tool
 * turn shows N model_call entries instead of one cumulative summary.
 * Provider/model isn't carried in the event payload (the agent-runner
 * doesn't include them per-call); we pull them from the chat tab's
 * current dropdown selection, which matches the running container.
 */
function appendModelCallTrace(trace, data) {
  if (!trace) return;
  const li = document.createElement('li');
  li.className = 'trace-event trace-model-call';
  const provSel = document.getElementById('provider-sel');
  const modelSel = document.getElementById('model-sel');
  const provider = provSel ? provSel.value : '';
  const model = modelSel ? modelSel.value : '';
  const tokensIn = typeof data.tokensIn === 'number' ? data.tokensIn : 0;
  const tokensOut = typeof data.tokensOut === 'number' ? data.tokensOut : 0;
  const cached = typeof data.tokensCached === 'number' ? data.tokensCached : 0;
  const reasoning = typeof data.tokensReasoning === 'number' ? data.tokensReasoning : 0;
  const cachedNote = cached > 0 ? `, ${cached} cached` : '';
  const outBreakdown = reasoning > 0 ? `${tokensOut} out (${reasoning} reasoning)` : `${tokensOut} out`;
  // Cost: use the same client-side helper as appendAgentTraceCall, but
  // bill cached input at the cheaper rate (mirrors direct-chat.ts:priceFor).
  const cost = computeAgentCallCost(provider, model, tokensIn, tokensOut, cached);
  const costText = cost != null ? (cost < 0.001 ? `$${cost.toFixed(5)}` : `$${cost.toFixed(4)}`) : '';
  const summaryText = `${tokensIn} in${cachedNote} · ${outBreakdown}${costText ? ` · ${costText}` : ''}`;

  const head = document.createElement('div');
  head.className = 'trace-event-head';
  const kindSpan = document.createElement('span');
  kindSpan.className = 'trace-event-kind';
  kindSpan.textContent = 'model call';
  const codeEl = document.createElement('code');
  codeEl.textContent = `${provider}/${model}`;
  head.appendChild(kindSpan);
  head.appendChild(codeEl);
  li.appendChild(head);

  const responseText = typeof data.responsePreview === 'string' ? data.responsePreview : null;
  if (responseText) {
    const details = document.createElement('details');
    details.className = 'trace-details';
    const summaryEl = document.createElement('summary');
    summaryEl.className = 'trace-summary';
    const bodySpan = document.createElement('span');
    bodySpan.className = 'trace-event-body';
    bodySpan.textContent = summaryText;
    summaryEl.appendChild(bodySpan);
    details.appendChild(summaryEl);
    const bodyEl = document.createElement('pre');
    bodyEl.className = 'trace-body';
    bodyEl.textContent = responseText;
    details.appendChild(bodyEl);
    li.appendChild(details);
  } else {
    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'trace-event-body';
    bodyDiv.textContent = summaryText;
    li.appendChild(bodyDiv);
  }

  li.dataset.tokensIn = tokensIn;
  li.dataset.tokensOut = tokensOut;
  li.dataset.tokensCached = cached;
  li.dataset.tokensReasoning = reasoning;
  if (cost != null) li.dataset.cost = cost;
  const target = trace._currentTurnUl || trace;
  target.appendChild(li);
  // Eager-finalize so the turn-total footer updates live as events arrive.
  if (trace._currentTurnUl) finalizeTurn(trace._currentTurnUl.closest('.trace-turn'));
  trace.scrollTop = trace.scrollHeight;
}

function appendAgentTraceCall(trace, data) {
  if (!trace) return;
  const li = document.createElement('li');
  li.className = 'trace-event trace-agent-call';
  const parts = [];
  const tokensIn = data.tokens && typeof data.tokens.input === 'number' ? data.tokens.input : null;
  const tokensOut = data.tokens && typeof data.tokens.output === 'number' ? data.tokens.output : null;
  const cacheCreation =
    data.tokens && typeof data.tokens.cacheCreation === 'number' ? data.tokens.cacheCreation : 0;
  const cacheRead =
    data.tokens && typeof data.tokens.cacheRead === 'number' ? data.tokens.cacheRead : 0;
  if (tokensIn != null && tokensOut != null) {
    const cacheNote = [];
    if (cacheCreation > 0) cacheNote.push(`${cacheCreation} cache+`);
    if (cacheRead > 0) cacheNote.push(`${cacheRead} cache-`);
    const inLabel = cacheNote.length > 0 ? `${tokensIn} in (${cacheNote.join(', ')})` : `${tokensIn} in`;
    parts.push(`${inLabel} · ${tokensOut} out`);
  }
  if (typeof data.latencyMs === 'number') parts.push(`${(data.latencyMs / 1000).toFixed(1)}s`);
  const cost = computeAgentCallCost(data.provider, data.model, tokensIn, tokensOut, cacheRead, cacheCreation);
  if (cost != null) parts.push(cost < 0.001 ? `$${cost.toFixed(5)}` : `$${cost.toFixed(4)}`);
  const summaryText = parts.length > 0 ? parts.join(' · ') : '(no usage reported)';

  const head = document.createElement('div');
  head.className = 'trace-event-head';
  const kindSpan = document.createElement('span');
  kindSpan.className = 'trace-event-kind';
  kindSpan.textContent = 'agent turn sum';
  const codeEl = document.createElement('code');
  codeEl.textContent = `${data.provider || ''}/${data.model || ''}`;
  head.appendChild(kindSpan);
  head.appendChild(codeEl);
  li.appendChild(head);

  // Response text rides in the same SSE payload as the chat bubble — the
  // turn's final assistant text. Disclose it so the trace pane can show
  // what the model actually produced, not just the token/cost summary.
  let responseText = null;
  if (typeof data.content === 'string') responseText = data.content;
  else if (data.content && typeof data.content === 'object' && typeof data.content.text === 'string') {
    responseText = data.content.text;
  }
  if (responseText) {
    const details = document.createElement('details');
    details.className = 'trace-details';
    const summaryEl = document.createElement('summary');
    summaryEl.className = 'trace-summary';
    const bodySpan = document.createElement('span');
    bodySpan.className = 'trace-event-body';
    bodySpan.textContent = summaryText;
    summaryEl.appendChild(bodySpan);
    details.appendChild(summaryEl);
    const bodyEl = document.createElement('pre');
    bodyEl.className = 'trace-body';
    bodyEl.textContent = responseText;
    details.appendChild(bodyEl);
    li.appendChild(details);
  } else {
    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'trace-event-body';
    bodyDiv.textContent = summaryText;
    li.appendChild(bodyDiv);
  }

  if (tokensIn != null) li.dataset.tokensIn = tokensIn;
  if (tokensOut != null) li.dataset.tokensOut = tokensOut;
  if (cacheCreation > 0) li.dataset.tokensCacheCreation = cacheCreation;
  if (cacheRead > 0) li.dataset.tokensCacheRead = cacheRead;
  if (cost != null) li.dataset.cost = cost;
  const target = trace._currentTurnUl || trace;
  target.appendChild(li);
  // Eager-finalize so the turn-total footer updates live as events arrive.
  if (trace._currentTurnUl) finalizeTurn(trace._currentTurnUl.closest('.trace-turn'));
  trace.scrollTop = trace.scrollHeight;
}

/**
 * Mirror of src/channels/playground/api/direct-chat.ts:priceFor — look the
 * model up in the playground-side catalog (stashed by loadModelDropdowns)
 * and apply split rates when available, else the legacy blended rate.
 * Returns null when no usable rate is found so the caller can omit the
 * cost field entirely rather than showing "$0" (which is misleading for
 * cloud models we just don't have prices for).
 */
function computeAgentCallCost(
  provider,
  model,
  tokensIn,
  tokensOut,
  cacheRead = 0,
  cacheCreation = 0,
) {
  if (tokensIn == null || tokensOut == null) return null;
  const catalog = (window.__pg && window.__pg.catalog) || [];
  const entry = catalog.find((e) => e.provider === provider && e.id === model);
  if (!entry) return null;
  if (entry.costPer1kInUsd != null || entry.costPer1kOutUsd != null) {
    // Three cache treatments depending on provider:
    //   - Anthropic returns input_tokens (uncached) + cache_creation_input_tokens
    //     (billed at 1.25× input) + cache_read_input_tokens (billed at 0.10× input).
    //     The three fields are DISJOINT; sum = wire bytes.
    //   - OpenAI/codex returns total inputTokens (which already INCLUDES cached)
    //     plus cachedInputTokens (the cached subset, ~0.50× input rate).
    //     `cacheCreation` is unset; we use the legacy "subtract cached from
    //     total" math via the tokensIn-cacheRead-cacheCreation calc.
    const baseInRate = entry.costPer1kInUsd || 0;
    const cachedRateAnthropic = entry.costPer1kCachedInUsd ?? baseInRate * 0.1;
    const cacheCreationRate = entry.costPer1kCacheCreationUsd ?? baseInRate * 1.25;
    const cachedRateOpenAI = entry.costPer1kCachedInUsd ?? baseInRate * 0.5;
    let inCost;
    if (cacheCreation > 0) {
      // Anthropic-style: input + creation + read are disjoint.
      inCost =
        (tokensIn / 1000) * baseInRate +
        (cacheCreation / 1000) * cacheCreationRate +
        (cacheRead / 1000) * cachedRateAnthropic;
    } else {
      // OpenAI-style: cacheRead is a subset of tokensIn (or no caching at all).
      const billedIn = Math.max(0, tokensIn - cacheRead);
      inCost = (billedIn / 1000) * baseInRate + (cacheRead / 1000) * cachedRateOpenAI;
    }
    return inCost + (tokensOut / 1000) * (entry.costPer1kOutUsd || 0);
  }
  if (entry.costPer1kTokensUsd != null) {
    return ((tokensIn + tokensOut) / 1000) * entry.costPer1kTokensUsd;
  }
  return null;
}

function appendDirectTraceCall(trace, provider, model, turnNumber) {
  if (!trace) return null;
  const li = document.createElement('li');
  li.className = 'trace-event trace-direct-call';
  li.innerHTML = `
    <div class="trace-event-head">
      <span class="trace-event-kind">direct call</span>
      <code>${escapeHtml(provider)}/${escapeHtml(model)}</code>
    </div>
    <div class="trace-event-body trace-pending">turn ${turnNumber} · pending…</div>
  `;
  const target = trace._currentTurnUl || trace;
  target.appendChild(li);
  // Eager-finalize so the turn-total footer updates live as events arrive.
  if (trace._currentTurnUl) finalizeTurn(trace._currentTurnUl.closest('.trace-turn'));
  trace.scrollTop = trace.scrollHeight;
  return li;
}

function finalizeDirectTraceCall(li, data) {
  if (!li) return;
  const body = li.querySelector('.trace-event-body');
  if (!body) return;
  body.classList.remove('trace-pending');
  if (data.error) {
    body.classList.add('trace-error');
    body.textContent = `error: ${data.error}`;
    return;
  }
  const cost = data.costUsd < 0.001 ? `$${data.costUsd.toFixed(5)}` : `$${data.costUsd.toFixed(4)}`;
  const cachedNote = data.tokensCached > 0 ? `, ${data.tokensCached} cached` : '';
  const reasoning = data.tokensReasoning || 0;
  const outBreakdown = reasoning > 0 ? `${data.tokensOut} out (${reasoning} reasoning)` : `${data.tokensOut} out`;
  const latency = typeof data.latencyMs === 'number' ? ` · ${(data.latencyMs / 1000).toFixed(1)}s` : '';
  body.textContent = `${data.tokensIn} in${cachedNote} · ${outBreakdown}${latency} · ${cost}`;
  // Stash numeric data for finalizeTurn to sum.
  li.dataset.tokensIn = data.tokensIn || 0;
  li.dataset.tokensOut = data.tokensOut || 0;
  li.dataset.tokensCached = data.tokensCached || 0;
  li.dataset.tokensReasoning = reasoning;
  li.dataset.cost = data.costUsd || 0;
  // Eager-finalize the enclosing turn so the totals footer updates immediately
  // on call completion (rather than waiting for the next user submit).
  const turnEl = li.closest('.trace-turn');
  if (turnEl) finalizeTurn(turnEl);
}
