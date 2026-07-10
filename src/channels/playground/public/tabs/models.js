import { showDraftBanner } from '../draft-banner.js';
import { openCredDialog } from '../components/cred-dialog.js';
import { PROVIDER_GROUPS } from '../provider-groups.js';

// Allowlist state — what the instructor has whitelisted for this agent group.
// Kept as module state so toggleModel / re-renders stay in sync.
let allowedModelsCache = [];
let originalAllowed = [];

export function mountModels(el) {
  loadModels(el);
}

async function loadModels(el) {
  const folder = window.__pg.agent.folder;
  const res = await fetch(
    `/api/me/models-tab-state?agentGroupId=${encodeURIComponent(folder)}`,
    { credentials: 'same-origin' },
  );
  if (!res.ok) {
    el.textContent = `Failed to load models (${res.status})`;
    return;
  }
  const data = await res.json();

  // Also load the current allowedModels whitelist so cards can show selection.
  try {
    const wr = await fetch(`/api/drafts/${folder}/models`, { credentials: 'same-origin' });
    if (wr.ok) {
      const wdata = await wr.json();
      allowedModelsCache = (wdata.allowedModels || []).map((a) => ({
        modelProvider: a.provider ?? a.modelProvider,
        model: a.model,
      }));
      originalAllowed = JSON.parse(JSON.stringify(allowedModelsCache));
    }
  } catch {
    /* non-fatal — whitelist state just shows no selections */
  }

  const container = el;
  container.innerHTML = '';

  // Wrap in a models-layout div so existing CSS applies.
  const layout = document.createElement('div');
  layout.className = 'models-layout';
  container.appendChild(layout);

  const groups = groupSections(data.providers || []);

  let hiddenCount = 0;
  const hiddenNames = [];
  for (const group of groups) {
    if (group.state === 'HIDDEN') {
      hiddenCount++;
      hiddenNames.push(group.displayName);
      continue;
    }
    layout.appendChild(renderProviderSection(group, el));
  }
  if (hiddenCount > 0) layout.appendChild(renderHiddenFooter(hiddenCount, hiddenNames));
}

/**
 * Fold the per-spec provider list from /api/me/models-tab-state into the
 * 4 user-facing PROVIDER_GROUPS. Each output section has:
 *   id, displayName  — from PROVIDER_GROUPS
 *   state            — AVAILABLE if any member is AVAILABLE,
 *                      else GREYED if any is GREYED, else HIDDEN
 *   source           — first member's source that's non-null (canonical wins)
 *   actionLabel      — canonical member's actionLabel
 *   credentialFileShape — canonical member's shape (for cred-dialog routing)
 *   catalogModels    — concat of member catalogs, deduped by model id
 *                      (canonical spec wins; later members skip dupes)
 *   members          — original spec entries, useful for whitelist sibling
 *                      checks downstream
 */
function groupSections(providers) {
  const specsById = {};
  for (const p of providers) specsById[p.id] = p;

  const out = [];
  for (const group of PROVIDER_GROUPS) {
    const members = group.specIds.map((sid) => specsById[sid]).filter(Boolean);
    if (members.length === 0) continue;
    const canonical = specsById[group.canonicalSpecId] || members[0];

    // State aggregation: any AVAILABLE → AVAILABLE; else any GREYED → GREYED.
    let state = 'HIDDEN';
    if (members.some((m) => m.state === 'AVAILABLE')) state = 'AVAILABLE';
    else if (members.some((m) => m.state === 'GREYED')) state = 'GREYED';

    // Dedupe catalog by model id; canonical's entries come first.
    const orderedMembers = [canonical, ...members.filter((m) => m.id !== canonical.id)];
    const seenIds = new Set();
    const catalogModels = [];
    for (const m of orderedMembers) {
      for (const entry of m.catalogModels || []) {
        if (seenIds.has(entry.id)) continue;
        seenIds.add(entry.id);
        catalogModels.push(entry);
      }
    }

    out.push({
      id: group.id,
      displayName: group.displayName,
      state,
      source: members.find((m) => m.source)?.source ?? canonical.source ?? null,
      actionLabel: canonical.actionLabel ?? null,
      credentialFileShape: canonical.credentialFileShape ?? 'none',
      catalogModels,
      members,
      canonicalSpecId: canonical.id,
    });
  }
  return out;
}

function renderProviderSection(provider, rootEl) {
  const section = document.createElement('div');
  section.className = `model-section provider-section provider-section--${provider.state.toLowerCase()}`;
  if (provider.state === 'GREYED') section.style.opacity = '0.55';

  // Header row
  const headerDiv = document.createElement('div');
  headerDiv.className = 'model-section-header';
  headerDiv.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;padding-bottom:6px;border-bottom:1px solid var(--border);margin-bottom:10px';

  const titleGroup = document.createElement('div');
  titleGroup.style.fontSize = '14px';
  const titleB = document.createElement('b');
  titleB.textContent = provider.displayName;
  titleGroup.appendChild(titleB);

  if (provider.source) {
    const dot = document.createElement('span');
    dot.className = `status-dot status-dot--${provider.source}`;
    dot.style.cssText = 'margin-left:8px;font-size:11px';
    dot.textContent = statusPhrase(provider);
    titleGroup.appendChild(dot);
  } else if (provider.state === 'GREYED') {
    const dot = document.createElement('span');
    dot.className = 'status-dot status-dot--none';
    dot.style.cssText = 'margin-left:8px;font-size:11px';
    dot.textContent = statusPhrase(provider);
    titleGroup.appendChild(dot);
  }

  headerDiv.appendChild(titleGroup);

  // Per-section ↻ refresh. Busts the upstream /v1/models discovery
  // cache + reachability cache for the canonical spec of this group,
  // then re-renders the whole tab against the fresh server response.
  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'model-section-refresh';
  refreshBtn.textContent = '↻';
  refreshBtn.title = `Re-fetch ${provider.displayName} model list from the upstream server`;
  refreshBtn.style.cssText =
    'background:transparent;border:1px solid transparent;color:#888;font-size:14px;line-height:1;padding:2px 8px;border-radius:4px;cursor:pointer;margin-left:auto;margin-right:8px';
  refreshBtn.addEventListener('mouseenter', () => {
    refreshBtn.style.background = '#f1faf3';
    refreshBtn.style.color = '#2a8b34';
    refreshBtn.style.borderColor = '#cfe6d3';
  });
  refreshBtn.addEventListener('mouseleave', () => {
    refreshBtn.style.background = 'transparent';
    refreshBtn.style.color = '#888';
    refreshBtn.style.borderColor = 'transparent';
  });
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = '…';
    try {
      await refreshSection(provider.canonicalSpecId || provider.id, rootEl);
    } finally {
      refreshBtn.textContent = '↻';
      refreshBtn.disabled = false;
    }
  });
  headerDiv.appendChild(refreshBtn);

  if (provider.actionLabel) {
    const actionLink = document.createElement('a');
    actionLink.className = 'provider-action';
    // data-provider breadcrumb — handy for diagnostics (Playwright tests,
    // post-hoc DOM inspection). Functionally the click handler closes over
    // `provider` directly, so the attribute isn't load-bearing for routing.
    actionLink.setAttribute('data-provider', provider.id);
    actionLink.style.cssText = 'color:var(--brand-blue);font-size:11px;cursor:pointer';
    actionLink.textContent = provider.actionLabel;
    actionLink.addEventListener('click', () => {
      openCredDialog({
        providerId: provider.id,
        providerSpec: {
          id: provider.id,
          displayName: provider.displayName,
          credentialFileShape: provider.credentialFileShape ?? 'none',
        },
        currentCredState: {
          hasOAuth: provider.source === 'personal-oauth',
          hasApiKey: provider.source === 'personal-key',
        },
        onSaved: () => {
          const outerEl = document.querySelector('.models-layout')?.parentElement ?? document.getElementById('tab-models');
          if (outerEl) loadModels(outerEl);
        },
      });
    });
    headerDiv.appendChild(actionLink);
  }

  section.appendChild(headerDiv);

  // Model grid — filter out any models the user ✕'d earlier (per-agent
  // localStorage hide list, busted on refresh).
  const grid = document.createElement('div');
  grid.className = 'model-grid';
  const hidden = getHideList(provider.canonicalSpecId || provider.id);
  const visibleModels = provider.catalogModels.filter((m) => !hidden.has(m.id));
  for (const model of visibleModels) {
    grid.appendChild(renderModelCard(model, provider, rootEl));
  }
  if (visibleModels.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.style.cssText = 'grid-column:1/-1;padding:12px';
    empty.textContent =
      provider.state === 'GREYED'
        ? `${provider.displayName} is not yet connected.`
        : `No models available for ${provider.displayName}.`;
    grid.appendChild(empty);
  }
  section.appendChild(grid);

  return section;
}

function renderModelCard(model, group, rootEl) {
  const card = document.createElement('div');
  card.className = `model-card origin-${model.origin || 'cloud'}`;
  card.style.position = 'relative';

  // ✕ delete affordance — hides this model from the tab via the
  // per-agent hide list. Refresh (or removing it from the list) brings
  // it back. Lives on every card; cheap.
  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'model-card-delete';
  deleteBtn.textContent = '✕';
  deleteBtn.title = 'Hide this model from the Models tab (refresh to restore)';
  deleteBtn.style.cssText =
    'position:absolute;top:6px;right:8px;width:18px;height:18px;line-height:1;font-size:11px;background:transparent;color:#aaa;border:1px solid transparent;border-radius:3px;cursor:pointer;padding:0';
  deleteBtn.addEventListener('mouseenter', () => {
    deleteBtn.style.background = '#fdecea';
    deleteBtn.style.color = '#922b21';
    deleteBtn.style.borderColor = '#f5b7b1';
  });
  deleteBtn.addEventListener('mouseleave', () => {
    deleteBtn.style.background = 'transparent';
    deleteBtn.style.color = '#aaa';
    deleteBtn.style.borderColor = 'transparent';
  });
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    hideModel(group.canonicalSpecId || group.id, model.id);
    card.remove();
  });
  card.appendChild(deleteBtn);

  // Selected = the model id is in allowedModels under ANY name that
  // belongs to this group: spec id OR catalog modelProvider name. The two
  // are different namespaces ("codex" vs "openai-codex", "omlx" vs
  // "local") and historical data may use either.
  const groupNames = groupAllowedNames(group);
  const isAllowed = allowedModelsCache.some(
    (a) => groupNames.has(a.modelProvider) && a.model === model.id,
  );
  if (isAllowed) card.classList.add('selected');

  const chipsHtml = (model.chips ?? []).map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join(' ');

  // Extra info rows — bestFor, modalities, paramCount/contextSize.
  // Each appears only when the underlying catalog entry has it set.
  const modalityRow = (model.modalities && model.modalities.length)
    ? `<div class="model-modalities">${model.modalities.map((m) => escapeHtml(m)).join(' · ')}</div>`
    : '';
  const localSpecs = model.origin === 'local' && (model.paramCount || model.contextSize)
    ? `<div class="model-localspecs">${[
        model.paramCount ? `${escapeHtml(model.paramCount)}` : null,
        model.contextSize ? `${escapeHtml(String(model.contextSize))} ctx` : null,
        model.quantization ? `${escapeHtml(model.quantization)}` : null,
      ].filter(Boolean).join(' · ')}</div>`
    : '';
  const bestForRow = model.bestFor
    ? `<div class="model-bestfor">${escapeHtml(model.bestFor)}</div>`
    : '';

  const toggleLabel = isAllowed ? '✓ In chat' : '+ Add to chat';
  const toggleClass = isAllowed ? 'model-toggle is-allowed' : 'model-toggle';
  const toggleDisabled = group.state === 'AVAILABLE' ? '' : 'disabled';
  const toggleTitle = group.state === 'AVAILABLE'
    ? (isAllowed ? 'Remove from chat dropdown' : 'Add to chat dropdown')
    : `${group.displayName} is not yet connected.`;

  card.innerHTML = `
    <div class="model-head">
      <strong>${escapeHtml(model.displayName || model.id)}</strong>
      <button class="${toggleClass}" type="button" ${toggleDisabled} title="${escapeHtml(toggleTitle)}">${toggleLabel}</button>
    </div>
    <div class="chips">${chipsHtml}</div>
    <div class="cost-line">${escapeHtml(formatCostLatency(model))}</div>
    ${bestForRow}
    ${modalityRow}
    ${localSpecs}
  `;

  const toggleBtn = card.querySelector('button.model-toggle');
  if (toggleBtn && !toggleBtn.disabled) {
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleModel(model, group, card, rootEl);
    });
  }
  // Card body also clickable as a fallback (matches prior behavior); only
  // when the section is AVAILABLE.
  if (group.state === 'AVAILABLE') {
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => toggleModel(model, group, card, rootEl));
  }

  return card;
}

function renderHiddenFooter(count, names) {
  const div = document.createElement('div');
  div.style.cssText =
    'font-size:11px;color:var(--text-muted);text-align:center;font-style:italic;' +
    'padding-top:8px;border-top:1px dashed var(--border);margin-top:16px';
  div.textContent = `${count} provider${count === 1 ? '' : 's'} hidden — ${names.join(', ')} not enabled by instructor.`;
  return div;
}

function statusPhrase(provider) {
  if (provider.source === 'personal-oauth') return '● your subscription';
  if (provider.source === 'personal-key')   return '● your API key';
  if (provider.source === 'class-pool')     return '● class pool';
  if (provider.source === 'local')          return '● reachable';
  return '○ not connected';
}

function formatCostLatency(m) {
  if (m.origin === 'local') {
    const lat = m.avgLatencySec ? ` · ${m.avgLatencySec}s` : '';
    const params = m.paramCount ? ` · ${m.paramCount}` : '';
    return `free${lat}${params}`;
  }
  if (m.costPer1kInUsd != null || m.costPer1kOutUsd != null) {
    const parts = [];
    if (m.costPer1kInUsd != null) parts.push(`$${m.costPer1kInUsd} in`);
    if (m.costPer1kCachedInUsd != null) parts.push(`$${m.costPer1kCachedInUsd} cached`);
    if (m.costPer1kOutUsd != null) parts.push(`$${m.costPer1kOutUsd} out`);
    const cost = `${parts.join(' · ')} / 1k`;
    const lat = m.avgLatencySec ? ` · ${m.avgLatencySec}s` : '';
    return `${cost}${lat}`;
  }
  if (m.costPer1kTokensUsd != null) {
    return `$${m.costPer1kTokensUsd} / 1k tokens`;
  }
  return '(pricing not set)';
}

async function toggleModel(model, group, card, rootEl) {
  const modelId = model.id;
  const groupNames = groupAllowedNames(group);
  const isAllowed = allowedModelsCache.some(
    (a) => groupNames.has(a.modelProvider) && a.model === modelId,
  );
  const nowAllowed = !isAllowed;

  // Pre-add probe: send a 1-token "hi" so the user gets a real error
  // BEFORE the model lands in the chat dropdown and they discover it's
  // broken mid-conversation. Skip when removing (no point probing a
  // remove) and for providers that direct-chat doesn't dispatch yet
  // (clemson — class-pool by definition, instructor's job to ensure).
  if (nowAllowed && model.modelProvider !== 'clemson') {
    const btn = card.querySelector('button.model-toggle');
    const prevText = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = 'Testing…'; }
    clearCardError(card);
    const probe = await probeModel(model.modelProvider, modelId);
    if (btn) { btn.disabled = false; btn.textContent = prevText ?? '+ Add to chat'; }
    if (!probe.ok) {
      showCardError(card, probe.error || 'probe failed');
      return;
    }
  }

  // Snapshot for rollback.
  const before = allowedModelsCache.slice();

  // Wipe every entry that belongs to this group/model — spec ids AND
  // catalog modelProvider names — so legacy duplicates don't survive.
  allowedModelsCache = allowedModelsCache.filter(
    (a) => !(groupNames.has(a.modelProvider) && a.model === modelId),
  );
  if (nowAllowed) {
    // Write using the catalog model's actual modelProvider value (e.g.
    // 'openai-codex' for the OpenAI group). That's what the chat-tab
    // filter `${m.modelProvider}/${m.id}` looks up against the catalog.
    const candidate = (group.members || [])
      .flatMap((m) => m.catalogModels || [])
      .find((c) => c.id === modelId);
    const mp = candidate?.modelProvider ?? group.canonicalSpecId;
    allowedModelsCache.push({ modelProvider: mp, model: modelId });
    card.classList.add('selected');
    updateToggleLabel(card, true);
  } else {
    card.classList.remove('selected');
    updateToggleLabel(card, false);
  }

  const folder = window.__pg.agent.folder;
  const wireModels = allowedModelsCache.map((a) => ({ provider: a.modelProvider, model: a.model }));
  try {
    const r = await fetch(`/api/drafts/${folder}/models`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ allowedModels: wireModels }),
    });
    if (!r.ok) throw new Error(`status ${r.status}`);
    if (JSON.stringify(allowedModelsCache) !== JSON.stringify(originalAllowed)) {
      showDraftBanner('Model whitelist changed.');
    }
  } catch {
    // Revert on failure.
    allowedModelsCache = before;
    if (nowAllowed) {
      card.classList.remove('selected');
      updateToggleLabel(card, false);
    } else {
      card.classList.add('selected');
      updateToggleLabel(card, true);
    }
  }
}

async function refreshSection(specId, rootEl) {
  // Two parts to a refresh:
  //   1. server-side cache bust — model-discovery + reachability + (for
  //      clemson) the live-fetch cache. Returns a fresh derived state.
  //   2. local hide-list bust — anything the user ✕'d earlier in this
  //      group becomes visible again. Per user's request: refresh
  //      restores deleted models.
  const folder = window.__pg && window.__pg.agent && window.__pg.agent.folder;
  if (!folder) return;
  clearHideList(specId);
  await fetch(
    `/api/me/models-tab-state?agentGroupId=${encodeURIComponent(folder)}&refresh=${encodeURIComponent(specId)}`,
    { credentials: 'same-origin' },
  );
  await loadModels(rootEl);
}

/** localStorage-backed per-agent hide list. Key: `hidden-models:<folder>:<specId>`. */
function hideListKey(specId) {
  const folder = (window.__pg && window.__pg.agent && window.__pg.agent.folder) || '';
  return `hidden-models:${folder}:${specId}`;
}
function getHideList(specId) {
  try {
    const raw = localStorage.getItem(hideListKey(specId));
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}
function setHideList(specId, set) {
  try { localStorage.setItem(hideListKey(specId), JSON.stringify([...set])); } catch { /* quota — ignore */ }
}
function hideModel(specId, modelId) {
  const set = getHideList(specId);
  set.add(modelId);
  setHideList(specId, set);
}
function clearHideList(specId) {
  try { localStorage.removeItem(hideListKey(specId)); } catch { /* ignore */ }
}

/**
 * Probe the model by sending a 1-token "hi" through /api/direct-chat.
 * The direct-chat handler normalizes catalog modelProvider names
 * (openai-codex → codex, anthropic → claude, etc.) so we can pass the
 * raw modelProvider straight through. Returns {ok, error?}.
 * agentFolder is required by the handler (it authorizes the caller and
 * resolves the allowlist/cost-catalog lookup) — see direct-chat.ts.
 */
async function probeModel(modelProvider, modelId) {
  try {
    const r = await fetch('/api/direct-chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        provider: modelProvider,
        model: modelId,
        messages: [{ role: 'user', content: 'hi' }],
        agentFolder: window.__pg.agent.folder,
      }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      return { ok: false, error: body.error || `HTTP ${r.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function showCardError(card, message) {
  let err = card.querySelector('.model-card-error');
  if (!err) {
    err = document.createElement('div');
    err.className = 'model-card-error';
    card.appendChild(err);
  }
  err.textContent = `⚠ ${message}`;
}

function clearCardError(card) {
  const err = card.querySelector('.model-card-error');
  if (err) err.remove();
}

function groupAllowedNames(group) {
  // All identifiers under which an allowedModels entry might claim
  // membership in this group. Includes spec ids (codex, openai-platform,
  // claude, omlx, clemson) AND catalog modelProvider names
  // (openai-codex, openai-platform, anthropic, local, clemson). The two
  // are distinct namespaces and historical writes used spec ids.
  const names = new Set((group.members || []).map((m) => m.id));
  for (const m of group.members || []) {
    for (const entry of m.catalogModels || []) {
      if (entry.modelProvider) names.add(entry.modelProvider);
    }
  }
  return names;
}

function updateToggleLabel(card, allowed) {
  const btn = card.querySelector('button.model-toggle');
  if (!btn) return;
  btn.textContent = allowed ? '✓ In chat' : '+ Add to chat';
  btn.classList.toggle('is-allowed', allowed);
  btn.title = allowed ? 'Remove from chat dropdown' : 'Add to chat dropdown';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
