/**
 * Owner-only Admin tab — dept-server user provisioning, roster, model
 * defaults, and backstop-key health. Consumes the /api/admin/* endpoints
 * (src/channels/playground/api/admin.ts).
 *
 * Follows member-home.js's split: pure `render*` builders (el() +
 * textContent, never innerHTML with server/user data) separate from
 * `mountAdmin` (fetch + wire).
 */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('data') || k === 'disabled') node.setAttribute(k, v === true ? '' : v);
    else node[k] = v;
  }
  for (const c of children) node.append(c);
  return node;
}

async function getJson(url, fallback) {
  try {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (!r.ok) return fallback;
    return await r.json();
  } catch {
    return fallback;
  }
}

function fmtCost(n) {
  return `$${(typeof n === 'number' ? n : 0).toFixed(2)}`;
}

/** Pure: build one <tr> for the active-users table from an AdminUserRow. */
export function renderUserRow(user) {
  const tr = el('tr', { 'data-folder': user.folder });

  const modeTd = el('td');
  modeTd.append(el('span', { text: user.provider || '—' }));
  if (user.privateMode) modeTd.append(el('span', { class: 'badge', text: ' Private' }));

  const actionsTd = el('td');
  actionsTd.append(
    el('button', { class: 'btn btn-ghost', 'data-action': 'rotate', 'data-folder': user.folder, text: 'Rotate link' }),
  );
  actionsTd.append(
    el('button', { class: 'btn btn-danger', 'data-action': 'deactivate', 'data-folder': user.folder, text: 'Deactivate' }),
  );

  tr.append(
    el('td', { text: user.name }),
    el('td', { text: user.email || '—' }),
    modeTd,
    el('td', { text: user.model || '—' }),
    el('td', { text: user.lastActive || '—' }),
    el('td', { text: String(user.session ?? 0) }),
    el('td', { text: fmtCost(user.costMtd) }),
    actionsTd,
  );
  return tr;
}

/** Pure: build a `provider|model` <select>, options from `catalog`, pre-selected by `spec`. */
function buildModelSelect(name, catalog, spec) {
  const sel = el('select', { 'data-select': name });
  for (const m of catalog) {
    const opt = el('option', { value: `${m.modelProvider}|${m.model}`, text: m.displayName || m.model });
    if (spec && m.modelProvider === spec.provider && m.model === spec.model) opt.selected = true;
    sel.append(opt);
  }
  return sel;
}

/**
 * Pure: build the two model-default selectors (default-cloud + private)
 * from `cfg` (DeptModelConfig: {defaultCloud:{model,provider}, private:{model,provider}})
 * and `catalog` (flat [{modelProvider, model, displayName}] — same shape
 * the Models tab derives from /api/me/models-tab-state's catalogModels).
 */
export function renderModelDefaults(cfg, catalog) {
  const host = el('div', { class: 'admin-model-defaults-fields' });

  const cloudLabel = el('label', { text: 'Default cloud model' });
  cloudLabel.append(buildModelSelect('default-cloud', catalog, cfg?.defaultCloud));
  host.append(cloudLabel);

  const privateLabel = el('label', { text: 'Private model' });
  privateLabel.append(buildModelSelect('private', catalog, cfg?.private));
  host.append(privateLabel);

  return host;
}

/** Flatten /api/me/models-tab-state's per-provider catalogModels into a flat list. */
function flattenCatalog(providers) {
  const out = [];
  for (const p of providers || []) {
    for (const m of p.catalogModels || []) {
      out.push({ modelProvider: m.modelProvider, model: m.id, displayName: m.displayName || m.id });
    }
  }
  return out;
}

function renderAddUserPanel() {
  const section = el('section', { class: 'card', id: 'admin-add-user' });
  section.append(el('h2', { text: 'Add user' }));

  const nameInput = el('input', { type: 'text', placeholder: 'Full name', id: 'admin-add-name' });
  const emailInput = el('input', { type: 'email', placeholder: 'you@clemson.edu', id: 'admin-add-email' });
  const submitBtn = el('button', { class: 'btn btn-primary', type: 'submit', text: 'Add user' });
  const statusLine = el('span', { class: 'muted', id: 'admin-add-status' });

  const form = el('form', { id: 'admin-add-user-form' });
  form.append(
    el('label', { text: 'Name' }, nameInput),
    el('label', { text: 'Email' }, emailInput),
    submitBtn,
    statusLine,
  );
  section.append(form);

  const result = el('div', { id: 'admin-add-result' });
  section.append(result);
  return section;
}

function renderUsersPanel() {
  const section = el('section', { class: 'card', id: 'admin-users' });
  section.append(el('h2', { text: 'Active users' }));
  section.append(el('p', { class: 'muted', id: 'admin-users-status', text: 'Loading…' }));
  const table = el('table', { class: 'status-table' });
  const thead = el('tr');
  for (const h of ['Name', 'Email', 'Mode', 'Model', 'Last active', 'Sessions', 'Cost MTD', '']) {
    thead.append(el('th', { text: h }));
  }
  table.append(el('thead', {}, thead));
  table.append(el('tbody', { id: 'admin-users-rows' }));
  section.append(table);
  return section;
}

function renderModelDefaultsPanel() {
  const section = el('section', { class: 'card', id: 'admin-model-defaults' });
  section.append(el('h2', { text: 'Model defaults' }));
  section.append(el('div', { id: 'admin-model-defaults-host' }));
  section.append(el('button', { class: 'btn btn-primary', id: 'admin-model-defaults-save', text: 'Save' }));
  section.append(el('span', { class: 'muted', id: 'admin-model-defaults-status' }));
  return section;
}

function renderBackstopPanel() {
  const section = el('section', { class: 'card', id: 'admin-backstop' });
  section.append(el('h2', { text: 'Backstop health' }));
  section.append(el('p', { id: 'admin-backstop-body', text: 'Loading…' }));
  return section;
}

async function loadUsers(el0) {
  const statusLine = el0.querySelector('#admin-users-status');
  const tbody = el0.querySelector('#admin-users-rows');
  const data = await getJson('/api/admin/users', null);
  if (!data) {
    if (statusLine) statusLine.textContent = "Couldn't load users.";
    return;
  }
  if (statusLine) statusLine.textContent = '';
  tbody.replaceChildren();
  for (const u of data.users || []) tbody.append(renderUserRow(u));
}

async function loadModelDefaults(el0) {
  const host = el0.querySelector('#admin-model-defaults-host');
  const folder = (window.__pg && window.__pg.agent && window.__pg.agent.folder) || '';
  const [cfg, tabState] = await Promise.all([
    getJson('/api/admin/model-defaults', null),
    getJson(`/api/me/models-tab-state?agentGroupId=${encodeURIComponent(folder)}`, { providers: [] }),
  ]);
  const statusLine = el0.querySelector('#admin-model-defaults-status');
  if (!cfg) {
    if (statusLine) statusLine.textContent = "Couldn't load model defaults.";
    return;
  }
  const catalog = flattenCatalog(tabState.providers);
  host.replaceChildren();
  host.append(renderModelDefaults(cfg, catalog));
}

async function loadBackstopHealth(el0) {
  const body = el0.querySelector('#admin-backstop-body');
  const data = await getJson('/api/admin/backstop-health', null);
  if (!data) {
    if (body) body.textContent = "Couldn't load backstop health.";
    return;
  }
  if (body) {
    body.replaceChildren();
    body.append(el('span', { text: `Key: ${data.keyPresent ? 'present' : 'missing'} · MTD spend: ${fmtCost(data.spendMtd)}` }));
  }
}

/** Tab mount entry: build the four panels, fetch state, wire actions. */
export async function mountAdmin(el0) {
  el0.replaceChildren();
  el0.append(renderAddUserPanel(), renderUsersPanel(), renderModelDefaultsPanel(), renderBackstopPanel());

  // Add-user form submit.
  const form = el0.querySelector('#admin-add-user-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = el0.querySelector('#admin-add-name').value.trim();
    const email = el0.querySelector('#admin-add-email').value.trim();
    const statusLine = el0.querySelector('#admin-add-status');
    const resultEl = el0.querySelector('#admin-add-result');
    if (!name || !/@clemson\.edu$/i.test(email)) {
      statusLine.textContent = 'Name and a @clemson.edu email are required.';
      return;
    }
    statusLine.textContent = 'Adding…';
    resultEl.replaceChildren();
    try {
      const r = await fetch('/api/admin/users', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: name, email }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        statusLine.textContent = `Failed: ${body.error || r.status}`;
        return;
      }
      statusLine.textContent = 'Added.';
      renderLoginLinkResult(resultEl, body.folder, body.loginUrl);
      await loadUsers(el0);
    } catch (err) {
      statusLine.textContent = `Failed: ${String(err)}`;
    }
  });

  // Delegated actions: rotate/deactivate (users table), copy (add-user result).
  el0.addEventListener('click', async (e) => {
    const rotateBtn = e.target.closest('[data-action="rotate"]');
    if (rotateBtn) {
      const folder = rotateBtn.dataset.folder;
      rotateBtn.disabled = true;
      try {
        const r = await fetch(`/api/admin/users/${encodeURIComponent(folder)}/rotate-link`, {
          method: 'POST',
          credentials: 'same-origin',
        });
        const body = await r.json().catch(() => ({}));
        if (r.ok) {
          const resultEl = el0.querySelector('#admin-add-result');
          resultEl.replaceChildren();
          renderLoginLinkResult(resultEl, folder, body.loginUrl);
        }
      } finally {
        rotateBtn.disabled = false;
      }
      return;
    }

    const deactivateBtn = e.target.closest('[data-action="deactivate"]');
    if (deactivateBtn) {
      const folder = deactivateBtn.dataset.folder;
      if (!window.confirm(`Deactivate ${folder}? They will lose access immediately.`)) return;
      deactivateBtn.disabled = true;
      try {
        const r = await fetch(`/api/admin/users/${encodeURIComponent(folder)}/deactivate`, {
          method: 'POST',
          credentials: 'same-origin',
        });
        if (r.ok) await loadUsers(el0);
      } finally {
        deactivateBtn.disabled = false;
      }
      return;
    }

    const copyBtn = e.target.closest('[data-action="copy-login-url"]');
    if (copyBtn) {
      try {
        await navigator.clipboard.writeText(copyBtn.dataset.url);
        copyBtn.textContent = 'Copied!';
        setTimeout(() => {
          copyBtn.textContent = 'Copy';
        }, 1500);
      } catch {
        /* clipboard unavailable — no-op */
      }
    }
  });

  // Model-defaults save.
  el0.querySelector('#admin-model-defaults-save').addEventListener('click', async () => {
    const statusLine = el0.querySelector('#admin-model-defaults-status');
    const cloudSel = el0.querySelector('select[data-select="default-cloud"]');
    const privateSel = el0.querySelector('select[data-select="private"]');
    if (!cloudSel || !privateSel || !cloudSel.value || !privateSel.value) {
      statusLine.textContent = 'No models available to select.';
      return;
    }
    const [cloudProvider, cloudModel] = cloudSel.value.split('|');
    const [privateProvider, privateModel] = privateSel.value.split('|');
    statusLine.textContent = 'Saving…';
    try {
      const r = await fetch('/api/admin/model-defaults', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          defaultCloud: { provider: cloudProvider, model: cloudModel },
          private: { provider: privateProvider, model: privateModel },
        }),
      });
      statusLine.textContent = r.ok ? 'Saved.' : `Save failed (${r.status}).`;
    } catch (err) {
      statusLine.textContent = `Save failed: ${String(err)}`;
    }
  });

  await Promise.all([loadUsers(el0), loadModelDefaults(el0), loadBackstopHealth(el0)]);
}

function renderLoginLinkResult(host, folder, loginUrl) {
  host.append(
    el('p', { text: 'Login link: ' }, el('code', { text: loginUrl })),
    el('button', { class: 'btn btn-ghost', 'data-action': 'copy-login-url', 'data-url': loginUrl, text: 'Copy' }),
    el('button', { class: 'btn btn-ghost', 'data-action': 'rotate', 'data-folder': folder, text: 'Rotate' }),
  );
}
