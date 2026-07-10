/**
 * Owner-only Status tab: scenario-aware fleet roster with spend/budget
 * columns, a budget editor, and an "Add a participant" form.
 *
 * Poll cadences:
 *   - GET /api/status   → every 5 s  (health / heartbeat)
 *   - GET /api/budgets  → every 30 s (cost data, also drives row filter)
 *
 * Rows are the INTERSECTION of /api/budgets agents (scenario members)
 * and /api/status agents — non-member entries (_default_participant etc.)
 * are silently skipped.
 */
const POLL_MS = 5000;
const BUDGET_POLL_MS = 30000;

function esc(s) {
  return String(s == null ? '' : s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function humanizeAge(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

// Module-level budget state — shared between the 5s status poll and the
// 30s budget poll so both renders always use the freshest budget data.
let budgetsByFolder = {};
let budgetCfg = { defaultMonthlyUsd: null, warnFraction: 0.8 };

async function loadBudgets(el) {
  try {
    const res = await fetch('/api/budgets', { credentials: 'same-origin' });
    if (!res.ok) {
      console.warn('[status] GET /api/budgets returned', res.status, '— keeping prior budget data');
      const hl = el.querySelector('#status-host');
      if (hl) hl.textContent = 'Budget data unavailable — roster hidden. Retrying…';
      return;
    }
    const data = await res.json();
    budgetsByFolder = {};
    for (const agent of data.agents || []) {
      budgetsByFolder[agent.folder] = agent;
    }
    budgetCfg = {
      defaultMonthlyUsd: data.defaultMonthlyUsd ?? null,
      warnFraction: data.warnFraction ?? 0.8,
    };
    // Prefill the budget editor inputs with the latest server values.
    const defaultInput = el.querySelector('#budget-default-usd');
    const warnInput = el.querySelector('#budget-warn-pct');
    if (defaultInput && !defaultInput.dataset.dirty) {
      defaultInput.value = budgetCfg.defaultMonthlyUsd != null ? budgetCfg.defaultMonthlyUsd : '';
    }
    if (warnInput && !warnInput.dataset.dirty) {
      warnInput.value = Math.round(budgetCfg.warnFraction * 100);
    }
    // Re-render the status rows now that budget data is fresh.
    await loadStatus(el);
  } catch (err) {
    console.warn('[status] loadBudgets error — keeping prior budget data:', err);
    const hl = el.querySelector('#status-host');
    if (hl) hl.textContent = 'Budget data unavailable — roster hidden. Retrying…';
  }
}

async function loadStatus(el) {
  const tbody = el.querySelector('#status-rows');
  const hostLine = el.querySelector('#status-host');
  if (!tbody || !hostLine) return;
  try {
    const res = await fetch('/api/status', { credentials: 'same-origin' });
    if (!res.ok) {
      hostLine.textContent = `Couldn't load status (${res.status}).`;
      return;
    }
    const data = await res.json();
    hostLine.textContent =
      `gateway: ${data.host.gatewayRunning ? 'up' : 'down'} · ` +
      `${data.host.activeContainers} active container(s) · v${data.host.version}`;
    tbody.innerHTML = '';
    for (const a of data.agents) {
      const b = budgetsByFolder[a.folder];
      // Skip agents that aren't in the scenario member list returned by
      // /api/budgets (e.g. _default_participant template, non-members).
      if (!b) continue;
      const activity =
        a.health === 'running'
          ? humanizeAge(a.heartbeatAgeMs)
          : humanizeAge(a.lastActivityAt ? Date.now() - Date.parse(a.lastActivityAt) : null);
      const spend =
        b.budgetUsd != null
          ? `$${b.costUsdThisMonth.toFixed(2)} / $${b.budgetUsd.toFixed(2)}`
          : `$${b.costUsdThisMonth.toFixed(2)}`;
      const badge =
        b.status === 'none'
          ? ''
          : `<span class="status-badge status-budget status-budget-${esc(b.status)}">${esc(b.status)}</span>`;
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td>${esc(b.roleLabel)}</td>` +
        `<td>${esc(b.name)} <span class="muted">${esc(a.folder)}</span></td>` +
        `<td>${esc(a.provider || '')}${a.model ? ' / ' + esc(a.model) : ''}</td>` +
        `<td><span class="status-badge status-${esc(a.health)}">${esc(a.health)}</span></td>` +
        `<td>${esc(activity)}</td>` +
        `<td>${esc(spend)} ${badge} <button class="btn btn-ghost status-budget-set" data-folder="${esc(a.folder)}">Set $</button></td>` +
        `<td><button class="btn btn-ghost status-restart" data-folder="${esc(a.folder)}">Restart</button></td>`;
      tbody.appendChild(tr);
    }
  } catch (err) {
    // Leave the last-rendered rows on a fetch error — stale data beats a blank table for ops.
    hostLine.textContent = `Couldn't load status: ${esc(String(err))}`;
  }
}

/** Render the budget editor section into the given container element. */
function renderBudgetEditor(container) {
  container.innerHTML = `
    <section class="card" id="budget-editor-card">
      <h2>Budget defaults</h2>
      <p class="muted">Set the default monthly spend limit and warning threshold for all participants. Override per-agent in the table below.</p>
      <div class="home-form" style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end;">
        <label>Default monthly $
          <input id="budget-default-usd" type="number" min="0" step="0.01"
            placeholder="none" style="width:100px;"
            value="${budgetCfg.defaultMonthlyUsd != null ? budgetCfg.defaultMonthlyUsd : ''}">
        </label>
        <label>Warn at %
          <input id="budget-warn-pct" type="number" min="1" max="100" step="1"
            placeholder="80" style="width:70px;"
            value="${Math.round(budgetCfg.warnFraction * 100)}">
        </label>
        <button id="budget-save-btn" class="btn btn-primary">Save</button>
        <span class="muted" id="budget-save-status"></span>
      </div>
    </section>`;
}

export function mountStatus(el) {
  el.innerHTML =
    `<div id="status-budget-editor"></div>` +
    `<section class="card"><h2>Fleet Roster</h2>` +
    `<p id="status-host" class="muted">loading…</p>` +
    `<table class="status-table"><thead><tr>` +
    `<th>Role</th><th>Agent</th><th>Model</th><th>Health</th><th>Activity</th><th>Spend / Budget</th><th></th>` +
    `</tr></thead><tbody id="status-rows"></tbody></table></section>`;

  renderBudgetEditor(el.querySelector('#status-budget-editor'));

  // app.js mounts each tab once; this guard also makes a future re-mount safe
  // (no duplicate click handlers → no double POSTs).
  if (!el._statusWired) {
    el.addEventListener('click', async (e) => {
      // Restart button
      const restartBtn = e.target.closest('.status-restart');
      if (restartBtn) {
        restartBtn.disabled = true;
        restartBtn.textContent = 'restarting…';
        try {
          const res = await fetch('/api/status/restart', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folder: restartBtn.dataset.folder }),
          });
          if (!res.ok) {
            const hostLine = el.querySelector('#status-host');
            if (hostLine) hostLine.textContent = `Restart failed (${res.status}).`;
          }
        } catch (err) {
          const hostLine = el.querySelector('#status-host');
          if (hostLine) hostLine.textContent = `Restart failed: ${String(err && err.message ? err.message : err)}`;
        } finally {
          await loadStatus(el);
        }
        return;
      }

      // Per-agent budget "Set $" button — prompt()-based so it survives re-renders
      const setBtn = e.target.closest('.status-budget-set');
      if (setBtn) {
        const folder = setBtn.dataset.folder;
        const b = budgetsByFolder[folder];
        const current = b && b.budgetUsd != null ? String(b.budgetUsd) : '';
        const input = window.prompt(`Monthly budget (USD) for ${folder} — blank to clear:`, current);
        if (input === null) return; // cancelled
        const trimmed = input.trim();
        const val = trimmed === '' ? null : Number(trimmed);
        if (val !== null && (!Number.isFinite(val) || val < 0)) {
          window.alert('Enter a number ≥ 0 or leave blank.');
          return;
        }
        try {
          const res = await fetch('/api/budgets', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ perAgent: { [folder]: val } }),
          });
          if (!res.ok) {
            const hl = el.querySelector('#status-host');
            if (hl) hl.textContent = `Budget update failed (${res.status}).`;
          }
        } catch (err) {
          const hl = el.querySelector('#status-host');
          if (hl) hl.textContent = `Budget update failed: ${String(err)}`;
        } finally {
          await loadBudgets(el);
        }
        return;
      }

      // Global budget Save button
      const saveBudgetBtn = e.target.closest('#budget-save-btn');
      if (saveBudgetBtn) {
        const statusEl = el.querySelector('#budget-save-status');
        const defaultInput = el.querySelector('#budget-default-usd');
        const warnInput = el.querySelector('#budget-warn-pct');
        const rawDefault = defaultInput ? defaultInput.value.trim() : '';
        const rawWarn = warnInput ? warnInput.value.trim() : '';
        const defaultVal = rawDefault === '' ? null : parseFloat(rawDefault);
        const warnVal = rawWarn === '' ? 80 : parseFloat(rawWarn);
        if (rawDefault !== '' && (isNaN(defaultVal) || defaultVal < 0)) {
          if (statusEl) statusEl.textContent = 'Invalid default budget value.';
          return;
        }
        if (isNaN(warnVal) || warnVal <= 0 || warnVal > 100) {
          if (statusEl) statusEl.textContent = 'Warn % must be between 1 and 100.';
          return;
        }
        saveBudgetBtn.disabled = true;
        if (statusEl) statusEl.textContent = 'Saving…';
        try {
          const res = await fetch('/api/budgets', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              defaultMonthlyUsd: defaultVal,
              warnFraction: warnVal / 100,
            }),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            if (statusEl) statusEl.textContent = `Save failed: ${err.error || res.status}`;
            return;
          }
          if (statusEl) statusEl.textContent = 'Saved.';
          // Clear dirty markers so next loadBudgets prefills from server.
          if (defaultInput) delete defaultInput.dataset.dirty;
          if (warnInput) delete warnInput.dataset.dirty;
          await loadBudgets(el);
        } catch (err) {
          if (statusEl) statusEl.textContent = `Save failed: ${esc(String(err))}`;
        } finally {
          saveBudgetBtn.disabled = false;
        }
        return;
      }
    });

    // Mark budget inputs dirty when user edits them so loadBudgets
    // doesn't overwrite what they're typing between polls.
    el.addEventListener('input', (e) => {
      if (e.target.id === 'budget-default-usd' || e.target.id === 'budget-warn-pct') {
        e.target.dataset.dirty = '1';
      }
    });

    el._statusWired = true;
  }

  if (el._statusPoll) clearInterval(el._statusPoll);
  if (el._budgetPoll) clearInterval(el._budgetPoll);

  // Initial load: fetch budgets first so the first status render has member
  // data available. loadBudgets calls loadStatus internally on success.
  loadBudgets(el);

  el._statusPoll = setInterval(() => {
    if (el.offsetParent !== null) loadStatus(el);
  }, POLL_MS);

  el._budgetPoll = setInterval(() => {
    if (el.offsetParent !== null) loadBudgets(el);
  }, BUDGET_POLL_MS);
}
