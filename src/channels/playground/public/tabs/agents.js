/**
 * Agents tab — personal agent library.
 *
 * Shows the user's saved agent snapshots, lets them Save / Save As /
 * Load / Delete / Rename agents, and create new ones.
 *
 * Phase F of docs/superpowers/plans/2026-05-21-agent-library.md
 */

export function mountAgents(el) {
  const folder = window.__pg.agent.folder;
  const agentName = window.__pg.agent.name;

  el.innerHTML = `
    <div class="agents-layout">
      <header class="agents-header">
        <div class="agents-header-left">
          <span class="agents-title">Agents</span>
          <span id="agents-active-label" class="agents-active-label"></span>
          <span id="agents-dirty-badge" class="agents-dirty-badge" hidden>unsaved changes</span>
        </div>
        <div class="agents-header-right">
          <button id="agents-save-btn" class="btn btn-primary agents-save-btn" type="button">Save</button>
          <button id="agents-saveas-btn" class="btn agents-saveas-btn" type="button">Save As…</button>
          <button id="agents-new-btn" class="btn agents-new-btn" type="button">+ New Agent</button>
          <button id="agents-templates-btn" class="btn agents-templates-btn" type="button">Browse templates</button>
        </div>
      </header>

      <div id="agents-templates-panel" class="agents-templates-panel" hidden></div>

      <div id="agents-grid" class="agents-grid">
        <div class="agents-loading">Loading agents…</div>
      </div>
    </div>
  `;

  document.title = `Agents — ${agentName} · Agent Playground`;

  loadAgents(el, folder);
  wireHeaderButtons(el, folder);
}

// ── Data fetching ─────────────────────────────────────────────────────────

function loadAgents(el, folder) {
  fetch(`/api/drafts/${folder}/library`, { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : { entries: [], activeSlug: null }))
    .then((data) => renderAgents(el, folder, data.entries, data.activeSlug))
    .catch(() => {
      el.querySelector('#agents-grid').innerHTML = '<div class="agents-empty">Could not load agents.</div>';
    });
}

// ── Rendering ─────────────────────────────────────────────────────────────

function renderAgents(el, folder, entries, _activeSlug) {
  const grid = el.querySelector('#agents-grid');
  const activeLabel = el.querySelector('#agents-active-label');
  const dirtyBadge = el.querySelector('#agents-dirty-badge');
  const saveBtn = el.querySelector('#agents-save-btn');
  const saveAsBtn = el.querySelector('#agents-saveas-btn');
  const newBtn = el.querySelector('#agents-new-btn');

  const active = entries.find((e) => e.isActive);
  if (active) {
    activeLabel.textContent = `Active: ${active.name}`;
    dirtyBadge.hidden = !active.isDirty;
  } else {
    activeLabel.textContent = 'No active agent';
    dirtyBadge.hidden = true;
  }

  const atMax = entries.length >= 20;
  saveAsBtn.disabled = atMax;
  newBtn.disabled = atMax;
  saveAsBtn.title = atMax ? 'Library full — delete an agent to save a new one (max 20)' : '';
  newBtn.title = atMax ? 'Library full — delete an agent to add a new one (max 20)' : '';

  saveBtn.dataset.activeSlug = active ? active.slug : '';

  if (entries.length === 0) {
    grid.innerHTML = '<div class="agents-empty">No saved agents yet. Click <strong>Save As…</strong> to save your current agent.</div>';
    return;
  }

  grid.innerHTML = '';
  for (const entry of entries) {
    grid.appendChild(buildCard(el, folder, entry));
  }
}

function buildCard(el, folder, entry) {
  const card = document.createElement('div');
  card.className = 'agent-card' + (entry.isActive ? ' agent-card-active' : '');
  card.dataset.slug = entry.slug;

  const skillCount = entry.builtinSkills.length + entry.customSkillCount;

  // Card header row
  const header = document.createElement('div');
  header.className = 'agent-card-header';
  if (entry.isActive) {
    const dot = document.createElement('span');
    dot.className = 'agent-dot ' + (entry.isDirty ? 'agent-dot-dirty' : 'agent-dot-active');
    dot.title = entry.isDirty ? 'Unsaved changes' : 'Active';
    header.appendChild(dot);
  }
  const nameSpan = document.createElement('span');
  nameSpan.className = 'agent-card-name';
  nameSpan.textContent = entry.name;
  header.appendChild(nameSpan);
  card.appendChild(header);

  // Meta chips
  const meta = document.createElement('div');
  meta.className = 'agent-card-meta';
  const chip1 = document.createElement('span');
  chip1.className = 'agent-chip';
  chip1.textContent = `${entry.provider}/${entry.model || 'default'}`;
  const chip2 = document.createElement('span');
  chip2.className = 'agent-chip';
  chip2.textContent = `${skillCount} skill${skillCount !== 1 ? 's' : ''}${entry.customSkillCount > 0 ? ` (${entry.customSkillCount} custom)` : ''}`;
  meta.appendChild(chip1);
  meta.appendChild(chip2);
  card.appendChild(meta);

  // Description
  if (entry.description) {
    const desc = document.createElement('div');
    desc.className = 'agent-card-desc';
    desc.textContent = entry.description;
    card.appendChild(desc);
  }

  // Updated date
  const updated = document.createElement('div');
  updated.className = 'agent-card-updated';
  updated.textContent = `saved ${formatDate(entry.updatedAt)}`;
  card.appendChild(updated);

  // Action buttons
  const actions = document.createElement('div');
  actions.className = 'agent-card-actions';

  if (!entry.isActive) {
    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.className = 'btn agent-card-load';
    loadBtn.textContent = 'Load';
    loadBtn.addEventListener('click', () => doLoad(el, folder, entry.slug, entry.name));
    actions.appendChild(loadBtn);
  } else {
    const activeLabel = document.createElement('span');
    activeLabel.className = 'agent-card-active-label';
    activeLabel.textContent = 'Active';
    actions.appendChild(activeLabel);
  }

  const exportLink = document.createElement('a');
  exportLink.className = 'btn agent-card-export';
  exportLink.href = `/api/drafts/${folder}/library/${encodeURIComponent(entry.slug)}/export`;
  exportLink.textContent = 'Export ↓';
  exportLink.title = 'Download this agent as a zip for use in Claude Code, Codex, Gemini CLI, and more';
  actions.appendChild(exportLink);

  const renameBtn = document.createElement('button');
  renameBtn.type = 'button';
  renameBtn.className = 'btn agent-card-rename';
  renameBtn.textContent = 'Rename';
  renameBtn.addEventListener('click', () => showRenameModal(el, folder, entry.slug, entry.name, entry.description || ''));
  actions.appendChild(renameBtn);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'btn btn-danger agent-card-delete';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', () => doDelete(el, folder, entry.slug, entry.name));
  actions.appendChild(deleteBtn);

  card.appendChild(actions);
  return card;
}

// ── Header button wiring ──────────────────────────────────────────────────

function wireHeaderButtons(el, folder) {
  el.querySelector('#agents-save-btn').addEventListener('click', () => {
    const slug = el.querySelector('#agents-save-btn').dataset.activeSlug;
    if (slug) {
      doSaveExisting(el, folder, slug);
    } else {
      showSaveAsModal(el, folder);
    }
  });
  el.querySelector('#agents-saveas-btn').addEventListener('click', () => showSaveAsModal(el, folder));
  el.querySelector('#agents-new-btn').addEventListener('click', () => showNewAgentModal(el, folder));
  el.querySelector('#agents-templates-btn').addEventListener('click', () => toggleTemplatesPanel(el, folder));
}

// ── Actions ───────────────────────────────────────────────────────────────

function doLoad(el, folder, slug, name) {
  const dirtyBadge = el.querySelector('#agents-dirty-badge');
  if (!dirtyBadge.hidden) {
    showConfirmModal(
      `Load "${name}"?`,
      'Your current agent has unsaved changes. Loading another agent will discard them.',
      'Load anyway',
      () => performLoad(el, folder, slug),
    );
  } else {
    performLoad(el, folder, slug);
  }
}

function performLoad(el, folder, slug) {
  fetch(`/api/drafts/${folder}/library/${encodeURIComponent(slug)}/load`, {
    method: 'POST',
    credentials: 'same-origin',
  })
    .then((r) => {
      if (!r.ok) return r.json().then((e) => { throw new Error(e.error || r.status); });
      showToast('Agent loaded — container will restart on next message.');
      loadAgents(el, folder);
    })
    .catch((err) => showToast(`Load failed: ${String(err)}`, 'error'));
}

function doSaveExisting(el, folder, slug) {
  fetch(`/api/drafts/${folder}/library/${encodeURIComponent(slug)}/save`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ includeMemory: false }),
  })
    .then((r) => {
      if (!r.ok) return r.json().then((e) => { throw new Error(e.error || r.status); });
      showToast('Agent saved.');
      loadAgents(el, folder);
    })
    .catch((err) => showToast(`Save failed: ${String(err)}`, 'error'));
}

function doDelete(el, folder, slug, name) {
  showConfirmModal(
    `Delete "${name}"?`,
    'This cannot be undone.',
    'Delete',
    () => {
      fetch(`/api/drafts/${folder}/library/${encodeURIComponent(slug)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      })
        .then((r) => {
          if (!r.ok) return r.json().then((e) => { throw new Error(e.error || r.status); });
          showToast(`"${name}" deleted.`);
          loadAgents(el, folder);
        })
        .catch((err) => showToast(`Delete failed: ${String(err)}`, 'error'));
    },
  );
}

// ── Modals ────────────────────────────────────────────────────────────────

function buildModalShell(title, bodyFn, onOk) {
  const root = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const modal = document.createElement('div');
  modal.className = 'modal';

  const h = document.createElement('h3');
  h.textContent = title;
  modal.appendChild(h);

  bodyFn(modal);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn';
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  const okBtn = document.createElement('button');
  okBtn.id = 'modal-ok';
  okBtn.type = 'button';
  actions.appendChild(cancelBtn);
  actions.appendChild(okBtn);
  modal.appendChild(actions);
  backdrop.appendChild(modal);
  root.appendChild(backdrop);

  const close = () => { root.innerHTML = ''; };
  cancelBtn.addEventListener('click', close);
  okBtn.addEventListener('click', async () => {
    const keepOpen = await onOk(modal, okBtn);
    if (!keepOpen) close();
  });
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  return { modal, okBtn, close };
}

function showSaveAsModal(el, folder) {
  buildModalShell('Save current agent as…', (modal) => {
    const p1 = document.createElement('p');
    const lbl1 = document.createElement('label');
    lbl1.textContent = 'Name ';
    const inp = document.createElement('input');
    inp.id = 'modal-name';
    inp.type = 'text';
    inp.maxLength = 64;
    inp.placeholder = 'My agent';
    inp.autocomplete = 'off';
    lbl1.appendChild(inp);
    p1.appendChild(lbl1);
    modal.insertBefore(p1, modal.querySelector('.modal-actions'));

    const p2 = document.createElement('p');
    const lbl2 = document.createElement('label');
    lbl2.textContent = 'Description (optional) ';
    const inp2 = document.createElement('input');
    inp2.id = 'modal-desc';
    inp2.type = 'text';
    inp2.maxLength = 200;
    inp2.placeholder = 'What this agent does';
    inp2.autocomplete = 'off';
    lbl2.appendChild(inp2);
    p2.appendChild(lbl2);
    modal.insertBefore(p2, modal.querySelector('.modal-actions'));

    const p3 = document.createElement('p');
    const lbl3 = document.createElement('label');
    lbl3.className = 'modal-checkbox';
    const chk = document.createElement('input');
    chk.id = 'modal-memory';
    chk.type = 'checkbox';
    lbl3.appendChild(chk);
    lbl3.append(' Include memory snapshot (CLAUDE.local.md)');
    p3.appendChild(lbl3);
    modal.insertBefore(p3, modal.querySelector('.modal-actions'));

    const ok = modal.querySelector('#modal-ok');
    ok.className = 'btn btn-primary';
    ok.textContent = 'Save';
    setTimeout(() => inp.focus(), 0);
  }, (modal) => {
    const name = modal.querySelector('#modal-name').value.trim();
    if (!name) { modal.querySelector('#modal-name').focus(); return true; }
    const desc = modal.querySelector('#modal-desc').value.trim();
    const mem = modal.querySelector('#modal-memory').checked;
    fetch(`/api/drafts/${folder}/library`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ name, description: desc, includeMemory: mem }),
    })
      .then((r) => (r.ok ? r.json() : r.json().then((e) => { throw new Error(e.error || r.status); })))
      .then(() => { showToast('Agent saved.'); loadAgents(el, folder); })
      .catch((err) => showToast(`Save failed: ${String(err)}`, 'error'));
  });
}

function showRenameModal(el, folder, slug, currentName, currentDesc) {
  buildModalShell('Rename agent', (modal) => {
    const p1 = document.createElement('p');
    const lbl1 = document.createElement('label');
    lbl1.textContent = 'Name ';
    const inp = document.createElement('input');
    inp.id = 'modal-name';
    inp.type = 'text';
    inp.maxLength = 64;
    inp.value = currentName;
    inp.autocomplete = 'off';
    lbl1.appendChild(inp);
    p1.appendChild(lbl1);
    modal.insertBefore(p1, modal.querySelector('.modal-actions'));

    const p2 = document.createElement('p');
    const lbl2 = document.createElement('label');
    lbl2.textContent = 'Description ';
    const inp2 = document.createElement('input');
    inp2.id = 'modal-desc';
    inp2.type = 'text';
    inp2.maxLength = 200;
    inp2.value = currentDesc;
    inp2.autocomplete = 'off';
    lbl2.appendChild(inp2);
    p2.appendChild(lbl2);
    modal.insertBefore(p2, modal.querySelector('.modal-actions'));

    const ok = modal.querySelector('#modal-ok');
    ok.className = 'btn btn-primary';
    ok.textContent = 'Rename';
    setTimeout(() => { inp.focus(); inp.select(); }, 0);
  }, (modal) => {
    const name = modal.querySelector('#modal-name').value.trim();
    if (!name) { modal.querySelector('#modal-name').focus(); return true; }
    const desc = modal.querySelector('#modal-desc').value.trim();
    fetch(`/api/drafts/${folder}/library/${encodeURIComponent(slug)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ name, description: desc }),
    })
      .then((r) => {
        if (!r.ok) return r.json().then((e) => { throw new Error(e.error || r.status); });
        loadAgents(el, folder);
      })
      .catch((err) => showToast(`Rename failed: ${String(err)}`, 'error'));
  });
}

function showNewAgentModal(el, folder) {
  buildModalShell('New agent', (modal) => {
    const p1 = document.createElement('p');
    const lbl1 = document.createElement('label');
    lbl1.textContent = 'Name ';
    const inp = document.createElement('input');
    inp.id = 'modal-name';
    inp.type = 'text';
    inp.maxLength = 64;
    inp.placeholder = 'My new agent';
    inp.autocomplete = 'off';
    lbl1.appendChild(inp);
    p1.appendChild(lbl1);
    modal.insertBefore(p1, modal.querySelector('.modal-actions'));

    const p2 = document.createElement('p');
    const lbl2 = document.createElement('label');
    lbl2.textContent = 'Description (optional) ';
    const inp2 = document.createElement('input');
    inp2.id = 'modal-desc';
    inp2.type = 'text';
    inp2.maxLength = 200;
    inp2.placeholder = 'What this agent does';
    inp2.autocomplete = 'off';
    lbl2.appendChild(inp2);
    p2.appendChild(lbl2);
    modal.insertBefore(p2, modal.querySelector('.modal-actions'));

    const hint = document.createElement('p');
    hint.className = 'modal-hint';
    hint.textContent = 'Copies your current agent configuration (persona, skills, model). Edit it from the Persona, Skills, and Models tabs.';
    modal.insertBefore(hint, modal.querySelector('.modal-actions'));

    const ok = modal.querySelector('#modal-ok');
    ok.className = 'btn btn-primary';
    ok.textContent = 'Create & load';
    setTimeout(() => inp.focus(), 0);
  }, (modal) => {
    const name = modal.querySelector('#modal-name').value.trim();
    if (!name) { modal.querySelector('#modal-name').focus(); return true; }
    const desc = modal.querySelector('#modal-desc').value.trim();
    fetch(`/api/drafts/${folder}/library`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ name, description: desc, includeMemory: false }),
    })
      .then((r) => (r.ok ? r.json() : r.json().then((e) => { throw new Error(e.error || r.status); })))
      .then(({ slug }) =>
        fetch(`/api/drafts/${folder}/library/${encodeURIComponent(slug)}/load`, {
          method: 'POST',
          credentials: 'same-origin',
        }),
      )
      .then((r) => {
        if (!r.ok) return r.json().then((e) => { throw new Error(e.error || r.status); });
        showToast(`"${name}" created and loaded.`);
        loadAgents(el, folder);
      })
      .catch((err) => showToast(`Create failed: ${String(err)}`, 'error'));
  });
}

function showConfirmModal(title, message, confirmLabel, onConfirm) {
  const root = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const modal = document.createElement('div');
  modal.className = 'modal';

  const h = document.createElement('h3');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = message;
  modal.appendChild(h);
  modal.appendChild(p);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn';
  cancelBtn.textContent = 'Cancel';
  const okBtn = document.createElement('button');
  okBtn.type = 'button';
  okBtn.className = 'btn btn-danger';
  okBtn.textContent = confirmLabel;
  actions.appendChild(cancelBtn);
  actions.appendChild(okBtn);
  modal.appendChild(actions);
  backdrop.appendChild(modal);
  root.appendChild(backdrop);

  const close = () => { root.innerHTML = ''; };
  cancelBtn.addEventListener('click', close);
  okBtn.addEventListener('click', () => { close(); onConfirm(); });
}

// ── Templates panel ───────────────────────────────────────────────────────

function toggleTemplatesPanel(el, folder) {
  const panel = el.querySelector('#agents-templates-panel');
  const btn = el.querySelector('#agents-templates-btn');
  if (!panel.hidden) {
    panel.hidden = true;
    btn.textContent = 'Browse templates';
    return;
  }
  btn.textContent = 'Loading…';
  btn.disabled = true;
  fetch('/api/library/defaults', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : { templates: [] }))
    .then((data) => {
      renderTemplatesPanel(el, folder, panel, data.templates || []);
      panel.hidden = false;
      btn.textContent = 'Hide templates';
    })
    .catch(() => {
      renderTemplatesPanel(el, folder, panel, []);
      panel.hidden = false;
      btn.textContent = 'Hide templates';
    })
    .finally(() => {
      btn.disabled = false;
    });
}

function renderTemplatesPanel(el, folder, panel, templates) {
  panel.replaceChildren();
  const heading = document.createElement('div');
  heading.className = 'agents-templates-heading';
  heading.textContent = 'Default templates';
  panel.appendChild(heading);

  if (templates.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'agents-templates-empty';
    empty.textContent = 'No templates available.';
    panel.appendChild(empty);
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'agents-templates-grid';
  for (const tpl of templates) {
    grid.appendChild(buildTemplateCard(el, folder, tpl));
  }
  panel.appendChild(grid);
}

function buildTemplateCard(el, folder, tpl) {
  const card = document.createElement('div');
  card.className = 'agent-card agents-template-card';

  const nameEl = document.createElement('div');
  nameEl.className = 'agent-card-name';
  nameEl.textContent = tpl.name;
  card.appendChild(nameEl);

  if (tpl.description) {
    const desc = document.createElement('div');
    desc.className = 'agent-card-desc';
    desc.textContent = tpl.description;
    card.appendChild(desc);
  }

  const useBtn = document.createElement('button');
  useBtn.type = 'button';
  useBtn.className = 'btn btn-primary agents-template-use';
  useBtn.textContent = 'Use this template';
  useBtn.addEventListener('click', () => showFromTemplateModal(el, folder, tpl));
  card.appendChild(useBtn);

  return card;
}

function showFromTemplateModal(el, folder, tpl) {
  buildModalShell(`Use template: ${tpl.name}`, (modal) => {
    const p1 = document.createElement('p');
    const lbl1 = document.createElement('label');
    lbl1.textContent = 'Name ';
    const inp = document.createElement('input');
    inp.id = 'modal-name';
    inp.type = 'text';
    inp.maxLength = 64;
    inp.value = tpl.name;
    inp.autocomplete = 'off';
    lbl1.appendChild(inp);
    p1.appendChild(lbl1);
    modal.insertBefore(p1, modal.querySelector('.modal-actions'));

    const p2 = document.createElement('p');
    const lbl2 = document.createElement('label');
    lbl2.textContent = 'Description (optional) ';
    const inp2 = document.createElement('input');
    inp2.id = 'modal-desc';
    inp2.type = 'text';
    inp2.maxLength = 200;
    inp2.value = tpl.description || '';
    inp2.autocomplete = 'off';
    lbl2.appendChild(inp2);
    p2.appendChild(lbl2);
    modal.insertBefore(p2, modal.querySelector('.modal-actions'));

    const ok = modal.querySelector('#modal-ok');
    ok.className = 'btn btn-primary';
    ok.textContent = 'Create from template';
    setTimeout(() => { inp.focus(); inp.select(); }, 0);
  }, (modal) => {
    const name = modal.querySelector('#modal-name').value.trim();
    if (!name) { modal.querySelector('#modal-name').focus(); return true; }
    const desc = modal.querySelector('#modal-desc').value.trim();
    fetch(`/api/drafts/${folder}/library/from-template`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ templateSlug: tpl.slug, name, description: desc }),
    })
      .then((r) => (r.ok ? r.json() : r.json().then((e) => { throw new Error(e.error || r.status); })))
      .then(() => {
        showToast(`”${name}” created from template and loaded.`);
        // Collapse the templates panel and refresh the agent list
        const templatePanel = el.querySelector('#agents-templates-panel');
        const templateBtn = el.querySelector('#agents-templates-btn');
        if (templatePanel) templatePanel.hidden = true;
        if (templateBtn) templateBtn.textContent = 'Browse templates';
        loadAgents(el, folder);
      })
      .catch((err) => showToast(`Create failed: ${String(err)}`, 'error'));
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return iso.slice(0, 10);
  }
}

function showToast(message, kind = 'info') {
  const container = document.getElementById('toasts');
  if (!container) return;
  const t = document.createElement('div');
  t.className = `toast toast-${kind}`;
  t.textContent = message;
  container.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}
