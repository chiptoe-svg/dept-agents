/**
 * Shared credential dialog. Open from anywhere with:
 *   openCredDialog({ providerId, providerSpec, currentCredState, onSaved })
 *
 * providerSpec — { id, displayName, credentialFileShape, oauth?, apiKey?, host? }
 *   (loaded from /api/me/providers or the PROVIDERS list in home.js)
 * currentCredState — { hasOAuth, hasApiKey, activeMethod?, accountEmail?, tokenExpiresAt? }
 * onSaved — callback fired after Save/Disconnect succeeds.
 *
 * Variants by credentialFileShape:
 *   'oauth-token' -> single OAuth tab
 *   'api-key'     -> single API-key paste tab
 *   'mixed'       -> tabs + active-method radio when both creds set
 *   'none'        -> URL field + reachability probe (no credentials stored)
 *
 * Sets data-tab, data-active-method, data-role attributes on key DOM nodes so
 * mptab-13's happy-dom tests can assert structure.
 *
 * Wires up:
 *   POST /provider-auth/<id>/start    -> OAuth start (existing endpoint)
 *   POST /provider-auth/<id>/exchange -> OAuth code exchange (existing)
 *   POST /api/me/providers/<id>/api-key -> save key (existing)
 *   POST /api/me/providers/<id>/active  -> set active method (existing)
 *   DELETE /api/me/providers/<id>       -> disconnect (existing)
 */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Lenient paste parsing — accepts raw code, code#state, or full callback URL. */
function parsePastedCode(raw) {
  if (!raw) return '';
  // Full URL with ?code= (e.g. https://platform.claude.com/oauth/code/callback?code=…)
  try {
    const url = new URL(raw);
    const c = url.searchParams.get('code');
    if (c) return c;
  } catch { /* not a URL */ }
  // Regex fallback — catches OpenAI's localhost:1455/auth/callback?code=…
  // (non-standard scheme that URL constructor parses inconsistently across
  // browsers) AND bare query-string pastes like "code=ac_XXX&state=YYY".
  const m = raw.match(/(?:^|[?&])code=([^&\s#]+)/);
  if (m) return decodeURIComponent(m[1]);
  // Anthropic's combined "code#state" form (when the vendor shows code
  // and state concatenated on the success page).
  if (raw.includes('#')) return raw.split('#')[0];
  return raw;
}

let _currentOverlay = null;

/**
 * Open the credential management dialog for a provider.
 *
 * @param {object} opts
 * @param {string} opts.providerId
 * @param {object} opts.providerSpec  — { id, displayName, credentialFileShape, oauth?, apiKey?, host? }
 * @param {object} opts.currentCredState — { hasOAuth, hasApiKey, activeMethod?, accountEmail?, tokenExpiresAt? }
 * @param {Function} opts.onSaved — fired after any successful save/disconnect
 */
export function openCredDialog({ providerId, providerSpec, currentCredState, onSaved }) {
  // Remove any existing dialog first
  closeCredDialog();

  const { displayName, credentialFileShape } = providerSpec;

  // Build modal overlay
  const overlay = document.createElement('div');
  overlay.className = 'cred-modal-overlay';
  overlay.setAttribute('data-cred-modal', providerId);

  // Close on backdrop click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeCredDialog();
  });

  // Dialog shell
  const dialog = document.createElement('div');
  dialog.className = 'cred-modal';

  const heading = document.createElement('h3');
  heading.textContent = `${displayName} — Credentials`;
  dialog.appendChild(heading);

  const body = document.createElement('div');
  body.className = 'cred-modal-body';

  if (credentialFileShape === 'oauth-token') {
    buildOAuthOnlyVariant(body, providerId, providerSpec, currentCredState, onSaved);
  } else if (credentialFileShape === 'api-key') {
    buildApiKeyOnlyVariant(body, providerId, providerSpec, currentCredState, onSaved);
  } else if (credentialFileShape === 'mixed') {
    buildMixedVariant(body, providerId, providerSpec, currentCredState, onSaved);
  } else if (credentialFileShape === 'none') {
    buildNoneVariant(body, providerId, providerSpec, currentCredState, onSaved);
  } else {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = `Unknown credential type: ${credentialFileShape}`;
    body.appendChild(p);
  }

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn cred-modal-close';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', closeCredDialog);

  dialog.appendChild(body);
  dialog.appendChild(closeBtn);
  overlay.appendChild(dialog);

  // Inject into #modal-root if available (tests use this), else document.body
  const root = document.getElementById('modal-root') || document.body;
  root.appendChild(overlay);
  _currentOverlay = overlay;
}

export function closeCredDialog() {
  if (_currentOverlay) {
    _currentOverlay.remove();
    _currentOverlay = null;
  }
}

// ── variant builders ─────────────────────────────────────────────────────────

/**
 * 'oauth-token' — single OAuth tab: start flow + paste form.
 * Produces: one [data-tab="oauth"] element, no active-method radio.
 */
function buildOAuthOnlyVariant(body, providerId, providerSpec, currentCredState, onSaved) {
  const { hasOAuth } = currentCredState || {};
  const { displayName } = providerSpec;

  const section = document.createElement('div');
  section.setAttribute('data-tab', 'oauth');

  if (hasOAuth) {
    const account = currentCredState.accountEmail || '';

    const statusP = document.createElement('p');
    statusP.textContent = '✅ Subscription connected' + (account ? ` (${account})` : '') + '.';
    section.appendChild(statusP);

    const actions = document.createElement('div');
    actions.className = 'home-actions';
    const disconnectBtn = document.createElement('button');
    disconnectBtn.className = 'btn btn-danger';
    disconnectBtn.setAttribute('data-role', 'disconnect-oauth');
    disconnectBtn.textContent = 'Disconnect';
    disconnectBtn.addEventListener('click', async () => {
      if (!confirm(`Disconnect your ${displayName} subscription?`)) return;
      await fetch(`/api/me/providers/${providerId}?which=oauth`, {
        method: 'DELETE', credentials: 'same-origin',
      });
      closeCredDialog();
      onSaved();
    });
    actions.appendChild(disconnectBtn);
    section.appendChild(actions);
  } else {
    const descP = document.createElement('p');
    descP.textContent = `Connect your ${displayName} subscription via OAuth.`;
    section.appendChild(descP);

    const actions = document.createElement('div');
    actions.className = 'home-actions';
    const startBtn = document.createElement('button');
    startBtn.className = 'btn btn-primary';
    startBtn.setAttribute('data-role', 'start-oauth');
    startBtn.textContent = 'Connect';
    startBtn.addEventListener('click', async () => {
      await startOAuthFlow(providerId, displayName, section, () => { closeCredDialog(); onSaved(); });
    });
    actions.appendChild(startBtn);
    section.appendChild(actions);

    const pasteSlot = document.createElement('div');
    pasteSlot.setAttribute('data-role', 'paste-form');
    pasteSlot.hidden = true;
    section.appendChild(pasteSlot);

    const errLine = document.createElement('p');
    errLine.className = 'paste-err muted';
    errLine.hidden = true;
    section.appendChild(errLine);
  }

  body.appendChild(section);
}

/**
 * 'api-key' — single API-key paste tab.
 * Produces: [data-role="api-key"] input, no [data-tab="oauth"].
 */
function buildApiKeyOnlyVariant(body, providerId, providerSpec, currentCredState, onSaved) {
  const { hasApiKey } = currentCredState || {};
  const { displayName, apiKey } = providerSpec;
  const placeholder = apiKey?.placeholder || 'Paste API key here';

  const section = document.createElement('div');
  section.className = 'cred-api-key-section';

  if (hasApiKey) {
    const statusP = document.createElement('p');
    statusP.textContent = '✅ API key set.';
    section.appendChild(statusP);

    const replaceLabel = document.createElement('label');
    replaceLabel.textContent = 'Replace key: ';
    const keyInput = document.createElement('input');
    keyInput.type = 'password';
    keyInput.setAttribute('data-role', 'api-key');
    keyInput.className = 'cred-api-key-input';
    keyInput.placeholder = placeholder;
    keyInput.autocomplete = 'off';
    replaceLabel.appendChild(keyInput);
    section.appendChild(replaceLabel);
  } else {
    const descP = document.createElement('p');
    descP.textContent = `Paste your ${displayName} API key:`;
    section.appendChild(descP);

    const label = document.createElement('label');
    const keyInput = document.createElement('input');
    keyInput.type = 'password';
    keyInput.setAttribute('data-role', 'api-key');
    keyInput.className = 'cred-api-key-input';
    keyInput.placeholder = placeholder;
    keyInput.autocomplete = 'off';
    label.appendChild(keyInput);
    section.appendChild(label);
  }

  const errLine = document.createElement('p');
  errLine.className = 'paste-err muted';
  errLine.hidden = true;
  section.appendChild(errLine);

  const actions = document.createElement('div');
  actions.className = 'home-actions';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn-primary';
  saveBtn.setAttribute('data-role', 'save-api-key');
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', async () => {
    const input = section.querySelector('[data-role="api-key"]');
    const apiKeyValue = input.value.trim();
    if (!apiKeyValue) { errLine.textContent = 'Please paste an API key.'; errLine.hidden = false; return; }
    const res = await fetch(`/api/me/providers/${providerId}/api-key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ apiKey: apiKeyValue }),
    });
    if (!res.ok) { errLine.textContent = `Couldn't save API key (${res.status}).`; errLine.hidden = false; return; }
    closeCredDialog();
    onSaved();
  });
  actions.appendChild(saveBtn);

  if (hasApiKey) {
    const disconnectBtn = document.createElement('button');
    disconnectBtn.className = 'btn btn-danger';
    disconnectBtn.setAttribute('data-role', 'disconnect-api-key');
    disconnectBtn.textContent = 'Disconnect';
    disconnectBtn.addEventListener('click', async () => {
      if (!confirm(`Disconnect your ${displayName} API key?`)) return;
      await fetch(`/api/me/providers/${providerId}?which=apiKey`, {
        method: 'DELETE', credentials: 'same-origin',
      });
      closeCredDialog();
      onSaved();
    });
    actions.appendChild(disconnectBtn);
  }

  section.appendChild(actions);
  body.appendChild(section);
}

/**
 * 'mixed' — OAuth tab + API-key tab; active-method radio when both creds set.
 * Produces: two [data-tab] elements, [data-active-method] radio when both present.
 */
function buildMixedVariant(body, providerId, providerSpec, currentCredState, onSaved) {
  const { hasOAuth, hasApiKey, activeMethod } = currentCredState || {};
  const { displayName, apiKey } = providerSpec;
  const placeholder = apiKey?.placeholder || 'Paste API key here';

  // Active-method radio (only when both methods are set)
  if (hasOAuth && hasApiKey) {
    const radioSection = document.createElement('div');
    radioSection.className = 'cred-active-method';

    const fieldset = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = 'Active method';
    fieldset.appendChild(legend);

    const oauthLabel = document.createElement('label');
    const oauthRadio = document.createElement('input');
    oauthRadio.type = 'radio';
    oauthRadio.name = `active-method-${providerId}`;
    oauthRadio.value = 'oauth';
    oauthRadio.checked = activeMethod === 'oauth';
    oauthRadio.setAttribute('data-active-method', '');
    const oauthAccount = currentCredState.accountEmail ? ` (${currentCredState.accountEmail})` : '';
    oauthLabel.appendChild(oauthRadio);
    oauthLabel.appendChild(document.createTextNode(' Subscription' + oauthAccount));
    fieldset.appendChild(oauthLabel);

    const apiKeyLabel = document.createElement('label');
    const apiKeyRadio = document.createElement('input');
    apiKeyRadio.type = 'radio';
    apiKeyRadio.name = `active-method-${providerId}`;
    apiKeyRadio.value = 'apiKey';
    apiKeyRadio.checked = activeMethod === 'apiKey';
    apiKeyRadio.setAttribute('data-active-method', '');
    apiKeyLabel.appendChild(apiKeyRadio);
    apiKeyLabel.appendChild(document.createTextNode(' API key'));
    fieldset.appendChild(apiKeyLabel);

    radioSection.appendChild(fieldset);
    fieldset.querySelectorAll('[data-active-method]').forEach((input) => {
      input.addEventListener('change', async () => {
        const res = await fetch(`/api/me/providers/${providerId}/active`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ active: input.value }),
        });
        if (!res.ok) alert(`Couldn't switch active method for ${displayName} (${res.status}).`);
        else onSaved();
      });
    });
    body.appendChild(radioSection);
  }

  // OAuth tab
  const oauthTab = document.createElement('div');
  oauthTab.setAttribute('data-tab', 'oauth');

  const oauthHeading = document.createElement('h4');
  oauthHeading.textContent = 'Subscription';
  oauthTab.appendChild(oauthHeading);

  if (hasOAuth) {
    const account = currentCredState.accountEmail || '';
    const statusP = document.createElement('p');
    statusP.textContent = '✅ Connected' + (account ? ` (${account})` : '') + '.';
    oauthTab.appendChild(statusP);

    const actions = document.createElement('div');
    actions.className = 'home-actions';
    const disconnectBtn = document.createElement('button');
    disconnectBtn.className = 'btn btn-danger';
    disconnectBtn.setAttribute('data-role', 'disconnect-oauth');
    disconnectBtn.textContent = 'Disconnect subscription';
    disconnectBtn.addEventListener('click', async () => {
      if (!confirm(`Disconnect your ${displayName} subscription?`)) return;
      await fetch(`/api/me/providers/${providerId}?which=oauth`, {
        method: 'DELETE', credentials: 'same-origin',
      });
      closeCredDialog();
      onSaved();
    });
    actions.appendChild(disconnectBtn);
    oauthTab.appendChild(actions);
  } else {
    const descP = document.createElement('p');
    descP.textContent = `Connect your ${displayName} subscription via OAuth.`;
    oauthTab.appendChild(descP);

    const actions = document.createElement('div');
    actions.className = 'home-actions';
    const startBtn = document.createElement('button');
    startBtn.className = 'btn btn-primary';
    startBtn.setAttribute('data-role', 'start-oauth');
    startBtn.textContent = 'Connect';
    startBtn.addEventListener('click', async () => {
      await startOAuthFlow(providerId, displayName, oauthTab, () => { closeCredDialog(); onSaved(); });
    });
    actions.appendChild(startBtn);
    oauthTab.appendChild(actions);

    const pasteSlot = document.createElement('div');
    pasteSlot.setAttribute('data-role', 'paste-form');
    pasteSlot.hidden = true;
    oauthTab.appendChild(pasteSlot);

    const errLine = document.createElement('p');
    errLine.className = 'paste-err muted';
    errLine.hidden = true;
    oauthTab.appendChild(errLine);
  }

  // API key tab
  const apiKeyTab = document.createElement('div');
  apiKeyTab.setAttribute('data-tab', 'api-key');

  const apiKeyHeading = document.createElement('h4');
  apiKeyHeading.textContent = 'API key';
  apiKeyTab.appendChild(apiKeyHeading);

  if (hasApiKey) {
    const statusP = document.createElement('p');
    statusP.textContent = '✅ API key set.';
    apiKeyTab.appendChild(statusP);

    const replaceLabel = document.createElement('label');
    replaceLabel.textContent = 'Replace key: ';
    const keyInput = document.createElement('input');
    keyInput.type = 'password';
    keyInput.setAttribute('data-role', 'api-key');
    keyInput.className = 'cred-api-key-input';
    keyInput.placeholder = placeholder;
    keyInput.autocomplete = 'off';
    replaceLabel.appendChild(keyInput);
    apiKeyTab.appendChild(replaceLabel);
  } else {
    const descP = document.createElement('p');
    descP.textContent = `Paste your ${displayName} API key:`;
    apiKeyTab.appendChild(descP);

    const label = document.createElement('label');
    const keyInput = document.createElement('input');
    keyInput.type = 'password';
    keyInput.setAttribute('data-role', 'api-key');
    keyInput.className = 'cred-api-key-input';
    keyInput.placeholder = placeholder;
    keyInput.autocomplete = 'off';
    label.appendChild(keyInput);
    apiKeyTab.appendChild(label);
  }

  const apiKeyErrLine = document.createElement('p');
  apiKeyErrLine.className = 'paste-err muted';
  apiKeyErrLine.hidden = true;

  const apiKeyActions = document.createElement('div');
  apiKeyActions.className = 'home-actions';

  const saveApiKeyBtn = document.createElement('button');
  saveApiKeyBtn.className = 'btn btn-primary';
  saveApiKeyBtn.setAttribute('data-role', 'save-api-key');
  saveApiKeyBtn.textContent = 'Save';
  saveApiKeyBtn.addEventListener('click', async () => {
    const input = apiKeyTab.querySelector('[data-role="api-key"]');
    const apiKeyValue = input.value.trim();
    if (!apiKeyValue) { apiKeyErrLine.textContent = 'Please paste an API key.'; apiKeyErrLine.hidden = false; return; }
    const res = await fetch(`/api/me/providers/${providerId}/api-key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ apiKey: apiKeyValue }),
    });
    if (!res.ok) { apiKeyErrLine.textContent = `Couldn't save API key (${res.status}).`; apiKeyErrLine.hidden = false; return; }
    closeCredDialog();
    onSaved();
  });
  apiKeyActions.appendChild(saveApiKeyBtn);

  if (hasApiKey) {
    const disconnectApiKeyBtn = document.createElement('button');
    disconnectApiKeyBtn.className = 'btn btn-danger';
    disconnectApiKeyBtn.setAttribute('data-role', 'disconnect-api-key');
    disconnectApiKeyBtn.textContent = 'Disconnect API key';
    disconnectApiKeyBtn.addEventListener('click', async () => {
      if (!confirm(`Disconnect your ${displayName} API key?`)) return;
      await fetch(`/api/me/providers/${providerId}?which=apiKey`, {
        method: 'DELETE', credentials: 'same-origin',
      });
      closeCredDialog();
      onSaved();
    });
    apiKeyActions.appendChild(disconnectApiKeyBtn);
  }

  apiKeyTab.appendChild(apiKeyErrLine);
  apiKeyTab.appendChild(apiKeyActions);

  body.appendChild(oauthTab);
  body.appendChild(apiKeyTab);
}

/**
 * 'none' — local-server provider (no credentials needed, just connectivity).
 * Produces: [data-role="server-url"], [data-role="reachability"] — no [data-tab].
 */
function buildNoneVariant(body, providerId, providerSpec, currentCredState, onSaved) {
  const { displayName } = providerSpec;

  const section = document.createElement('div');
  section.className = 'cred-none-section';

  const descP = document.createElement('p');
  descP.textContent = `${displayName} is a local server — no credentials required.`;
  section.appendChild(descP);

  const urlLabel = document.createElement('label');
  urlLabel.textContent = 'Server URL: ';
  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.setAttribute('data-role', 'server-url');
  urlInput.className = 'cred-server-url-input';
  urlInput.placeholder = 'http://localhost:8080';
  urlInput.autocomplete = 'off';
  urlLabel.appendChild(urlInput);
  section.appendChild(urlLabel);

  const reachability = document.createElement('div');
  reachability.setAttribute('data-role', 'reachability');
  reachability.className = 'cred-reachability';
  const reachabilityText = document.createElement('span');
  reachabilityText.className = 'muted';
  reachabilityText.textContent = 'Enter a URL and click Check to test connectivity.';
  reachability.appendChild(reachabilityText);
  section.appendChild(reachability);

  const actions = document.createElement('div');
  actions.className = 'home-actions';
  const checkBtn = document.createElement('button');
  checkBtn.className = 'btn';
  checkBtn.setAttribute('data-role', 'check-reachability');
  checkBtn.textContent = 'Check';

  checkBtn.addEventListener('click', async () => {
    const reachabilityDiv = section.querySelector('[data-role="reachability"]');
    reachabilityDiv.textContent = 'Checking…';
    try {
      const res = await fetch(`/api/me/providers/${providerId}/reachability`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        reachabilityDiv.textContent = `✗ ${res.status} ${res.statusText}`;
        return;
      }
      const resBody = await res.json();
      const checkedAt = new Date(resBody.checkedAt).toLocaleTimeString();
      reachabilityDiv.textContent = resBody.ok
        ? `✓ Reachable · checked ${checkedAt}`
        : `✗ Unreachable · checked ${checkedAt}`;
    } catch (err) {
      reachabilityDiv.textContent = `✗ Network error · ${(err && err.message) || err}`;
    }
  });

  actions.appendChild(checkBtn);
  section.appendChild(actions);

  body.appendChild(section);
}

// ── OAuth paste-back flow (shared by oauth-only and mixed) ───────────────────

/**
 * Start the OAuth flow: fetch /provider-auth/<id>/start, open the vendor URL,
 * then show an inline paste form inside `container`.
 *
 * @param {string} providerId
 * @param {string} displayName
 * @param {HTMLElement} container  — element that holds the start button + paste-form slot
 * @param {Function} [onSuccess]   — fired after a successful exchange
 */
async function startOAuthFlow(providerId, displayName, container, onSuccess) {
  const res = await fetch(`/provider-auth/${providerId}/start`, { credentials: 'same-origin' });
  if (!res.ok) { alert(`Couldn't start ${displayName} sign-in (${res.status}).`); return; }
  const { authorizeUrl, state, instructions } = await res.json();
  window.open(authorizeUrl, '_blank', 'noopener,noreferrer');
  showPasteForm(container, providerId, displayName, state, instructions, authorizeUrl, onSuccess);
}

/**
 * Render the OAuth code-paste form inside `container` (replaces the start button area).
 */
function showPasteForm(container, providerId, displayName, state, instructions, authorizeUrl, onSuccess) {
  // Hide the start button while the paste form is visible
  const startBtn = container.querySelector('[data-role="start-oauth"]');
  if (startBtn) startBtn.hidden = true;

  const pasteSlot = container.querySelector('[data-role="paste-form"]');
  if (!pasteSlot) return;

  // Open sign-in link (fallback if the popup was blocked)
  if (authorizeUrl) {
    const linkDiv = document.createElement('div');
    linkDiv.className = 'paste-open-link';
    const link = document.createElement('a');
    link.href = authorizeUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'btn btn-primary';
    link.textContent = 'Open sign-in page →';
    const hint = document.createElement('span');
    hint.className = 'muted';
    hint.style.marginLeft = '10px';
    hint.textContent = '(if a new tab didn’t open automatically)';
    linkDiv.appendChild(link);
    linkDiv.appendChild(hint);
    pasteSlot.appendChild(linkDiv);
  }

  const instrDiv = document.createElement('div');
  instrDiv.className = 'paste-instructions';
  const instrLines = (instructions || `Sign in to ${displayName} in the new tab. Paste the authorization code here:`).split('\n');
  instrLines.forEach((line) => {
    const div = document.createElement('div');
    div.textContent = line;
    instrDiv.appendChild(div);
  });
  pasteSlot.appendChild(instrDiv);

  const codeInput = document.createElement('input');
  codeInput.type = 'text';
  codeInput.className = 'paste-code';
  codeInput.placeholder = 'Paste code or URL here';
  codeInput.autocomplete = 'off';
  pasteSlot.appendChild(codeInput);

  const pasteActions = document.createElement('div');
  pasteActions.className = 'home-actions';

  const submitBtn = document.createElement('button');
  submitBtn.className = 'btn btn-primary';
  submitBtn.setAttribute('data-role', 'submit-code');
  submitBtn.textContent = 'Submit';
  pasteActions.appendChild(submitBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn';
  cancelBtn.setAttribute('data-role', 'cancel-paste');
  cancelBtn.textContent = 'Cancel';
  pasteActions.appendChild(cancelBtn);

  pasteSlot.appendChild(pasteActions);
  pasteSlot.hidden = false;

  const errLine = container.querySelector('.paste-err');
  codeInput.focus();

  submitBtn.addEventListener('click', async () => {
    const code = parsePastedCode(codeInput.value.trim());
    if (!code) {
      if (errLine) { errLine.textContent = 'Code could not be parsed from the pasted value.'; errLine.hidden = false; }
      return;
    }
    const r = await fetch(`/provider-auth/${providerId}/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ code, state }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      let msg = `Failed: ${err.error || r.status}`;
      // OAuth state lives in process memory; a host restart between
      // clicking Connect and pasting the code invalidates it. Tell the
      // user so they re-Connect instead of staring at a generic error.
      if (typeof err.error === 'string' && err.error.toLowerCase().includes('expired state')) {
        msg += ' — the server may have restarted between Connect and paste. Click Cancel, then Connect again.';
      }
      if (errLine) { errLine.textContent = msg; errLine.hidden = false; }
      return;
    }
    if (onSuccess) onSuccess();
    else closeCredDialog();
  });

  cancelBtn.addEventListener('click', () => {
    pasteSlot.hidden = true;
    // Clear the slot's content
    while (pasteSlot.firstChild) pasteSlot.removeChild(pasteSlot.firstChild);
    if (startBtn) startBtn.hidden = false;
    if (errLine) { errLine.hidden = true; errLine.textContent = ''; }
  });
}
