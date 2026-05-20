import { showDraftBanner, hideDraftBanner } from '../draft-banner.js';

let originalPersona = ''; // last-saved persona text, for dirty-state detection

export function mountPersona(el) {
  const folder = window.__pg.agent.folder;
  const agentName = window.__pg.agent.name;

  el.innerHTML = `
    <div class="persona-layout">
      <aside class="library-panel">
        <h3>Library</h3>
        <input id="lib-filter" placeholder="filter…" autocomplete="off">
        <div id="lib-default" class="lib-section">
          <h4>Default agents</h4>
          <ul></ul>
        </div>
        <div id="lib-class" class="lib-section">
          <h4>Class library</h4>
          <ul></ul>
        </div>
        <div id="lib-my" class="lib-section">
          <h4>My library</h4>
          <ul></ul>
        </div>
      </aside>

      <section class="preview-panel">
        <header class="preview-header">
          <span id="prev-title">📚 From library</span>
          <span class="hint">read-only · ⌘A then ⌘C to copy</span>
        </header>
        <div id="prev-meta" class="preview-meta"></div>
        <pre id="prev-body" class="preview-body">Click a library entry to preview.</pre>
      </section>

      <section class="active-panel">
        <nav class="sub-tabs" id="active-subtabs">
          <button data-sub="my" class="sub-tab active">✏️ My persona</button>
          <button data-sub="group" class="sub-tab">🔒 Group base</button>
          <button data-sub="container" class="sub-tab">🔒 Container base</button>
          <button data-sub="global" class="sub-tab" id="sub-global">🔒 Global</button>
        </nav>
        <textarea id="active-text" class="active-text"></textarea>
        <footer class="active-footer">
          <label>prefers provider <select id="active-provider"></select></label>
          <label>model <select id="active-model"></select></label>
        </footer>
      </section>
    </div>
  `;

  loadLibrary(el);
  loadActivePersona(el, folder);
  loadProviderModelDropdowns(el, folder);
  wireSubTabs(el, folder);
  wireDraftDetection(el);
  wireFilter(el);
  prefetchLayerExistence(el, folder); // dim Global if absent
  document.title = `Persona — ${agentName} · Agent Playground`;
}

function loadLibrary(el) {
  fetch('/api/library', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : { default: [], class: [], my: [] }))
    .then((tiers) => {
      for (const tier of ['default', 'class', 'my']) {
        const ul = el.querySelector(`#lib-${tier} ul`);
        ul.innerHTML = '';
        for (const entry of tiers[tier] || []) {
          const li = document.createElement('li');
          li.className = 'lib-entry';
          li.textContent = `📋 ${entry.name}`;
          li.dataset.tier = tier;
          li.dataset.name = entry.name;
          li.title = entry.description || '';
          li.addEventListener('click', () => loadPreview(el, tier, entry.name));
          ul.appendChild(li);
        }
        if ((tiers[tier] || []).length === 0) {
          const empty = document.createElement('li');
          empty.className = 'lib-empty';
          empty.textContent = '(empty)';
          ul.appendChild(empty);
        }
      }
    })
    .catch(() => {
      // Silent — library is a nice-to-have.
    });
}

function loadPreview(el, tier, name) {
  fetch(`/api/library/${tier}/${encodeURIComponent(name)}`, { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : null))
    .then((entry) => {
      if (!entry) return;
      el.querySelector('#prev-title').textContent = `📚 From library: ${entry.name}`;
      const metaParts = [tier];
      if (entry.preferredProvider) metaParts.push(`prefers ${entry.preferredProvider}`);
      if (entry.preferredModel) metaParts.push(`model ${entry.preferredModel}`);
      if (Array.isArray(entry.skills) && entry.skills.length) metaParts.push(`skills: ${entry.skills.join(', ')}`);
      el.querySelector('#prev-meta').textContent = metaParts.join(' · ');
      el.querySelector('#prev-body').textContent = entry.persona || '';
      for (const li of el.querySelectorAll('.lib-entry')) li.classList.remove('selected');
      const selected = el.querySelector(`.lib-entry[data-tier="${tier}"][data-name="${name}"]`);
      if (selected) selected.classList.add('selected');
    });
}

function loadActivePersona(el, folder) {
  fetch(`/api/drafts/${folder}/persona`, { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : { text: '' }))
    .then(({ text }) => {
      const ta = el.querySelector('#active-text');
      ta.value = text || '';
      originalPersona = ta.value;
    });
}

function loadProviderModelDropdowns(el, folder) {
  fetch(`/api/drafts/${folder}/models`, { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : { catalog: [], allowedModels: [] }))
    .then((data) => {
      const provSel = el.querySelector('#active-provider');
      const modelSel = el.querySelector('#active-model');
      const catalog = data.catalog || [];
      const allow = (data.allowedModels && data.allowedModels.length > 0)
        ? new Set(data.allowedModels.map((a) => `${a.provider}/${a.model}`))
        : null;
      const visible = allow ? catalog.filter((m) => allow.has(`${m.provider}/${m.id}`)) : catalog;
      const providers = [...new Set(visible.map((m) => m.provider))];
      provSel.innerHTML = '';
      for (const p of providers) provSel.add(new Option(p, p));
      const renderModels = () => {
        modelSel.innerHTML = '';
        for (const m of visible.filter((mm) => mm.provider === provSel.value)) {
          modelSel.add(new Option(m.displayName || m.id, m.id));
        }
      };
      provSel.addEventListener('change', () => { renderModels(); markDirty(el); });
      modelSel.addEventListener('change', () => markDirty(el));
      renderModels();
    });
}

function wireSubTabs(el, folder) {
  for (const btn of el.querySelectorAll('.sub-tab')) {
    btn.addEventListener('click', () => switchSubTab(el, folder, btn));
  }
}

async function switchSubTab(el, folder, btn) {
  for (const b of el.querySelectorAll('.sub-tab')) b.classList.remove('active');
  btn.classList.add('active');
  const sub = btn.dataset.sub;
  const ta = el.querySelector('#active-text');
  if (sub === 'my') {
    ta.removeAttribute('readonly');
    ta.value = originalPersona;
    // Re-fetch in case content changed from elsewhere; then refresh dirty state.
    try {
      const r = await fetch(`/api/drafts/${folder}/persona`, { credentials: 'same-origin' });
      if (r.ok) {
        const { text } = await r.json();
        ta.value = text || '';
        originalPersona = ta.value;
      }
    } catch { /* ignore */ }
    return;
  }
  ta.setAttribute('readonly', '');
  try {
    const r = await fetch(`/api/drafts/${folder}/persona-layers`, { credentials: 'same-origin' });
    if (!r.ok) { ta.value = '(failed to load layer)'; return; }
    const layers = await r.json();
    ta.value =
      sub === 'group' ? (layers.groupBase || '(no group base)') :
      sub === 'container' ? (layers.containerBase || '(no container base)') :
      sub === 'global' ? (layers.global || '(no global persona on this install)') :
      '';
  } catch {
    ta.value = '(error)';
  }
}

function wireDraftDetection(el) {
  el.querySelector('#active-text').addEventListener('input', () => markDirty(el));
}

function markDirty(el) {
  const ta = el.querySelector('#active-text');
  if (ta.hasAttribute('readonly')) return; // edits in read-only sub-tabs are noise
  if (ta.value !== originalPersona) {
    showDraftBanner(`${window.__pg.agent.name} has unsaved persona changes — chat is talking to a draft.`);
  } else {
    hideDraftBanner();
  }
}

function wireFilter(el) {
  el.querySelector('#lib-filter').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase().trim();
    for (const li of el.querySelectorAll('.lib-entry')) {
      const visible = !q || li.dataset.name.toLowerCase().includes(q);
      li.style.display = visible ? '' : 'none';
    }
  });
}

function prefetchLayerExistence(el, folder) {
  fetch(`/api/drafts/${folder}/persona-layers`, { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : {}))
    .then((layers) => {
      if (!layers.global) {
        const btn = el.querySelector('#sub-global');
        if (btn) btn.style.opacity = '0.4';
      }
    })
    .catch(() => { /* ignore */ });
}
