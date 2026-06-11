/**
 * Owner-only Status tab: host summary + per-agent health table with restart.
 * Polls GET /api/status every 5s while the tab panel is visible.
 */
const POLL_MS = 5000;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}
function humanizeAge(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

async function loadStatus(el) {
  const tbody = el.querySelector('#status-rows');
  const hostLine = el.querySelector('#status-host');
  if (!tbody || !hostLine) return;
  try {
    const res = await fetch('/api/status', { credentials: 'same-origin' });
    if (!res.ok) { hostLine.textContent = `Couldn't load status (${res.status}).`; return; }
    const data = await res.json();
    hostLine.textContent =
      `gateway: ${data.host.gatewayRunning ? 'up' : 'down'} · ` +
      `${data.host.activeContainers} active container(s) · v${data.host.version}`;
    tbody.innerHTML = '';
    for (const a of data.agents) {
      const tr = document.createElement('tr');
      const activity = a.health === 'running'
        ? humanizeAge(a.heartbeatAgeMs)
        : humanizeAge(a.lastActivityAt ? Date.now() - Date.parse(a.lastActivityAt) : null);
      tr.innerHTML =
        `<td>${esc(a.name)} <span class="muted">${esc(a.folder)}</span></td>` +
        `<td>${esc(a.provider || '')}${a.model ? ' / ' + esc(a.model) : ''}</td>` +
        `<td><span class="status-badge status-${esc(a.health)}">${esc(a.health)}</span></td>` +
        `<td>${esc(activity)}</td>` +
        `<td><button class="btn btn-ghost status-restart" data-folder="${esc(a.folder)}">Restart</button></td>`;
      tbody.appendChild(tr);
    }
  } catch (err) {
    // leave the last-rendered rows on a fetch error — stale data beats a blank table for ops.
    hostLine.textContent = `Couldn't load status: ${esc(String(err))}`;
  }
}

export function mountStatus(el) {
  el.innerHTML =
    `<section class="card"><h2>Status &amp; Health</h2>` +
    `<p id="status-host" class="muted">loading…</p>` +
    `<table class="status-table"><thead><tr>` +
    `<th>Agent</th><th>Model</th><th>Health</th><th>Activity</th><th></th>` +
    `</tr></thead><tbody id="status-rows"></tbody></table></section>`;

  // app.js mounts each tab once; this guard also makes a future re-mount safe
  // (no duplicate click handlers → no double POSTs).
  if (!el._statusWired) {
    el.addEventListener('click', async (e) => {
      const btn = e.target.closest('.status-restart');
      if (!btn) return;
      btn.disabled = true;
      btn.textContent = 'restarting…';
      try {
        const res = await fetch('/api/status/restart', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder: btn.dataset.folder }),
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
    });
    el._statusWired = true;
  }

  if (el._statusPoll) clearInterval(el._statusPoll);
  loadStatus(el);
  el._statusPoll = setInterval(() => {
    // hidden attr → display:none → offsetParent null → skip the fetch while another tab is shown
    if (el.offsetParent !== null) loadStatus(el);
  }, POLL_MS);
}
