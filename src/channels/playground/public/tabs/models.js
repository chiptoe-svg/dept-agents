import { showDraftBanner } from '../draft-banner.js';
import { openCredDialog } from '../components/cred-dialog.js';

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

  let hiddenCount = 0;
  const hiddenNames = [];
  for (const provider of data.providers) {
    if (provider.state === 'HIDDEN') {
      hiddenCount++;
      hiddenNames.push(provider.displayName);
      continue;
    }
    layout.appendChild(renderProviderSection(provider, el));
  }
  if (hiddenCount > 0) layout.appendChild(renderHiddenFooter(hiddenCount, hiddenNames));
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

function renderModelCard(model, provider, rootEl) {
  const card = document.createElement('div');
  card.className = `model-card origin-${model.origin || 'cloud'}`;

  const isAllowed = allowedModelsCache.some(
    (a) => a.modelProvider === provider.id && a.model === model.id,
  );
  if (isAllowed) card.classList.add('selected');

  const chipsHtml = (model.chips ?? []).map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join(' ');

  card.innerHTML = `
    <div class="model-head" style="display:flex;align-items:baseline;gap:6px">
      <strong>${escapeHtml(model.displayName || model.id)}</strong>
    </div>
    <div class="chips">${chipsHtml}</div>
    <div class="cost-line">${escapeHtml(formatCostLatency(model))}</div>
  `;

  if (provider.state === 'AVAILABLE') {
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => selectModel(provider.id, model.id, card, rootEl));
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

async function selectModel(providerId, modelId, card, rootEl) {
  const isAllowed = allowedModelsCache.some(
    (a) => a.modelProvider === providerId && a.model === modelId,
  );
  const nowAllowed = !isAllowed;

  // Optimistic local update.
  allowedModelsCache = allowedModelsCache.filter(
    (a) => !(a.modelProvider === providerId && a.model === modelId),
  );
  if (nowAllowed) {
    allowedModelsCache.push({ modelProvider: providerId, model: modelId });
    card.classList.add('selected');
  } else {
    card.classList.remove('selected');
  }

  // PUT to backend — same endpoint and wire format as the old toggleModel.
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
    allowedModelsCache = allowedModelsCache.filter(
      (a) => !(a.modelProvider === providerId && a.model === modelId),
    );
    if (nowAllowed) {
      card.classList.remove('selected');
    } else {
      card.classList.add('selected');
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
