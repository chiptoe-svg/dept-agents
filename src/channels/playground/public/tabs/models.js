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

  // Model grid
  const grid = document.createElement('div');
  grid.className = 'model-grid';
  for (const model of provider.catalogModels) {
    grid.appendChild(renderModelCard(model, provider, rootEl));
  }
  if (provider.catalogModels.length === 0) {
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

  // Selected = the model id is in allowedModels under ANY of the group's
  // member spec ids. Toggle writes to the canonical spec; deselect cleans
  // every sibling so the wire stays consistent.
  const memberIds = (group.members || []).map((m) => m.id);
  const isAllowed = allowedModelsCache.some(
    (a) => memberIds.includes(a.modelProvider) && a.model === model.id,
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
      toggleModel(model.id, group, card, rootEl);
    });
  }
  // Card body also clickable as a fallback (matches prior behavior); only
  // when the section is AVAILABLE.
  if (group.state === 'AVAILABLE') {
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => toggleModel(model.id, group, card, rootEl));
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

async function toggleModel(modelId, group, card, rootEl) {
  const memberIds = (group.members || []).map((m) => m.id);
  const isAllowed = allowedModelsCache.some(
    (a) => memberIds.includes(a.modelProvider) && a.model === modelId,
  );
  const nowAllowed = !isAllowed;

  // Snapshot for rollback.
  const before = allowedModelsCache.slice();

  // Optimistic local update — remove ALL sibling entries for this model
  // id, then add a fresh one under the canonical spec if turning on.
  allowedModelsCache = allowedModelsCache.filter(
    (a) => !(memberIds.includes(a.modelProvider) && a.model === modelId),
  );
  if (nowAllowed) {
    allowedModelsCache.push({ modelProvider: group.canonicalSpecId, model: modelId });
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
