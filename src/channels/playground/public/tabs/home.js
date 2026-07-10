import { openCredDialog } from '../components/cred-dialog.js';
import { PROVIDER_GROUPS } from '../provider-groups.js';

export function mountHome(el) {
  const { agent, user } = window.__pg || { agent: { name: '?', folder: '?' }, user: { id: '?' } };
  const isOwner = user && (user.role === 'owner' || user.role === 'ta');

  const params = new URLSearchParams(location.search);
  const googleConnected = params.get('google_connected') === '1';
  const googleDenied = params.get('google_auth_error') === 'denied';
  const providerConnected = params.get('provider_connected');
  const providerAuthError = params.get('provider_auth_error');
  if (googleConnected || googleDenied) {
    const cleaned = new URL(location.href);
    cleaned.searchParams.delete('google_connected');
    cleaned.searchParams.delete('google_auth_error');
    history.replaceState({}, '', cleaned.pathname + (cleaned.search === '?' ? '' : cleaned.search));
  }
  if (providerConnected || providerAuthError) {
    const cleaned = new URL(location.href);
    cleaned.searchParams.delete('provider_connected');
    cleaned.searchParams.delete('provider_auth_error');
    history.replaceState({}, '', cleaned.pathname + (cleaned.search === '?' ? '' : cleaned.search));
  }

  // Owner-only "Class controls" card. Toggles tabs/providers/auth modes
  // for non-owners. Inserted just below Profile so it's the first thing
  // the instructor sees when they land. Hidden entirely for students.
  const classControlsCard = isOwner
    ? `
      <section class="home-card" id="class-controls-card">
        <h2>Class controls</h2>
        <p class="muted">Choose what students see in the playground. You always see everything.</p>
        <div id="class-controls-body"><p class="muted">Loading…</p></div>
      </section>`
    : '';

  const defaultParticipantCard = isOwner
    ? `
      <section class="home-card" id="default-participant-card">
        <h2>Default Participant Template</h2>
        <p class="muted">Configure the starting persona applied to every new (or reset) Participant.</p>
        <div id="default-participant-body"><p class="muted">Loading…</p></div>
      </section>`
    : '';

  const webSearchCard = isOwner
    ? `
      <section class="home-card" id="web-search-card">
        <h2>Web Search</h2>
        <p class="muted">Choose which search backend agents use. Unavailable backends are greyed out.</p>
        <div id="web-search-body"><p class="muted">Loading…</p></div>
      </section>`
    : '';

  el.innerHTML = `
    <div class="home-layout">
      <section class="home-card">
        <h2>Profile</h2>
        <p class="greeting">Welcome, <strong>${escapeHtml(user.id || 'guest')}</strong>.</p>
        <dl class="home-dl">
          <dt>Current agent</dt>
          <dd><strong>${escapeHtml(agent.name || '?')}</strong> <span class="muted">(${escapeHtml(agent.folder || '?')})</span></dd>
          <dt>Sign-in identity</dt>
          <dd><code>${escapeHtml(user.id || 'anonymous')}</code></dd>
          ${isOwner ? `<dt>Role</dt><dd><strong>owner</strong> <span class="muted">(class instructor)</span></dd>` : ''}
        </dl>
      </section>

      ${classControlsCard}

      ${defaultParticipantCard}

      ${webSearchCard}

      <section class="home-card">
        <h2>Settings</h2>
        <p class="muted">Manage your playground session.</p>
        <div class="home-actions">
          <button id="logout-btn" class="btn">Log out (this session)</button>
          <button id="logout-all-btn" class="btn btn-danger">Log out everywhere</button>
        </div>
      </section>

      <section class="home-card" id="telegram-card">
        <h2>Telegram</h2>
        <div id="telegram-card-body">
          <p class="muted">Checking status…</p>
        </div>
      </section>

      <section class="home-card" id="google-card">
        <h2>Google</h2>
        ${googleConnected ? `<p class="muted" id="google-connected-banner">Google account connected.</p>` : ''}
        ${googleDenied ? `<p class="muted" id="google-denied-banner">Connection cancelled.</p>` : ''}
        <div id="google-card-body">
          <p class="muted">Checking status…</p>
        </div>
      </section>

      <!-- classroom-provider-auth:providers-card START -->
      <section class="home-card" id="providers-card">
        <h2>LLM Providers</h2>
        <div id="providers-card-body"><p class="muted">Loading…</p></div>
      </section>
      <!-- classroom-provider-auth:providers-card END -->

      <section class="home-card" id="usage-card">
        <h2>API credits</h2>
        <div id="usage-card-body"><p class="muted">Loading…</p></div>
      </section>

      <section class="home-card">
        <h2>Session</h2>
        <p class="muted">Session started: <strong id="session-start">${new Date().toLocaleString()}</strong></p>
      </section>

      <section class="home-card">
        <h2>Help</h2>
        <p>This is the agent playground. Use the tabs above to chat with your agent, edit its persona, configure skills, and pick which models it's allowed to use.</p>
        <p>Drafts are auto-tracked — the yellow banner at the top appears when you have unsaved changes. Use <strong>Apply</strong> to commit, <strong>Save to my library</strong> to keep a named snapshot, or <strong>Discard</strong> to revert.</p>
        <p class="muted">Need a fresh login link? Run <code>/playground</code> again on your chat platform.</p>
      </section>
    </div>
  `;

  el.querySelector('#logout-btn').addEventListener('click', async () => {
    try {
      await fetch('/api/me/logout', { method: 'POST', credentials: 'same-origin' });
    } catch {
      /* ignore */
    }
    window.location.href = '/login';
  });

  el.querySelector('#logout-all-btn').addEventListener('click', async () => {
    if (!confirm('Log out of ALL sessions for this account? Other devices will also need to re-authenticate.')) return;
    try {
      await fetch('/api/me/logout-all', { method: 'POST', credentials: 'same-origin' });
    } catch {
      /* ignore */
    }
    window.location.href = '/login';
  });

  renderTelegramCard(el.querySelector('#telegram-card-body'));
  renderGoogleCard(el.querySelector('#google-card-body'));
  renderProvidersCard(el.querySelector('#providers-card-body'));
  renderUsageCard(el.querySelector('#usage-card-body'), agent.folder);

  if (isOwner) {
    renderClassControlsCard(el.querySelector('#class-controls-body'));
    renderDefaultParticipantCard(el.querySelector('#default-participant-body'));
    renderWebSearchCard(el.querySelector('#web-search-body'));
  }
}

function fmtUsd(n) {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1000000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1000000).toFixed(2)}M`;
}

async function renderUsageCard(body, folder) {
  if (!body || !folder || folder === '?') {
    if (body) body.innerHTML = `<p class="muted">No agent context — usage unavailable.</p>`;
    return;
  }
  try {
    // Class scope: only OpenAI/codex usage counts for billing this term.
    // Strip claude + local rows so the rollup matches what shows up on
    // platform.openai.com → usage. Change ?providers= here when you
    // start charging multiple backends.
    const res = await fetch(`/api/usage/${folder}?providers=codex`, { credentials: 'same-origin' });
    if (!res.ok) {
      body.innerHTML = `<p class="muted">Couldn't load usage (${res.status}).</p>`;
      return;
    }
    const data = await res.json();
    const tm = data.thisMonth;
    const tot = data.total;
    const monthRows =
      tm.byModel.length === 0
        ? `<tr><td colspan="4" class="muted">No usage this month yet.</td></tr>`
        : tm.byModel
            .map(
              (m) => `
            <tr>
              <td><code>${escapeHtml(m.model)}</code> <span class="muted">(${escapeHtml(m.provider)})</span></td>
              <td>${fmtTokens(m.tokensIn)}</td>
              <td>${fmtTokens(m.tokensOut)}</td>
              <td>${fmtUsd(m.costUsd)}</td>
            </tr>`,
            )
            .join('');
    body.innerHTML = `
      <div class="usage-rollup">
        <div class="usage-box">
          <span class="usage-label">This month</span>
          <span class="usage-cost">${fmtUsd(tm.costUsd)}</span>
          <span class="muted">${fmtTokens(tm.tokensIn)} in · ${fmtTokens(tm.tokensOut)} out</span>
        </div>
        <div class="usage-box">
          <span class="usage-label">All-time</span>
          <span class="usage-cost">${fmtUsd(tot.costUsd)}</span>
          <span class="muted">${fmtTokens(tot.tokensIn)} in · ${fmtTokens(tot.tokensOut)} out</span>
        </div>
      </div>
      <table class="usage-table">
        <thead><tr><th>Model</th><th>In</th><th>Out</th><th>Cost</th></tr></thead>
        <tbody>${monthRows}</tbody>
      </table>
      <p class="muted small">Cost = tokens × per-model rate from catalog. Cached-token billing not yet tracked.</p>
    `;
  } catch (err) {
    body.innerHTML = `<p class="muted">Couldn't load usage: ${escapeHtml(String(err))}</p>`;
  }
}

const ALL_TABS = ['home', 'simple', 'chat', 'persona', 'skills', 'models', 'agents', 'sources', 'retrieval', 'benchmarks'];
const ALL_AUTH = ['api-key', 'oauth', 'claude-code-oauth'];
const AUTH_LABEL = {
  'api-key': 'API key',
  oauth: 'OAuth (Anthropic Console / OpenAI)',
  'claude-code-oauth': 'Claude Code OAuth',
};

// ── Default Participant Template card ────────────────────────────────────────

async function renderDefaultParticipantCard(body) {
  if (!body) return;
  try {
    const res = await fetch('/api/default-participant', { credentials: 'same-origin' });
    if (!res.ok) {
      body.innerHTML = `<p class="muted">Couldn't load default participant status (${res.status}).</p>`;
      return;
    }
    const data = await res.json();
    renderDefaultParticipantForm(body, data);
  } catch (err) {
    body.innerHTML = `<p class="muted">Couldn't load default participant status: ${escapeHtml(String(err))}</p>`;
  }
}

function renderDefaultParticipantForm(body, data) {
  const { saved, savedAt, savedBy, templateFolder, participantCount } = data;

  const savedLine = saved
    ? `<p class="muted small">Saved ${escapeHtml(savedAt || '')}${savedBy ? ` by ${escapeHtml(savedBy)}` : ''}.</p>`
    : `<p class="muted small">No default saved yet.</p>`;

  body.innerHTML = `
    <dl class="home-dl">
      <dt>Template folder</dt>
      <dd><code>${escapeHtml(templateFolder)}</code></dd>
      <dt>Status</dt>
      <dd>${saved ? '✅ Saved' : '⚪ Not saved'}</dd>
      <dt>Participants</dt>
      <dd>${escapeHtml(String(participantCount))} agent${participantCount === 1 ? '' : 's'}</dd>
    </dl>
    ${savedLine}
    <div class="home-actions" id="dp-actions">
      <button class="btn" id="dp-edit-btn">Edit template</button>
      <button class="btn btn-primary" id="dp-save-btn">Save as default</button>
      <button class="btn btn-danger" id="dp-apply-btn" ${participantCount === 0 ? 'disabled title="No participants yet"' : ''}>Apply default to all Participants</button>
    </div>
    <p class="muted small" id="dp-status"></p>
    <p class="muted small" id="dp-apply-result" hidden></p>
  `;

  // Edit template: navigate to the playground with ?seat=<templateFolder> so
  // the owner's session loads the template agent. The entire editor
  // (persona/skills/models/agents tabs) then operates on that agent group.
  body.querySelector('#dp-edit-btn').addEventListener('click', () => {
    window.location.href = '/playground/?seat=' + encodeURIComponent(templateFolder);
  });

  // Save as default
  body.querySelector('#dp-save-btn').addEventListener('click', async () => {
    const statusEl = body.querySelector('#dp-status');
    statusEl.textContent = 'Saving…';
    try {
      const res = await fetch('/api/default-participant/save', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        statusEl.textContent = `Save failed: ${err.error || res.status}`;
        return;
      }
      const result = await res.json();
      statusEl.textContent = `Saved at ${result.savedAt || 'unknown time'}.`;
      // Refresh the saved-state line without a full card reload.
      const savedLineEl = body.querySelector('.muted.small');
      if (savedLineEl) {
        savedLineEl.textContent = `Saved ${result.savedAt || ''}`;
      }
    } catch (err) {
      statusEl.textContent = `Save failed: ${String(err)}`;
    }
  });

  // Apply default to all Participants
  body.querySelector('#dp-apply-btn').addEventListener('click', async () => {
    const statusEl = body.querySelector('#dp-status');
    const resultEl = body.querySelector('#dp-apply-result');
    const confirmToken = prompt(
      `This will overwrite all ${participantCount} Participant agent${participantCount === 1 ? '' : 's'} with the saved default.\n` +
        `A restore point will be created for each one.\n\nType APPLY to confirm:`,
    );
    if (confirmToken !== 'APPLY') {
      statusEl.textContent = 'Cancelled.';
      return;
    }
    statusEl.textContent = 'Applying…';
    try {
      const res = await fetch('/api/default-participant/apply-all', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ confirm: 'APPLY' }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        statusEl.textContent = `Apply failed: ${err.error || res.status}`;
        return;
      }
      const result = await res.json();
      const affected = Number(result.affected) || 0;
      statusEl.textContent = '';
      resultEl.hidden = false;
      resultEl.textContent =
        `Applied to ${affected} Participant${affected === 1 ? '' : 's'}. ` +
        `Each now has a pre-default-reset-* restore point in their library.`;
    } catch (err) {
      statusEl.textContent = `Apply failed: ${String(err)}`;
    }
  });
}

// ── Web Search backend card ───────────────────────────────────────────────────

async function renderWebSearchCard(body) {
  if (!body) return;
  try {
    const res = await fetch('/api/web-search-config', { credentials: 'same-origin' });
    if (!res.ok) {
      body.innerHTML = `<p class="muted">Couldn't load web search config (${res.status}).</p>`;
      return;
    }
    const data = await res.json();
    renderWebSearchForm(body, data);
  } catch (err) {
    body.innerHTML = `<p class="muted">Couldn't load web search config: ${escapeHtml(String(err))}</p>`;
  }
}

function renderWebSearchForm(body, data) {
  const { active, backends } = data;

  const rows = (backends || [])
    .map((b) => {
      const noteHtml = b.note ? ` <span class="muted" style="font-size:0.85em">${escapeHtml(b.note)}</span>` : '';
      return `
        <div style="margin: 0.35rem 0;">
          <label style="${b.available ? '' : 'color: var(--muted-color, #888);'}">
            <input type="radio" name="web-search-backend" value="${escapeHtml(b.id)}"
              ${active === b.id ? 'checked' : ''}
              ${b.available ? '' : 'disabled'}>
            ${escapeHtml(b.label)}
          </label>${noteHtml}
        </div>`;
    })
    .join('');

  body.innerHTML = `
    <div id="ws-backends">${rows}</div>
    <p class="muted small" id="ws-status"></p>
  `;

  body.querySelectorAll('input[name="web-search-backend"]').forEach((radio) => {
    radio.addEventListener('change', async () => {
      const statusEl = body.querySelector('#ws-status');
      const chosen = radio.value;
      const chosenBackend = (backends || []).find((b) => b.id === chosen);
      statusEl.textContent = 'Switching…';
      try {
        const res = await fetch('/api/web-search-config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ provider: chosen }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          statusEl.textContent = err.error || `Request failed (${res.status}).`;
          return;
        }
        const result = await res.json();
        const activeLabel = chosenBackend ? chosenBackend.label : result.active;
        statusEl.textContent = `Switched to ${activeLabel} — agents use it on their next message (containers respawned).`;
      } catch (err) {
        statusEl.textContent = `Switch failed: ${String(err)}`;
      }
    });
  });
}

async function renderClassControlsCard(body) {
  if (!body) return;
  try {
    const res = await fetch('/api/class-controls', { credentials: 'same-origin' });
    if (!res.ok) {
      body.innerHTML = `<p class="muted">Couldn't load class controls (${res.status}).</p>`;
      return;
    }
    const cfg = await res.json();
    renderClassControlsForm(body, cfg);
  } catch (err) {
    body.innerHTML = `<p class="muted">Couldn't load class controls: ${escapeHtml(String(err))}</p>`;
  }
}

function renderClassControlsForm(body, cfg) {
  // v2 shape: cfg.classes.default.{tabsVisibleToStudents, authModesAvailable,
  //   providers: { [id]: { allow, provideDefault, allowByo } } }
  const DEFAULT_CLASS_ID = 'default';
  const cls = (cfg.classes && cfg.classes[DEFAULT_CLASS_ID]) || {
    tabsVisibleToStudents: [],
    authModesAvailable: [],
    providers: {},
  };
  const tabsChecks = ALL_TABS.map(
    (t) => `
    <label class="cc-check"><input type="checkbox" data-cc-tab="${t}" ${cls.tabsVisibleToStudents.includes(t) ? 'checked' : ''}> ${t}</label>
  `,
  ).join('');
  // ── classroom-provider-auth:class-controls-providers START ────────────
  // Group toggles use AND-on-read / broadcast-on-write across underlying
  // spec ids — see plans/class-controls-provider-grouping.md.
  const policies = cls.providers || {};
  const unconfigured = !cls.providers || Object.keys(cls.providers).length === 0;
  const unconfiguredBanner = unconfigured
    ? `<div class="cc-banner-warn">⚠ Class mode not yet configured — pick provider policies below, then Save.</div>`
    : '';
  const groupFlag = (group, field) =>
    group.specIds.length > 0 && group.specIds.every((sid) => !!(policies[sid] && policies[sid][field]));
  // providedReady is shipped on the GET response — true when the owner
  // has a usable credential for at least one member spec (sibling
  // fallback included). Used to disable the Provided checkbox so the
  // instructor can't accidentally promise students access to a provider
  // whose class-pool key isn't actually connected.
  const providedReady = cfg.providedReady || {};
  const groupProvidedReady = (group) => group.specIds.some((sid) => providedReady[sid]);
  const providerRows = PROVIDER_GROUPS.map((g) => {
    const ready = groupProvidedReady(g);
    const provided = groupFlag(g, 'provideDefault');
    const providedCell = ready
      ? `<input type="checkbox" data-cc-group-provided="${g.id}" ${provided ? 'checked' : ''}>`
      : `<input type="checkbox" data-cc-group-provided="${g.id}" disabled ${provided ? 'checked' : ''} title="Connect a ${escapeHtml(g.displayName)} credential in the LLM Providers card first">`;
    return `
        <tr ${ready ? '' : 'class="cc-row-provided-blocked"'}>
          <td>${escapeHtml(g.displayName)}</td>
          <td><input type="checkbox" data-cc-group-visible="${g.id}" ${groupFlag(g, 'allow') ? 'checked' : ''}></td>
          <td>${providedCell}</td>
          <td><input type="checkbox" data-cc-group-byo="${g.id}" ${groupFlag(g, 'allowByo') ? 'checked' : ''}></td>
        </tr>`;
  }).join('');
  const providersBlock = `
    <table class="cc-providers-table">
      <thead><tr><th>Provider</th><th>Visible</th><th>Provided</th><th>Let students auth themselves</th></tr></thead>
      <tbody>${providerRows}</tbody>
    </table>
  `;
  // ── classroom-provider-auth:class-controls-providers END ──────────────

  body.innerHTML = `
    ${unconfiguredBanner}
    <div class="cc-group">
      <h3>Tabs visible to students</h3>
      <div class="cc-row">${tabsChecks}</div>
    </div>
    <div class="cc-group">
      <h3>Providers available</h3>
      ${providersBlock}
    </div>
    <div class="home-actions">
      <button class="btn btn-primary" id="cc-save" disabled>Apply</button>
      <span class="muted" id="cc-status"></span>
    </div>
  `;

  // Dirty tracking: snapshot the rendered form's checked state, then on
  // any change compare and enable/disable the Apply button. Recapture
  // after a successful save so the button greys out again.
  const snapshotForm = () => {
    const snap = {};
    body.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      const key = cb.dataset.ccTab
        ? `tab:${cb.dataset.ccTab}`
        : cb.dataset.ccGroupVisible
          ? `vis:${cb.dataset.ccGroupVisible}`
          : cb.dataset.ccGroupProvided
            ? `prov:${cb.dataset.ccGroupProvided}`
            : cb.dataset.ccGroupByo
              ? `byo:${cb.dataset.ccGroupByo}`
              : null;
      if (key) snap[key] = cb.checked;
    });
    return snap;
  };
  let initialSnap = snapshotForm();
  const applyBtn = body.querySelector('#cc-save');
  const refreshApplyState = () => {
    const current = snapshotForm();
    const dirty = Object.keys(current).some((k) => current[k] !== initialSnap[k]);
    applyBtn.disabled = !dirty;
  };
  body.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', refreshApplyState);
  });

  applyBtn.addEventListener('click', async () => {
    // Preserve unknown-spec entries (e.g. future specs registered on the
    // host but not yet in PROVIDER_GROUPS) so a UI save doesn't clobber
    // them. Then broadcast each group toggle to every underlying spec id.
    const providers = { ...policies };
    for (const g of PROVIDER_GROUPS) {
      const visible = body.querySelector(`[data-cc-group-visible="${g.id}"]`)?.checked || false;
      const provided = body.querySelector(`[data-cc-group-provided="${g.id}"]`)?.checked || false;
      const byo = body.querySelector(`[data-cc-group-byo="${g.id}"]`)?.checked || false;
      for (const sid of g.specIds) {
        providers[sid] = { allow: visible, provideDefault: provided, allowByo: byo };
      }
    }
    const next = {
      classes: {
        default: {
          tabsVisibleToStudents: [...body.querySelectorAll('[data-cc-tab]')]
            .filter((i) => i.checked)
            .map((i) => i.dataset.ccTab),
          authModesAvailable: cls.authModesAvailable || [],
          providers,
        },
      },
    };
    const status = body.querySelector('#cc-status');
    status.textContent = 'Saving…';
    try {
      const res = await fetch('/api/class-controls', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(next),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        status.textContent = `Save failed: ${err.error || res.status}`;
        return;
      }
      status.textContent = 'Applied. Students will see the new settings on their next page load.';
      // Reset the dirty baseline so the button greys out again until
      // the next edit.
      initialSnap = snapshotForm();
      refreshApplyState();
    } catch (err) {
      status.textContent = `Apply failed: ${String(err)}`;
    }
  });
}

async function renderTelegramCard(body) {
  // In bypass+seats mode, non-owner seats have user.id = null and share the
  // owner's session. The API would return the owner's Telegram pairing which
  // is wrong to show to TAs/students. Skip the lookup entirely.
  if (!window.__pg?.user?.id) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Telegram pairing is linked to your personal account.';
    body.replaceChildren(p);
    return;
  }
  try {
    const res = await fetch('/api/me/telegram', { credentials: 'same-origin' });
    if (!res.ok) {
      body.innerHTML = `<p class="muted">Telegram pairing not available (${res.status}).</p>`;
      return;
    }
    const data = await res.json();
    if (data.paired) {
      body.innerHTML = `
        <p>✅ Connected as <code>${escapeHtml(data.telegramHandle || '?')}</code>${
          data.botUsername ? ` via <strong>@${escapeHtml(data.botUsername)}</strong>` : ''
        }.</p>
        <p class="muted">DM the bot from your own Telegram account to chat with your class agent — same agent as on the web.</p>
      `;
      return;
    }
    if (!data.botUsername) {
      body.innerHTML = `
        <p>The instructor hasn't configured the Telegram bot yet, so pairing is unavailable.</p>
      `;
      return;
    }
    body.innerHTML = `
      <p class="muted">Link your Telegram account so you can chat with your class agent from your phone.</p>
      <div class="home-actions">
        <button id="telegram-pair-btn" class="btn">Connect Telegram</button>
        <button id="telegram-refresh-btn" class="btn">Refresh status</button>
      </div>
      <div id="telegram-pair-instructions" hidden></div>
    `;
    body.querySelector('#telegram-pair-btn').addEventListener('click', () => issueAndShowCode(body, data.botUsername));
    body.querySelector('#telegram-refresh-btn').addEventListener('click', () => renderTelegramCard(body));
  } catch (err) {
    body.innerHTML = `<p class="muted">Couldn't reach the pairing endpoint: ${escapeHtml(String(err))}</p>`;
  }
}

async function issueAndShowCode(body, botUsername) {
  const target = body.querySelector('#telegram-pair-instructions');
  target.hidden = false;
  target.innerHTML = `<p class="muted">Issuing a fresh code…</p>`;
  try {
    const res = await fetch('/api/me/telegram/pair-code', { method: 'POST', credentials: 'same-origin' });
    if (!res.ok) {
      target.innerHTML = `<p class="muted">Couldn't mint a code (${res.status}).</p>`;
      return;
    }
    const data = await res.json();
    const code = escapeHtml(data.code);
    const bot = escapeHtml(botUsername);
    const expiresMin = Math.max(1, Math.round((data.expiresAt - Date.now()) / 60000));
    target.innerHTML = `
      <ol>
        <li>Open Telegram and find <a href="https://t.me/${bot}" target="_blank" rel="noopener"><strong>@${bot}</strong></a>.</li>
        <li>Send this exact message: <code>/pair-class ${code}</code></li>
        <li>The bot will reply <em>"Paired!"</em> — then come back here and click <strong>Refresh status</strong>.</li>
      </ol>
      <p class="muted">Code expires in ~${expiresMin} min.</p>
    `;
  } catch (err) {
    target.innerHTML = `<p class="muted">Couldn't mint a code: ${escapeHtml(String(err))}</p>`;
  }
}

async function renderGoogleCard(body) {
  if (!body) return;
  try {
    const res = await fetch('/api/me/google', { credentials: 'same-origin' });
    if (!res.ok) {
      body.innerHTML = `<p class="muted">Google connection status unavailable (${res.status}).</p>`;
      return;
    }
    const data = await res.json();
    if (data.connected) {
      body.innerHTML = `
        <p>✅ Connected as <code>${escapeHtml(data.email || '?')}</code>.</p>
        <p class="muted">Your agent's Drive / Sheets / Slides tools now use YOUR Google Drive instead of the instructor's shared one. Disconnect to revert to the class-shared Drive.</p>
        <div class="home-actions">
          <button id="google-disconnect-btn" class="btn btn-danger">Disconnect</button>
        </div>
      `;
      body.querySelector('#google-disconnect-btn').addEventListener('click', async () => {
        if (
          !confirm(
            'Disconnect your Google account? Your agent will fall back to the class-shared Drive for new operations. Existing Docs/Sheets in YOUR Drive remain in YOUR Drive — only future writes change destination.',
          )
        )
          return;
        await fetch('/api/me/google/disconnect', { method: 'POST', credentials: 'same-origin' });
        renderGoogleCard(body);
      });
      return;
    }
    body.innerHTML = `
      <p class="muted">Connect your Google account so your agent operates against YOUR Drive (not the instructor's). Optional — until you connect, Drive tools work via the shared class-Drive (Mode A). Gmail and Calendar tools (coming soon) will require connection.</p>
      <div class="home-actions">
        <a class="btn" href="/google-auth/start">Connect Google</a>
      </div>
    `;
  } catch (err) {
    body.innerHTML = `<p class="muted">Couldn't reach the Google status endpoint: ${escapeHtml(String(err))}</p>`;
  }
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

// ── classroom-provider-auth:providers-card-impl START ─────────────────────

// Home Providers card sources from /api/me/models-tab-state — the single
// endpoint that composes spec metadata (credentialFileShape, apiKeyPlaceholder,
// hasOauthMethod, hasApiKeyMethod), per-student cred state, and Class Controls
// policy into one shape. Eliminates the previous PROVIDERS-array stub that had
// to be kept in sync with the spec modules by hand. The agentGroupId query
// param is what models-tab-state uses to scope class-pool lookups; for the
// Home card the current agent's id works.
async function renderProvidersCard(body) {
  if (!body) return;
  const user = window.__pg && window.__pg.user;
  const isInstructor = user && (user.role === 'owner' || user.role === 'ta');
  if (isInstructor) {
    return renderInstructorProvidersCard(body);
  }
  try {
    const agentGroupId = (window.currentAgent && window.currentAgent.id) || '';
    const res = await fetch(`/api/me/models-tab-state?agentGroupId=${encodeURIComponent(agentGroupId)}`, {
      credentials: 'same-origin',
    });
    const data = await res.json();
    const visibleProviders = (data.providers || []).filter((p) => p.state !== 'HIDDEN');

    const rows = visibleProviders.map(renderProviderRow).filter(Boolean);
    body.innerHTML = rows.length ? rows.join('') : `<p class="muted">No providers enabled by your instructor.</p>`;

    visibleProviders.forEach((p) => wireProviderRow(body, p));
  } catch (err) {
    body.innerHTML = `<p class="muted">Couldn't load providers: ${escapeHtml(String(err))}</p>`;
  }
}

// ── Instructor LLM Providers card ────────────────────────────────────────
// One row per user-facing PROVIDER_GROUPS entry. Each row:
//   - status pill ("● Set (subscription)" / "○ Not connected" / …)
//   - inline "subscription | API key" radio for mixed groups (OpenAI,
//     Anthropic); writes to canonicalSpec.creds.active which the C-1
//     class-pool resolver reads
//   - one button per row (Connect / Manage / Settings) that opens the
//     existing cred dialog on the canonical spec
// Policy (Visible / Provided / Let students auth themselves) is handled
// on the Class Controls card — credential management and policy are
// intentionally split across the two cards.
async function renderInstructorProvidersCard(body) {
  try {
    const agentGroupId = (window.currentAgent && window.currentAgent.id) || '';
    const res = await fetch(`/api/me/models-tab-state?agentGroupId=${encodeURIComponent(agentGroupId)}`, {
      credentials: 'same-origin',
    });
    const data = await res.json();
    const specsById = {};
    for (const p of data.providers || []) specsById[p.id] = p;

    body.innerHTML = PROVIDER_GROUPS.map((group) => renderInstructorGroupRow(group, specsById))
      .filter(Boolean)
      .join('');
    wireInstructorProvidersCard(body, specsById);
  } catch (err) {
    body.innerHTML = `<p class="muted">Couldn't load providers: ${escapeHtml(String(err))}</p>`;
  }
}

function renderInstructorGroupRow(group, specsById) {
  const canonical = specsById[group.canonicalSpecId];
  if (!canonical) {
    return `<div class="provider-row muted">${escapeHtml(group.displayName)} — spec not registered</div>`;
  }
  // Aggregate across the group's specs so the OpenAI row reflects state
  // for BOTH codex and openai-platform creds (per-spec storage; UI view
  // of "do we have an OpenAI API key anywhere" is the union).
  const hasAnyOAuth = group.specIds.some((sid) => specsById[sid]?.creds?.hasOAuth);
  const hasAnyApiKey = group.specIds.some((sid) => specsById[sid]?.creds?.hasApiKey);
  const anyConnected = hasAnyOAuth || hasAnyApiKey;
  const active = canonical.creds.active;
  const mark = anyConnected ? '●' : '○';

  // Chips are display-only state indicators now. For mixed groups (OpenAI,
  // Anthropic) each chip shows connection state + a radio for choosing
  // the class-pool default. For non-mixed groups, a single "Configured" /
  // "Not connected" status label. Opening the cred dialog (connect /
  // manage / disconnect / paste) lives on a separate settings gear icon
  // on the right side of the row so the chip doesn't try to do double duty.
  const methodChip = (label, method, connected) => {
    const isActive = active === method && connected;
    const chipClasses = ['provider-method', connected ? 'is-connected' : '', isActive ? 'is-active' : '']
      .filter(Boolean)
      .join(' ');
    const radioTooltip = connected ? 'Use this credential for class-pool calls' : 'Connect this method first';
    return `
      <span class="${chipClasses}" data-method="${method}">
        <input type="radio" class="provider-radio" name="active-${group.id}" value="${method}" ${isActive ? 'checked' : ''} ${connected ? '' : 'disabled'} title="${escapeHtml(radioTooltip)}">
        <span class="provider-method-text">${escapeHtml(label)}</span>
      </span>`;
  };

  let methodsHtml;
  if (group.hasMixed) {
    methodsHtml = `
      ${methodChip('Subscription', 'oauth', hasAnyOAuth)}
      ${methodChip('API key', 'apiKey', hasAnyApiKey)}`;
  } else {
    // Single-method groups: status pill, no radio (no choice to make).
    const statusLabel =
      canonical.credentialFileShape === 'none'
        ? anyConnected
          ? 'Configured'
          : 'Not configured'
        : anyConnected
          ? 'Connected'
          : 'Not connected';
    methodsHtml = `<span class="provider-status ${anyConnected ? 'is-connected' : ''}">${escapeHtml(statusLabel)}</span>`;
  }

  // Settings gear opens the cred dialog. Same affordance for every row,
  // independent of whether the group is mixed or single-method.
  const gearTooltip = anyConnected ? `Manage ${group.displayName} credential` : `Set up ${group.displayName}`;
  const gearHtml = `<button class="provider-gear" type="button" title="${escapeHtml(gearTooltip)}" aria-label="${escapeHtml(gearTooltip)}">⚙</button>`;

  return `
    <div class="provider-row ${anyConnected ? 'is-connected' : ''}" data-group="${group.id}">
      <span class="provider-mark">${mark}</span>
      <strong class="provider-name">${escapeHtml(group.displayName)}</strong>
      <span class="provider-methods">${methodsHtml}</span>
      ${gearHtml}
    </div>`;
}

function wireInstructorProvidersCard(body, specsById) {
  body.querySelectorAll('.provider-row[data-group]').forEach((rowEl) => {
    const groupId = rowEl.dataset.group;
    const group = PROVIDER_GROUPS.find((g) => g.id === groupId);
    if (!group) return;
    const canonical = specsById[group.canonicalSpecId];
    if (!canonical) return;

    // Click any method chip → open the cred dialog on the canonical spec.
    // The dialog's mixed variant exposes Connect-subscription + Paste-API-
    // key + active-method switching + disconnect all in one place; the
    // 'none' variant handles OMLX reachability / Clemson settings. Enter
    // and Space activate too (chips have role=button + tabindex=0).
    const openDialog = () =>
      openCredDialog({
        providerId: canonical.id,
        providerSpec: {
          id: canonical.id,
          displayName: group.displayName,
          credentialFileShape: canonical.credentialFileShape,
          apiKey: canonical.apiKeyPlaceholder ? { placeholder: canonical.apiKeyPlaceholder } : undefined,
        },
        currentCredState: {
          hasOAuth: canonical.creds.hasOAuth,
          hasApiKey: canonical.creds.hasApiKey,
          activeMethod: canonical.creds.active,
          accountEmail: canonical.creds.accountEmail || '',
        },
        onSaved: () => renderInstructorProvidersCard(body),
      });

    // Gear icon → open cred dialog (connect / manage / disconnect).
    const gear = rowEl.querySelector('.provider-gear');
    if (gear) {
      gear.addEventListener('click', openDialog);
    }

    // Active-method radio (mixed groups only) → POST set-active.
    rowEl.querySelectorAll('input.provider-radio').forEach((input) => {
      input.addEventListener('change', async () => {
        if (input.disabled) return;
        const r = await fetch(`/api/me/providers/${canonical.id}/active`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ active: input.value }),
        });
        if (!r.ok) alert(`Couldn't switch active method for ${group.displayName} (${r.status}).`);
        renderInstructorProvidersCard(body);
      });
    });
  });
}

// p is one entry from /api/me/models-tab-state.providers, with shape:
//   { id, displayName, credentialFileShape, apiKeyPlaceholder?, hasOauthMethod,
//     hasApiKeyMethod, creds: {hasOAuth, hasApiKey, active?, accountEmail?},
//     policy: {allow, provideDefault, allowByo}, state, source, actionLabel, … }
function renderProviderRow(p) {
  const { hasApiKey, hasOAuth, active, accountEmail } = p.creds;
  const displayName = escapeHtml(p.displayName);

  if (hasOAuth && hasApiKey) {
    return `
      <div class="provider-row" data-provider="${p.id}">
        <strong>✅ ${displayName}</strong>
        <div class="provider-active">
          Active:
          <label><input type="radio" name="active-${p.id}" value="oauth" ${active === 'oauth' ? 'checked' : ''}> Subscription (${escapeHtml(accountEmail || '')})</label>
          <label><input type="radio" name="active-${p.id}" value="apiKey" ${active === 'apiKey' ? 'checked' : ''}> API key</label>
        </div>
        <div class="home-actions">
          <button class="btn btn-danger" data-disconnect="${active}">Disconnect ${active === 'oauth' ? 'subscription' : 'API key'}</button>
        </div>
      </div>`;
  }
  if (hasOAuth) {
    return `
      <div class="provider-row" data-provider="${p.id}">
        <strong>✅ ${displayName}</strong> · Subscription (${escapeHtml(accountEmail || '')})
        <div class="home-actions">
          ${p.hasApiKeyMethod ? `<button class="btn" data-add="apiKey">Add API key</button>` : ''}
          <button class="btn btn-danger" data-disconnect="oauth">Disconnect</button>
        </div>
      </div>`;
  }
  if (hasApiKey) {
    return `
      <div class="provider-row" data-provider="${p.id}">
        <strong>✅ ${displayName}</strong> · API key set
        <div class="home-actions">
          ${p.hasOauthMethod ? `<button class="btn" data-add="oauth">Add subscription</button>` : ''}
          <button class="btn btn-danger" data-disconnect="apiKey">Disconnect</button>
        </div>
      </div>`;
  }
  // 'none' shape (omlx, clemson): no per-student creds. Render a status row
  // with a Settings affordance that opens the cred-dialog's none-variant.
  if (p.credentialFileShape === 'none') {
    const subtitle = p.id === 'omlx' ? 'Local server' : 'Provided by instructor';
    return `
      <div class="provider-row" data-provider="${p.id}">
        <strong>✅ ${displayName}</strong> · ${subtitle}
        <div class="home-actions">
          <button class="btn" data-add="settings">Settings</button>
        </div>
      </div>`;
  }
  // No creds. Button label depends on what methods the provider supports.
  const addLabel = p.credentialFileShape === 'api-key' ? 'Add API key' : 'Connect';
  if (p.policy.provideDefault) {
    return `
      <div class="provider-row" data-provider="${p.id}">
        <strong>✅ ${displayName}</strong> · Provided by instructor
        ${p.policy.allowByo ? `<div class="home-actions"><button class="btn" data-add="open">Use my own</button></div>` : ''}
      </div>`;
  }
  if (p.policy.allowByo) {
    return `
      <div class="provider-row" data-provider="${p.id}">
        <strong>⚠ ${displayName}</strong> · Not connected
        <div class="home-actions">
          <button class="btn" data-add="open">${addLabel}</button>
        </div>
      </div>`;
  }
  return ''; // allow=true but no provideDefault + no allowByo: instructor said "show but block"
}

function wireProviderRow(body, p) {
  const row = body.querySelector(`.provider-row[data-provider="${p.id}"]`);
  if (!row) return;

  // Inline active-method radio: switches which credential is used without
  // opening the dialog — visible only when both OAuth + API key are set.
  row.querySelectorAll(`input[name="active-${p.id}"]`).forEach((input) => {
    input.addEventListener('change', async () => {
      const res = await fetch(`/api/me/providers/${p.id}/active`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ active: input.value }),
      });
      if (!res.ok) alert(`Couldn't switch active method for ${p.displayName} (${res.status}).`);
      renderProvidersCard(body);
    });
  });

  // Connect / Add / Settings buttons — open the shared cred dialog. The
  // providerSpec passed here is the flat object from models-tab-state — it
  // already has the right credentialFileShape, apiKeyPlaceholder, etc., so the
  // dialog's variant routing + placeholder text work without local stubs.
  row.querySelectorAll('[data-add]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const currentCredState = {
        hasOAuth: p.creds.hasOAuth,
        hasApiKey: p.creds.hasApiKey,
        activeMethod: p.creds.active,
        accountEmail: p.creds.accountEmail || '',
      };
      openCredDialog({
        providerId: p.id,
        // Adapt the flat shape to what cred-dialog expects (apiKey field
        // with placeholder rather than a top-level apiKeyPlaceholder).
        providerSpec: {
          id: p.id,
          displayName: p.displayName,
          credentialFileShape: p.credentialFileShape,
          apiKey: p.apiKeyPlaceholder ? { placeholder: p.apiKeyPlaceholder } : undefined,
        },
        currentCredState,
        onSaved: () => renderProvidersCard(body),
      });
    });
  });

  // Inline disconnect buttons (shown in the row for quick access)
  row.querySelectorAll('[data-disconnect]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const which = btn.dataset.disconnect;
      if (!confirm(`Disconnect your ${p.displayName} ${which === 'oauth' ? 'subscription' : 'API key'}?`)) return;
      await fetch(`/api/me/providers/${p.id}?which=${which}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      renderProvidersCard(body);
    });
  });
}

// ── classroom-provider-auth:providers-card-impl END ───────────────────────
