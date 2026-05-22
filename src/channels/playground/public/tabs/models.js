import { showDraftBanner } from '../draft-banner.js';

let catalogCache = [];
let discoveredCache = [];
let allowedModelsCache = [];
let originalAllowed = [];
let activeModel = null;

export function mountModels(el) {
  const folder = window.__pg.agent.folder;

  el.innerHTML = `
    <div class="models-layout">
      <header class="models-header">
        <h3>Lock in which models your agent can use</h3>
        <p class="hint">💡 Local models cost $0 per token but spend your hardware. Cloud models cost real money but are faster on commodity laptops.</p>
      </header>

      <section class="model-section" data-provider="claude">
        <header class="model-section-header">
          <h4 class="models-section-title">Claude (Anthropic)</h4>
        </header>
        <div class="model-grid" data-grid="claude"></div>
      </section>

      <section class="model-section" data-provider="codex">
        <header class="model-section-header">
          <h4 class="models-section-title">Codex (OpenAI)</h4>
        </header>
        <div class="model-grid" data-grid="codex"></div>
      </section>

      <section class="model-section" data-provider="local">
        <header class="model-section-header">
          <h4 class="models-section-title">Local (your hardware)</h4>
          <span class="model-section-status" id="local-server-status">checking…</span>
        </header>
        <div class="model-grid" data-grid="local"></div>
      </section>
    </div>
  `;

  loadModels(el, folder);
}

function loadModels(el, folder) {
  fetch(`/api/drafts/${folder}/models`, { credentials: 'same-origin' })
    .then((r) =>
      r.ok
        ? r.json()
        : { catalog: [], discovered: [], allowedModels: [], activeModel: null, localServerOnline: null },
    )
    .then(async (data) => {
      catalogCache = data.catalog || [];
      discoveredCache = data.discovered || [];
      allowedModelsCache = data.allowedModels || [];
      activeModel = data.activeModel || null;
      originalAllowed = JSON.parse(JSON.stringify(allowedModelsCache));
      await renderSections(el);
      renderLocalServerStatus(el, data.localServerOnline);
    });
}

async function renderSections(el) {
  // Class-controls gates which provider sections render for non-owners.
  // Owner always sees every section so they can curate.
  const ac = window.__pg && window.__pg.activeClass;
  const isOwner = window.__pg && window.__pg.user && (window.__pg.user.role === 'owner' || window.__pg.user.role === 'ta');
  // v2 shape: providers is a map of { allow, provideDefault, allowByo }.
  // A provider is allowed if its `allow` flag is true. Null = no gating.
  const providerAllowed = isOwner || !ac
    ? null
    : (p) => !!(ac.providers && ac.providers[p] && ac.providers[p].allow);

  // ── classroom-provider-auth:models-status-pill START ──────────────────────

  let ccPolicies = {};
  try {
    const ccRes = await fetch('/api/class-controls', { credentials: 'same-origin' });
    const cc = await ccRes.json();
    ccPolicies = cc.classes?.default?.providers || {};
  } catch (err) {
    console.warn('[models] class-controls fetch failed', err);
  }

  async function providerStatusPill(providerId, policy) {
    try {
      const statusRes = await fetch(`/api/me/providers/${providerId}`, { credentials: 'same-origin' });
      const status = await statusRes.json();

      if (status.active === 'oauth') return { label: 'Your subscription', tone: 'good' };
      if (status.active === 'apiKey') return { label: 'Your API key', tone: 'good' };
      if (policy.provideDefault) return { label: 'Provided by instructor', tone: 'subtle' };
      if (policy.allowByo) return { label: 'Connect to use', tone: 'warn', action: 'goto:home' };
      return { label: 'Unavailable', tone: 'forbidden' };
    } catch (err) {
      console.warn('[models] providerStatusPill fetch failed', err);
      return { label: 'Unknown', tone: 'subtle' };
    }
  }

  function renderPill(pill) {
    const cls = `pill pill-${pill.tone}`;
    if (pill.action === 'goto:home') {
      return `<button type="button" class="${cls} pill-link" data-pg-goto-tab="home">${escapeHtml(pill.label)} →</button>`;
    }
    return `<span class="${cls}">${escapeHtml(pill.label)}</span>`;
  }

  const [claudePill, codexPill] = await Promise.all([
    ccPolicies.claude !== undefined ? providerStatusPill('claude', ccPolicies.claude) : Promise.resolve(null),
    ccPolicies.codex  !== undefined ? providerStatusPill('codex',  ccPolicies.codex)  : Promise.resolve(null),
  ]);

  const pillByProvider = { claude: claudePill, codex: codexPill };

  // ── classroom-provider-auth:models-status-pill END ────────────────────────

  for (const provider of ['claude', 'codex', 'local']) {
    const grid = el.querySelector(`[data-grid="${provider}"]`);
    if (!grid) continue;
    const section = grid.closest('.model-section');

    // Forbidden provider sections are hidden entirely.
    const pill = pillByProvider[provider];
    const isForbidden = pill && pill.tone === 'forbidden';
    if (section) section.hidden = isForbidden || !!(providerAllowed && !providerAllowed(provider));
    if (isForbidden) continue;

    // Inject status pill into the section title for cloud providers.
    if (pill && section) {
      const titleEl = section.querySelector('.models-section-title');
      if (titleEl) {
        titleEl.querySelectorAll('.pill').forEach((p) => p.remove());
        titleEl.insertAdjacentHTML('beforeend', renderPill(pill));
        const pillBtn = titleEl.querySelector('button[data-pg-goto-tab]');
        if (pillBtn && !pillBtn.dataset.bound) {
          pillBtn.dataset.bound = '1';
          pillBtn.addEventListener('click', () => {
            const dest = pillBtn.dataset.pgGotoTab;
            document.querySelector(`[data-tab="${dest}"]`)?.click();
          });
        }
      }
    }

    grid.innerHTML = '';

    const curated = catalogCache.filter((m) => m.provider === provider);
    const discovered = discoveredCache.filter((d) => d.provider === provider);

    if (curated.length === 0 && discovered.length === 0) {
      grid.innerHTML = `<div class="muted" style="grid-column: 1 / -1; padding: 12px;">No ${provider} models available. ${
        provider === 'local'
          ? 'Start mlx-omni-server on localhost:8000.'
          : `Add a provider key (${provider === 'claude' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'}) to .env.`
      }</div>`;
      continue;
    }

    for (const m of curated) {
      grid.appendChild(buildCard(m));
    }
    for (const d of discovered) {
      grid.appendChild(buildDiscoveredCard(d));
    }
  }
}

function isActive(model) {
  return activeModel && activeModel.provider === model.provider && activeModel.model === (model.id || model.model);
}

function buildCard(m) {
  const card = document.createElement('div');
  card.className = `model-card origin-${m.origin || 'cloud'}`;
  const isAllowed = allowedModelsCache.some((a) => a.provider === m.provider && a.model === m.id);
  if (isAllowed) card.classList.add('selected');
  if (isActive({ provider: m.provider, model: m.id })) card.classList.add('active');

  const chipsHtml = (m.chips || []).map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join('');
  // Prefer split rates when available (codex catalog uses these now); fall
  // back to the legacy single-rate field; only call it "$0 (local)" when
  // truly no pricing is set on the entry.
  let costLine;
  if (m.costPer1kInUsd != null || m.costPer1kOutUsd != null) {
    const parts = [];
    if (m.costPer1kInUsd != null) parts.push(`$${m.costPer1kInUsd} in`);
    if (m.costPer1kCachedInUsd != null) parts.push(`$${m.costPer1kCachedInUsd} cached`);
    if (m.costPer1kOutUsd != null) parts.push(`$${m.costPer1kOutUsd} out`);
    costLine = `${parts.join(' · ')} / 1k tokens`;
  } else if (m.costPer1kTokensUsd != null) {
    costLine = `$${m.costPer1kTokensUsd} / 1k tokens`;
  } else {
    costLine = m.origin === 'local' ? '$0 (local)' : '(pricing not set)';
  }
  const latencyLine = m.avgLatencySec != null ? `${m.avgLatencySec}s avg` : '? s';
  const paramsLine = `params: ${escapeHtml(m.paramCount || '?')}`;
  const modalitiesLine = `modalities: ${(m.modalities || ['?']).join(' + ')}`;
  const notes = m.notes ? `<div class="notes">📝 ${escapeHtml(m.notes)}</div>` : '';

  let localExtras = '';
  if (m.origin === 'local') {
    localExtras = `
      <div class="local-extras">
        ${m.host ? `host: <code>${escapeHtml(m.host)}</code><br>` : ''}
        ${m.contextSize ? `context: ${m.contextSize} · ` : ''}${
          m.quantization ? `quantization: ${escapeHtml(m.quantization)}` : ''
        }
      </div>`;
  }

  const activeBadge = isActive({ provider: m.provider, model: m.id })
    ? `<span class="active-badge">● Active</span>`
    : '';
  const star = m.default ? '★' : '☆';
  const starTitle = m.default
    ? `Default for ${m.provider} — click to unset`
    : `Set as default for ${m.provider}`;
  const starClass = m.default ? 'default-star is-default' : 'default-star';

  card.innerHTML = `
    <label class="model-head">
      <input type="checkbox" ${isAllowed ? 'checked' : ''}>
      <strong>${escapeHtml(m.displayName || m.id)}</strong>
      ${activeBadge}
      <button type="button" class="${starClass}" title="${starTitle}">${star}</button>
      <button type="button" class="edit-metadata-btn" title="Edit metadata">✏</button>
    </label>
    <div class="chips">${chipsHtml}</div>
    <div class="cost-line">${costLine} · ${latencyLine}</div>
    <div class="meta-line">${paramsLine} · ${modalitiesLine}</div>
    ${localExtras}
    ${notes}
  `;

  card.querySelector('input[type="checkbox"]').addEventListener('change', (e) => {
    toggleModel({ provider: m.provider, id: m.id }, e.target.checked, card);
  });
  card.querySelector('.edit-metadata-btn').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openAddMetadataModal({ provider: m.provider, id: m.id }, m);
  });
  card.querySelector('.default-star').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleDefault({ provider: m.provider, id: m.id });
  });
  return card;
}

function buildDiscoveredCard(d) {
  const card = document.createElement('div');
  card.className = `model-card origin-${d.provider === 'local' ? 'local' : 'cloud'} model-card-discovered`;
  const isAllowed = allowedModelsCache.some((a) => a.provider === d.provider && a.model === d.id);
  if (isAllowed) card.classList.add('selected');
  if (isActive({ provider: d.provider, model: d.id })) card.classList.add('active');

  const providerChip =
    d.provider === 'claude' ? '☁ Anthropic' : d.provider === 'codex' ? '☁ OpenAI' : '💻 local';
  const activeBadge = isActive({ provider: d.provider, model: d.id })
    ? `<span class="active-badge">● Active</span>`
    : '';

  card.innerHTML = `
    <label class="model-head">
      <input type="checkbox" ${isAllowed ? 'checked' : ''}>
      <strong>${escapeHtml(d.id)}</strong>
      ${activeBadge}
    </label>
    <div class="chips"><span class="chip">${escapeHtml(providerChip)}</span></div>
    <div class="meta-line muted">No curated metadata — bare model id from the provider's /v1/models.</div>
    <button class="add-metadata-btn" type="button">＋ Add metadata</button>
  `;

  card.querySelector('input[type="checkbox"]').addEventListener('change', (e) => {
    toggleModel({ provider: d.provider, id: d.id }, e.target.checked, card);
  });
  card.querySelector('.add-metadata-btn').addEventListener('click', () => openAddMetadataModal(d));
  return card;
}

async function toggleDefault({ provider, id }) {
  try {
    const r = await fetch('/api/catalog/toggle-default', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ provider, id }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      alert(`Set default failed: ${err.error || r.status}`);
      return;
    }
    // Reload — catalog merge order may shift now that local file gained an override.
    const el = document.querySelector('.models-layout').parentElement;
    const folder = window.__pg.agent.folder;
    loadModels(el, folder);
  } catch (err) {
    alert(`Set default failed: ${String(err)}`);
  }
}

async function toggleModel(model, checked, card) {
  // Update local cache.
  allowedModelsCache = allowedModelsCache.filter(
    (a) => !(a.provider === model.provider && a.model === model.id),
  );
  if (checked) {
    allowedModelsCache.push({ provider: model.provider, model: model.id });
    card.classList.add('selected');
  } else {
    card.classList.remove('selected');
  }

  // PUT to backend.
  const folder = window.__pg.agent.folder;
  try {
    const r = await fetch(`/api/drafts/${folder}/models`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ allowedModels: allowedModelsCache }),
    });
    if (!r.ok) throw new Error(`status ${r.status}`);
    if (JSON.stringify(allowedModelsCache) !== JSON.stringify(originalAllowed)) {
      showDraftBanner('Model whitelist changed.');
    }
    // Re-render so selection styling stays in sync.
    const el = document.querySelector('.models-layout').parentElement;
    renderSections(el);
  } catch {
    // Revert visual state on failure.
    if (checked) {
      allowedModelsCache = allowedModelsCache.filter(
        (a) => !(a.provider === model.provider && a.model === model.id),
      );
      card.classList.remove('selected');
      card.querySelector('input[type="checkbox"]').checked = false;
    }
  }
}

function renderLocalServerStatus(el, online) {
  const statusEl = el.querySelector('#local-server-status');
  if (!statusEl) return;
  // Server-side probe result. Browser-side fetches would see a different
  // "localhost" when the user accesses the playground from a different
  // machine (e.g. their phone over the LAN) and incorrectly report offline.
  if (online === true) {
    statusEl.textContent = '● online';
    statusEl.className = 'model-section-status status-online';
  } else if (online === false) {
    statusEl.textContent = '○ offline — start mlx-omni-server on :8000';
    statusEl.className = 'model-section-status status-offline';
  } else {
    statusEl.textContent = '';
    statusEl.className = 'model-section-status';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// "Add metadata" / "Edit metadata" modal. Discovered-card flow passes
// only the bare { provider, id } and the form starts blank (with the id
// pre-filled into displayName). Curated-card edit flow passes the full
// ModelEntry as a second arg; the form is pre-populated and modalities/
// modalities checkboxes reflect existing values. Save path is identical
// either way — PUT /api/catalog/local-entries handles dedupe by
// provider:id (replace-not-append).
function openAddMetadataModal(discovered, existing) {
  const editing = Boolean(existing);
  const title = editing ? `Edit metadata for <code>${escapeHtml(discovered.id)}</code>` : `Add metadata for <code>${escapeHtml(discovered.id)}</code>`;
  const subtitle = editing
    ? 'Updates the curated entry in <code>config/model-catalog-local.json</code>. Save replaces the existing entry by <code>provider:id</code>.'
    : 'Promotes this discovered model into a curated catalog entry. Saved to <code>config/model-catalog-local.json</code>. Only fill in what you know — required fields are marked.';

  const defaults = existing || {};
  const initialDisplayName = defaults.displayName || discovered.id;
  const initialParam = defaults.paramCount || '';
  const initialContext = defaults.contextSize || '';
  const initialQuant = defaults.quantization || '';
  const initialLatency = defaults.avgLatencySec || '';
  const initialNotes = defaults.notes || '';
  const initialBestFor = defaults.bestFor || '';
  const mods = Array.isArray(defaults.modalities) ? defaults.modalities : ['text'];

  const overlay = document.createElement('div');
  overlay.className = 'modal-backdrop';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <h3>${title}</h3>
      <p class="muted">${subtitle}</p>
      <button type="button" class="btn auto-fill-btn">✨ Auto-fill from ${escapeHtml(discovered.provider === 'local' ? 'HuggingFace' : 'built-in table')}</button>
      <div class="auto-fill-status muted"></div>
      <form id="add-metadata-form" class="add-metadata-form">
        <label>Display name <span class="required">*</span><br>
          <input name="displayName" required value="${escapeHtml(initialDisplayName)}" type="text"></label>
        <label>Parameter count<br>
          <input name="paramCount" type="text" placeholder="e.g. 27B" value="${escapeHtml(initialParam)}"></label>
        <fieldset>
          <legend>Modalities</legend>
          <label><input type="checkbox" name="modalities" value="text" ${mods.includes('text') ? 'checked' : ''}> text</label>
          <label><input type="checkbox" name="modalities" value="image" ${mods.includes('image') ? 'checked' : ''}> image</label>
          <label><input type="checkbox" name="modalities" value="audio" ${mods.includes('audio') ? 'checked' : ''}> audio</label>
        </fieldset>
        <label>Context size (tokens)<br>
          <input name="contextSize" type="number" placeholder="e.g. 32768" value="${escapeHtml(String(initialContext))}"></label>
        <label>Quantization<br>
          <input name="quantization" type="text" placeholder="e.g. MLX 4-bit" value="${escapeHtml(initialQuant)}"></label>
        <label>Average latency (seconds)<br>
          <input name="avgLatencySec" type="number" step="0.1" placeholder="e.g. 6" value="${escapeHtml(String(initialLatency))}"></label>
        <label>Notes<br>
          <textarea name="notes" rows="3" placeholder="Short user-facing description.">${escapeHtml(initialNotes)}</textarea></label>
        <label>Best for<br>
          <input name="bestFor" type="text" placeholder="When should someone pick this?" value="${escapeHtml(initialBestFor)}"></label>
        <div class="modal-actions">
          <button type="button" class="btn cancel-btn">Cancel</button>
          <button type="submit" class="btn primary">${editing ? 'Save changes' : 'Save'}</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('.cancel-btn').addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  const status = overlay.querySelector('.auto-fill-status');
  overlay.querySelector('.auto-fill-btn').addEventListener('click', async () => {
    status.textContent = 'Looking up…';
    try {
      const r = await fetch('/api/catalog/auto-fill', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ provider: discovered.provider, id: discovered.id }),
      });
      if (!r.ok) {
        status.textContent = `Lookup failed (${r.status}).`;
        return;
      }
      const data = await r.json();
      if (!data.suggestion) {
        status.textContent = `No metadata found in ${data.source}. Fill manually below.`;
        return;
      }
      // Populate form fields from suggestion.
      const form = overlay.querySelector('#add-metadata-form');
      const s = data.suggestion;
      if (s.displayName) form.elements.displayName.value = s.displayName;
      if (s.paramCount) form.elements.paramCount.value = s.paramCount;
      if (s.contextSize) form.elements.contextSize.value = s.contextSize;
      if (s.quantization) form.elements.quantization.value = s.quantization;
      if (s.avgLatencySec) form.elements.avgLatencySec.value = s.avgLatencySec;
      if (s.notes) form.elements.notes.value = s.notes;
      if (s.bestFor) form.elements.bestFor.value = s.bestFor;
      if (Array.isArray(s.modalities)) {
        for (const cb of form.querySelectorAll('input[name="modalities"]')) {
          cb.checked = s.modalities.includes(cb.value);
        }
      }
      status.textContent = `Populated from ${data.source}. Edit anything before saving.`;
    } catch (err) {
      status.textContent = `Lookup failed: ${String(err)}`;
    }
  });

  overlay.querySelector('#add-metadata-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const fd = new FormData(form);
    const modalities = fd.getAll('modalities');
    const entry = {
      id: discovered.id,
      provider: discovered.provider,
      displayName: String(fd.get('displayName') || discovered.id),
      origin: discovered.provider === 'local' ? 'local' : 'cloud',
    };
    const paramCount = String(fd.get('paramCount') || '').trim();
    if (paramCount) entry.paramCount = paramCount;
    if (modalities.length > 0) entry.modalities = modalities.map(String);
    const contextSize = Number(fd.get('contextSize'));
    if (contextSize > 0) entry.contextSize = contextSize;
    const quantization = String(fd.get('quantization') || '').trim();
    if (quantization) entry.quantization = quantization;
    const avgLatencySec = Number(fd.get('avgLatencySec'));
    if (avgLatencySec > 0) entry.avgLatencySec = avgLatencySec;
    const notes = String(fd.get('notes') || '').trim();
    if (notes) entry.notes = notes;
    const bestFor = String(fd.get('bestFor') || '').trim();
    if (bestFor) entry.bestFor = bestFor;
    // Local-only nicety: stamp host from the omlx convention so the card's
    // local-extras block populates the same way builtin entries do.
    if (discovered.provider === 'local') entry.host = 'http://localhost:8000';

    try {
      const r = await fetch('/api/catalog/local-entries', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ entry }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        alert(`Save failed: ${err.error || r.status}`);
        return;
      }
      close();
      // Reload models so the freshly-curated card replaces the discovered one.
      const el = document.querySelector('.models-layout').parentElement;
      const folder = window.__pg.agent.folder;
      loadModels(el, folder);
    } catch (err) {
      alert(`Save failed: ${String(err)}`);
    }
  });
}
