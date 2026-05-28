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

  const studentsRosterCard = isOwner
    ? `
      <section class="home-card" id="students-roster-card">
        <h2>Students</h2>
        <div id="students-roster-body"><p class="muted">Loading…</p></div>
      </section>`
    : '';

  // Owner-only "Add a student" card — name + email provisions one student;
  // the "external guest" checkbox also opens a 60-min cloudflared tunnel.
  const addStudentCard = isOwner
    ? `
      <section class="home-card" id="add-student-card">
        <h2>Add a student</h2>
        <div id="add-student-body"></div>
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

      ${studentsRosterCard}

      ${addStudentCard}

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

      <!-- class-enrollment-passcode:home-card START -->
      ${isOwner ? `
      <section class="home-card" id="enrollment-passcode-card">
        <h2>Today's enrollment passcode</h2>
        <div id="enrollment-passcode-body">
          <p class="muted">Loading…</p>
        </div>
      </section>` : ''}
      <!-- class-enrollment-passcode:home-card END -->

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
    } catch { /* ignore */ }
    window.location.href = '/login';
  });

  el.querySelector('#logout-all-btn').addEventListener('click', async () => {
    if (!confirm('Log out of ALL sessions for this account? Other devices will also need to re-authenticate.')) return;
    try {
      await fetch('/api/me/logout-all', { method: 'POST', credentials: 'same-origin' });
    } catch { /* ignore */ }
    window.location.href = '/login';
  });

  renderTelegramCard(el.querySelector('#telegram-card-body'));
  renderGoogleCard(el.querySelector('#google-card-body'));
  renderProvidersCard(el.querySelector('#providers-card-body'));
  renderUsageCard(el.querySelector('#usage-card-body'), agent.folder);

  if (isOwner) {
    renderClassControlsCard(el.querySelector('#class-controls-body'));
    renderStudentsRosterCard(el.querySelector('#students-roster-body'));
    renderAddStudentCard(el.querySelector('#add-student-body'));
    // class-enrollment-passcode:home-card START
    renderEnrollmentPasscodeCard(el.querySelector('#enrollment-passcode-body'));
    // class-enrollment-passcode:home-card END
  }
}

async function renderStudentsRosterCard(body) {
  if (!body) return;
  try {
    const res = await fetch('/api/usage/_/students?providers=codex', { credentials: 'same-origin' });
    if (!res.ok) {
      body.innerHTML = `<p class="muted">Couldn't load roster (${res.status}).</p>`;
      return;
    }
    const data = await res.json();
    if (!data.students || data.students.length === 0) {
      body.innerHTML = `<p class="muted">No student agents yet. Add students via the classroom flow.</p>`;
      return;
    }
    const tbodyRows = data.students.map((s) => `
      <tr>
        <td><button class="roster-name-btn" data-folder="${escapeHtml(s.agentGroup.folder)}">${escapeHtml(s.agentGroup.name || '?')}</button></td>
        <td class="centered">${s.role === 'ta' ? '<span class="role-ta" title="Teaching Assistant">TA</span>' : ''}</td>
        <td class="num">${fmtUsd(s.thisMonth.costUsd)}</td>
        <td class="num">${fmtUsd(s.total.costUsd)}</td>
        <td class="centered">${s.enrolled ? '<span class="roster-enrolled" title="Has signed in">✅</span>' : '<span class="roster-not-enrolled" title="Not yet signed in">⚪</span>'}</td>
      </tr>
      <tr class="roster-detail-row" id="detail-${escapeHtml(s.agentGroup.folder)}" hidden>
        <td colspan="5"><div class="roster-detail-body"><p class="muted small">Loading…</p></div></td>
      </tr>
    `).join('');
    const enrolledCount = data.students.filter((s) => s.enrolled).length;
    body.innerHTML = `
      <table class="roster-table">
        <thead><tr><th>Name</th><th class="centered">TA</th><th class="num">This month</th><th class="num">Total $</th><th class="centered">Activated</th></tr></thead>
        <tbody>${tbodyRows}</tbody>
      </table>
      <p class="muted small">${enrolledCount} of ${data.students.length} have activated their account. Cost computed from token counts × per-model rate.</p>
    `;
    body.querySelectorAll('.roster-name-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const folder = btn.dataset.folder;
        const detailRow = body.querySelector(`#detail-${folder}`);
        if (!detailRow) return;
        const isOpen = !detailRow.hidden;
        if (isOpen) {
          detailRow.hidden = true;
          btn.classList.remove('active');
          return;
        }
        detailRow.hidden = false;
        btn.classList.add('active');
        const detailBody = detailRow.querySelector('.roster-detail-body');
        if (detailBody.dataset.loaded) return;
        detailBody.dataset.loaded = '1';
        fetch(`/api/admin/students/${encodeURIComponent(folder)}`, { credentials: 'same-origin' })
          .then((r) => r.json())
          .then((d) => {
            if (d.error) {
              detailBody.innerHTML = `<p class="muted small">Error: ${escapeHtml(d.error)}</p>`;
              return;
            }
            detailBody.innerHTML = renderStudentDetail(d);
          })
          .catch((err) => {
            detailBody.innerHTML = `<p class="muted small">Failed: ${escapeHtml(String(err))}</p>`;
          });
      });
    });
  } catch (err) {
    body.innerHTML = `<p class="muted">Couldn't load roster: ${escapeHtml(String(err))}</p>`;
  }
}

function renderAddStudentCard(body) {
  if (!body) return;
  body.innerHTML = `
    <p class="muted">Provisions a new student agent + roster entry. Tick "external guest" to also open a 60-minute public tunnel and get an off-campus login link.</p>
    <div class="home-form">
      <label>Name<input id="as-name" type="text" autocomplete="off" placeholder="Jane Doe"></label>
      <label>Email<input id="as-email" type="email" autocomplete="off" placeholder="jane@example.edu"></label>
      <label class="cc-check"><input id="as-external" type="checkbox"> External guest (start 60-min tunnel)</label>
    </div>
    <div class="home-actions">
      <button id="as-submit" class="btn btn-primary">Add student</button>
      <span class="muted" id="as-status"></span>
    </div>
    <div id="as-result" hidden></div>
  `;

  const nameInput = body.querySelector('#as-name');
  const emailInput = body.querySelector('#as-email');
  const externalInput = body.querySelector('#as-external');
  const submitBtn = body.querySelector('#as-submit');
  const status = body.querySelector('#as-status');
  const result = body.querySelector('#as-result');

  submitBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    const email = emailInput.value.trim();
    const external = externalInput.checked;
    if (!name || !email) {
      status.textContent = 'Name and email are required.';
      return;
    }
    submitBtn.disabled = true;
    status.textContent = external ? 'Provisioning + starting tunnel…' : 'Provisioning…';
    result.hidden = true;
    try {
      const res = await fetch('/api/admin/students', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ name, email, external }),
      });
      const data = await res.json();
      if (!res.ok) {
        status.textContent = `Failed: ${data.error || res.status}`;
        return;
      }
      status.textContent = '';
      nameInput.value = '';
      emailInput.value = '';
      externalInput.checked = false;
      renderAddStudentResult(result, data);
    } catch (err) {
      status.textContent = `Failed: ${escapeHtml(String(err))}`;
    } finally {
      submitBtn.disabled = false;
    }
  });
}

function renderAddStudentResult(result, data) {
  result.hidden = false;
  let tunnelBlock = '';
  if (data.external && data.tunnel) {
    const until = new Date(data.tunnel.expiresAt).toLocaleTimeString();
    tunnelBlock = `<p class="muted small">🌐 Public tunnel live until <strong>${escapeHtml(until)}</strong>. <button class="btn" id="as-stop-tunnel">Stop tunnel</button></p>`;
  } else if (data.external && !data.tunnel) {
    tunnelBlock = `<p class="cc-banner-warn">Tunnel didn't start (${escapeHtml(data.tunnelError || 'unknown error')}). The link below uses the campus address — only works on-campus.</p>`;
  }
  result.innerHTML = `
    <div class="add-student-result">
      <p>✅ Added <strong>${escapeHtml(data.name)}</strong> as <code>${escapeHtml(data.folder)}</code> <span class="muted">(${escapeHtml(data.email)})</span>.</p>
      <p class="muted small">Send this login link to the student:</p>
      <div class="as-link-row">
        <input type="text" class="as-link" readonly value="${escapeHtml(data.loginUrl)}">
        <button class="btn" id="as-copy">Copy</button>
      </div>
      ${tunnelBlock}
      <p class="muted small">Reload the page to see them in the Students roster above.</p>
    </div>
  `;
  const linkInput = result.querySelector('.as-link');
  result.querySelector('#as-copy').addEventListener('click', async () => {
    linkInput.select();
    try {
      await navigator.clipboard.writeText(linkInput.value);
    } catch {
      document.execCommand('copy');
    }
    const btn = result.querySelector('#as-copy');
    btn.textContent = 'Copied';
    setTimeout(() => {
      btn.textContent = 'Copy';
    }, 1500);
  });
  const stopBtn = result.querySelector('#as-stop-tunnel');
  if (stopBtn) {
    stopBtn.addEventListener('click', async () => {
      stopBtn.disabled = true;
      try {
        await fetch('/api/admin/tunnel/stop', { method: 'POST', credentials: 'same-origin' });
      } catch {
        /* ignore */
      }
      stopBtn.textContent = 'Tunnel stopped';
    });
  }
}

function renderStudentDetail(d) {
  const fmtDate = (s) => s ? new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
  const providerLines = Object.entries(d.providers || {}).map(([id, p]) => {
    const methods = [];
    if (p.hasOAuth) methods.push(`subscription${p.active === 'oauth' ? ' ★' : ''}`);
    if (p.hasApiKey) methods.push(`API key${p.active === 'apiKey' ? ' ★' : ''}`);
    const status = methods.length ? `✅ ${methods.join(', ')}` : '⚪ not connected';
    return `<div><strong>${escapeHtml(id)}:</strong> ${status}</div>`;
  }).join('');

  const skillsList = d.skills && d.skills.length
    ? d.skills.map((s) => `<code>${escapeHtml(s)}</code>`).join(', ')
    : '<span class="muted">none</span>';

  const personaBlock = d.persona
    ? `<pre class="roster-detail-persona">${escapeHtml(d.persona)}</pre>`
    : `<span class="muted">—</span>`;

  return `
    <dl class="roster-detail-dl">
      <dt>Email</dt><dd>${d.email ? escapeHtml(d.email) : '—'}</dd>
      <dt>Enrolled</dt><dd>${fmtDate(d.enrolledAt)}</dd>
      <dt>Telegram</dt><dd>${d.telegram ? '✅ paired' : '⚪ not paired'}</dd>
      <dt>Google</dt><dd>${d.google ? '✅ connected' : '⚪ not connected'}</dd>
      <dt>Providers</dt><dd>${providerLines || '<span class="muted">—</span>'}</dd>
      <dt>Skills</dt><dd>${skillsList}</dd>
      <dt>Persona</dt><dd>${personaBlock}</dd>
    </dl>
  `;
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
    const monthRows = tm.byModel.length === 0
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

const ALL_TABS = ['home', 'chat', 'persona', 'skills', 'models', 'agents', 'sources', 'retrieval', 'benchmarks'];
const ALL_AUTH = ['api-key', 'oauth', 'claude-code-oauth'];
const AUTH_LABEL = { 'api-key': 'API key', oauth: 'OAuth (Anthropic Console / OpenAI)', 'claude-code-oauth': 'Claude Code OAuth' };

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
    tabsVisibleToStudents: [], authModesAvailable: [], providers: {},
  };
  const tabsChecks = ALL_TABS.map((t) => `
    <label class="cc-check"><input type="checkbox" data-cc-tab="${t}" ${cls.tabsVisibleToStudents.includes(t) ? 'checked' : ''}> ${t}</label>
  `).join('');
  // ── classroom-provider-auth:class-controls-providers START ────────────
  // Group toggles use AND-on-read / broadcast-on-write across underlying
  // spec ids — see plans/class-controls-provider-grouping.md.
  const policies = cls.providers || {};
  const unconfigured = !cls.providers || Object.keys(cls.providers).length === 0;
  const unconfiguredBanner = unconfigured
    ? `<div class="cc-banner-warn">⚠ Class mode not yet configured — pick provider policies below, then Save.</div>`
    : '';
  const groupFlag = (group, field) =>
    group.specIds.length > 0 &&
    group.specIds.every((sid) => !!(policies[sid] && policies[sid][field]));
  const providerRows = PROVIDER_GROUPS.map((g) => `
        <tr>
          <td>${escapeHtml(g.displayName)}</td>
          <td><input type="checkbox" data-cc-group-visible="${g.id}" ${groupFlag(g, 'allow') ? 'checked' : ''}></td>
          <td><input type="checkbox" data-cc-group-provided="${g.id}" ${groupFlag(g, 'provideDefault') ? 'checked' : ''}></td>
          <td><input type="checkbox" data-cc-group-byo="${g.id}" ${groupFlag(g, 'allowByo') ? 'checked' : ''}></td>
        </tr>`).join('');
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
      <button class="btn btn-primary" id="cc-save">Save class controls</button>
      <span class="muted" id="cc-status"></span>
    </div>
  `;

  body.querySelector('#cc-save').addEventListener('click', async () => {
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
          tabsVisibleToStudents: [...body.querySelectorAll('[data-cc-tab]')].filter((i) => i.checked).map((i) => i.dataset.ccTab),
          authModesAvailable:    cls.authModesAvailable || [],
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
      status.textContent = 'Saved. Students will see the new settings on their next page load.';
    } catch (err) {
      status.textContent = `Save failed: ${String(err)}`;
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
    body.querySelector('#telegram-pair-btn').addEventListener('click', () =>
      issueAndShowCode(body, data.botUsername),
    );
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

// class-enrollment-passcode:home-card-impl START

async function renderEnrollmentPasscodeCard(body) {
  if (!body) return;
  try {
    const res = await fetch('/api/admin/class-passcode', { credentials: 'same-origin' });
    if (!res.ok) {
      body.innerHTML = `<p class="muted">Couldn't load passcode (${res.status}).</p>`;
      return;
    }
    const data = await res.json();
    showPasscode(body, data.passcode);
  } catch (err) {
    body.innerHTML = `<p class="muted">Couldn't reach passcode endpoint: ${escapeHtml(String(err))}</p>`;
  }

  function showPasscode(container, passcode) {
    const display = passcode
      ? `<span style="font-size: 2rem; font-weight: bold; letter-spacing: 0.2em;">${escapeHtml(passcode)}</span>`
      : `<span class="muted">— (not set; click Rotate to generate one)</span>`;
    container.innerHTML = `
      <p>Show this code to students during enrollment:</p>
      <div style="margin: 0.5rem 0;">${display}</div>
      <div class="home-actions">
        <button id="rotate-passcode-btn" class="btn">Rotate</button>
        <span class="muted" id="rotate-passcode-status"></span>
      </div>
    `;
    container.querySelector('#rotate-passcode-btn').addEventListener('click', async () => {
      const status = container.querySelector('#rotate-passcode-status');
      status.textContent = 'Rotating…';
      try {
        const r = await fetch('/api/admin/class-passcode/rotate', {
          method: 'POST',
          credentials: 'same-origin',
        });
        if (!r.ok) {
          status.textContent = `Failed (${r.status}).`;
          return;
        }
        const d = await r.json();
        status.textContent = '';
        showPasscode(container, d.passcode);
      } catch (err) {
        status.textContent = `Error: ${escapeHtml(String(err))}`;
      }
    });
  }
}

// class-enrollment-passcode:home-card-impl END

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
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
  try {
    const agentGroupId = (window.currentAgent && window.currentAgent.id) || '';
    const res = await fetch(
      `/api/me/models-tab-state?agentGroupId=${encodeURIComponent(agentGroupId)}`,
      { credentials: 'same-origin' },
    );
    const data = await res.json();
    const visibleProviders = (data.providers || []).filter((p) => p.state !== 'HIDDEN');

    const rows = visibleProviders.map(renderProviderRow).filter(Boolean);
    body.innerHTML = rows.length
      ? rows.join('')
      : `<p class="muted">No providers enabled by your instructor.</p>`;

    visibleProviders.forEach((p) => wireProviderRow(body, p));
  } catch (err) {
    body.innerHTML = `<p class="muted">Couldn't load providers: ${escapeHtml(String(err))}</p>`;
  }
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
