const state = { dirty: false, message: '' };

export function initDraftBanner() {
  document.getElementById('draft-discard').addEventListener('click', onDiscard);
  document.getElementById('draft-save').addEventListener('click', onSaveToLibrary);
  document.getElementById('draft-apply').addEventListener('click', onApply);
}

export function showDraftBanner(message) {
  state.dirty = true;
  state.message = message || '';
  const banner = document.getElementById('draft-banner');
  document.getElementById('draft-message').textContent = state.message;
  banner.hidden = false;
}

export function hideDraftBanner() {
  state.dirty = false;
  document.getElementById('draft-banner').hidden = true;
}

function activeTextarea() {
  return document.getElementById('active-text');
}
function activeProviderSelect() {
  return document.getElementById('active-provider');
}
function activeModelSelect() {
  return document.getElementById('active-model');
}

async function onApply() {
  const agent = window.__pg && window.__pg.agent;
  if (!agent || !agent.folder) {
    toast('No agent loaded.');
    return;
  }
  const folder = agent.folder;
  let writes = 0;
  // Write persona text if the Persona tab textarea exists (it's only in the DOM after mountPersona ran).
  const ta = activeTextarea();
  if (ta && !ta.hasAttribute('readonly')) {
    try {
      const r = await fetch(`/api/drafts/${folder}/persona`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ text: ta.value }),
      });
      if (r.ok) writes++;
    } catch { /* ignore */ }
  }
  // Skills changes are already PUT'd at toggle-time by Task 6.6 — no extra step here.
  // Model whitelist changes are already PUT'd at toggle-time by Task 6.7 — no extra step here.
  hideDraftBanner();
  toast(writes > 0 ? 'Applied to current agent.' : 'Nothing to apply.');
}

async function onSaveToLibrary() {
  const agent = window.__pg && window.__pg.agent;
  if (!agent) { toast('No agent loaded.'); return; }
  const name = prompt('Save current draft as (name):');
  if (!name) return;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
    toast('Name must be alphanumeric, underscore, or hyphen.');
    return;
  }
  const ta = activeTextarea();
  const provSel = activeProviderSelect();
  const modelSel = activeModelSelect();
  const personaText = ta ? ta.value : '';
  const entry = {
    name,
    description: '',
    persona: personaText,
    ...(provSel && provSel.value ? { preferredProvider: provSel.value } : {}),
    ...(modelSel && modelSel.value ? { preferredModel: modelSel.value } : {}),
    skills: gatherActiveSkills(),
  };
  try {
    const r = await fetch(`/api/library/my/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(entry),
    });
    if (r.ok) toast(`Saved "${name}" to My library.`);
    else toast('Save failed.');
  } catch {
    toast('Save failed.');
  }
}

function gatherActiveSkills() {
  // The Skills tab renders active skills as `<li class="active-entry">` with the skill name as the first <span>'s text.
  // If the Skills tab hasn't been mounted, this returns [] — acceptable, the save still works.
  const out = [];
  for (const li of document.querySelectorAll('#active-skills .active-entry')) {
    const span = li.querySelector('span:first-child');
    if (!span) continue;
    // Strip the leading "🔧 " emoji + space.
    const text = (span.textContent || '').replace(/^\s*🔧\s*/, '').trim();
    if (text) out.push(text);
  }
  return out;
}

async function onDiscard() {
  const agent = window.__pg && window.__pg.agent;
  if (!agent) { hideDraftBanner(); return; }
  if (!confirm('Discard unsaved changes?')) return;
  const folder = agent.folder;
  // Refetch persona from server and revert the textarea.
  try {
    const r = await fetch(`/api/drafts/${folder}/persona`, { credentials: 'same-origin' });
    if (r.ok) {
      const { text } = await r.json();
      const ta = activeTextarea();
      if (ta) ta.value = text || '';
    }
  } catch { /* ignore */ }
  hideDraftBanner();
  toast('Discarded.');
}

function toast(msg) {
  const root = document.getElementById('toasts');
  if (!root) return;
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  root.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 250);
  }, 2500);
}
