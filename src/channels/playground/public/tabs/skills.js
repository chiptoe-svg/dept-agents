import { showDraftBanner, hideDraftBanner } from '../draft-banner.js';

let originalSkills = null; // 'all' or string[]
let currentSkills = null;

export function mountSkills(el) {
  const folder = window.__pg.agent.folder;

  el.innerHTML = `
    <div class="skills-layout">
      <aside class="library-panel">
        <h3>Available skills</h3>
        <input id="skill-filter" placeholder="filter…" autocomplete="off">
        <div id="skills-list"></div>
        <button id="author-skill" class="btn btn-ghost">+ Author my own skill…</button>
      </aside>

      <section class="preview-panel">
        <header class="preview-header">
          <span id="skill-prev-title">Preview</span>
          <span id="skill-prev-meta" class="hint"></span>
        </header>
        <div class="file-pane">
          <ul id="file-tree" class="file-tree"></ul>
          <pre id="file-body" class="file-body">Click a skill to preview.</pre>
        </div>
        <footer class="preview-footer">
          <button id="add-to-active" class="btn btn-primary" disabled>+ Add to active →</button>
        </footer>
      </section>

      <section class="active-panel skills-active">
        <h3>Active skills (this agent)</h3>
        <ul id="active-skills" class="active-skills"></ul>
        <footer class="cost-rollup" id="cost-rollup">
          <div>Estimated cost impact: <strong id="rollup-tokens">—</strong></div>
          <div>Latency impact: <strong id="rollup-latency">—</strong></div>
        </footer>
      </section>
    </div>
  `;

  loadSkillLibrary(el, folder);
  loadActiveSkills(el, folder);
  wireFilter(el);
  wireAuthorButton(el);
}

let libraryCache = []; // populated by loadSkillLibrary

function loadSkillLibrary(el, folder) {
  fetch('/api/skills/library', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : { entries: [] }))
    .then((data) => {
      libraryCache = data.entries || [];
      renderLibraryList(el);
    })
    .catch(() => { /* ignore */ });
}

// Category labels shown to the user. Internal API names (`built-in`,
// `skills`) are mapped here so we don't have to re-flow the data model.
const CATEGORY_LABEL = {
  'built-in': 'Library',
  skills: 'Anthropic',
  custom: 'Custom built',
};
// Display order. Anything not in this list comes after, alphabetical.
const CATEGORY_ORDER = ['built-in', 'skills', 'custom'];

function isSkillActive(name) {
  if (currentSkills === 'all') return true;
  return Array.isArray(currentSkills) && currentSkills.includes(name);
}

function renderLibraryList(el) {
  const listEl = el.querySelector('#skills-list');
  listEl.innerHTML = '';
  const byCategory = {};
  for (const entry of libraryCache) {
    (byCategory[entry.category] = byCategory[entry.category] || []).push(entry);
  }
  const categories = Object.keys(byCategory).sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a);
    const bi = CATEGORY_ORDER.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });
  for (const category of categories) {
    const section = document.createElement('div');
    section.className = 'lib-section';
    const heading = document.createElement('h4');
    heading.textContent = CATEGORY_LABEL[category] || category;
    section.appendChild(heading);
    const ul = document.createElement('ul');
    for (const entry of byCategory[category]) {
      const li = document.createElement('li');
      li.className = 'lib-entry skill-entry';
      li.dataset.category = entry.category;
      li.dataset.name = entry.name;
      const costText = entry.costTokens != null ? ` (+~${entry.costTokens} tok)` : '';
      const icon = entry.builtin ? '📦' : '🔧';
      li.textContent = `${icon} ${entry.name}${costText}`;
      li.title = entry.builtin ? `[host-shipped built-in] ${entry.description || ''}` : entry.description || '';
      // Yellow highlight when the skill is currently in this agent's active
      // set. Provenance (built-in vs library) is signalled by the icon, not
      // by background color — keeps "active" the only meaningful tint.
      if (isSkillActive(entry.name)) li.classList.add('skill-active');
      if (entry.compatibility === 'incompatible') li.classList.add('skill-incompatible');
      if (entry.compatibility === 'partial') li.classList.add('skill-partial');
      li.addEventListener('click', () => loadSkillPreview(li.closest('.tab-body') || document, entry.category, entry.name));
      ul.appendChild(li);
    }
    section.appendChild(ul);
    listEl.appendChild(section);
  }
}

let currentPreview = null; // { category, name }

function loadSkillPreview(el, category, name) {
  currentPreview = { category, name };
  // Update selected highlight.
  for (const li of el.querySelectorAll('.skill-entry')) li.classList.remove('selected');
  const selected = el.querySelector(`.skill-entry[data-category="${category}"][data-name="${name}"]`);
  if (selected) selected.classList.add('selected');
  // Title + meta.
  el.querySelector('#skill-prev-title').textContent = `Preview: ${category}/${name}`;
  const entry = libraryCache.find((e) => e.category === category && e.name === name);
  const metaParts = [];
  if (entry) {
    if (entry.compatibility) metaParts.push(entry.compatibility);
    if (entry.costTokens != null) metaParts.push(`~${entry.costTokens} tok/turn`);
    if (entry.latencyMs != null) metaParts.push(`+${entry.latencyMs}ms/turn`);
  }
  el.querySelector('#skill-prev-meta').textContent = metaParts.join(' · ');
  el.querySelector('#add-to-active').disabled = false;
  // File tree + default SKILL.md preview.
  fetch(`/api/skills/library/${encodeURIComponent(category)}/${encodeURIComponent(name)}/files`, { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : { files: [] }))
    .then((data) => renderFileTree(el, data.files || []));
  loadFile(el, category, name, 'SKILL.md');
  // Wire add-to-active.
  el.querySelector('#add-to-active').onclick = () => addSkillToActive(el, name);
}

function renderFileTree(el, files) {
  const tree = el.querySelector('#file-tree');
  tree.innerHTML = '';
  for (const f of files) {
    if (f.isDir) continue; // only files are clickable
    const li = document.createElement('li');
    li.className = 'file-entry';
    li.textContent = `📄 ${f.path}`;
    li.dataset.path = f.path;
    if (f.path === 'SKILL.md') li.classList.add('selected');
    li.addEventListener('click', () => {
      if (!currentPreview) return;
      for (const x of tree.querySelectorAll('.file-entry')) x.classList.remove('selected');
      li.classList.add('selected');
      loadFile(el, currentPreview.category, currentPreview.name, f.path);
    });
    tree.appendChild(li);
  }
}

function loadFile(el, category, name, relPath) {
  fetch(`/api/skills/library/${encodeURIComponent(category)}/${encodeURIComponent(name)}/file?path=${encodeURIComponent(relPath)}`, { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : { text: '(not found)' }))
    .then((data) => { el.querySelector('#file-body').textContent = data.text || ''; });
}

function loadActiveSkills(el, folder) {
  fetch(`/api/drafts/${folder}/skills`, { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : { skills: 'all' }))
    .then((data) => {
      currentSkills = data.skills;
      originalSkills = Array.isArray(currentSkills) ? [...currentSkills] : currentSkills;
      renderActiveList(el);
      // Library list reflects active state too (yellow highlight). Race-safe:
      // if the library hasn't finished loading yet, libraryCache is empty
      // and renderLibraryList renders a no-op; loadSkillLibrary's own
      // render will pick up the now-set currentSkills.
      renderLibraryList(el);
      recomputeRollup(el);
    });
}

function renderActiveList(el) {
  const ul = el.querySelector('#active-skills');
  ul.innerHTML = '';

  // Legacy "all" sentinel — agent.json still carrying the old default.
  // One-line note + "Convert to explicit list" CTA so the user can move
  // off the abstraction. New agents default to [] so they never see this.
  if (currentSkills === 'all') {
    const banner = document.createElement('li');
    banner.className = 'active-all-banner';
    banner.innerHTML = `
      <span>This agent is on the legacy <code>"all"</code> default — every library skill is implicitly active.</span>
      <button class="btn btn-ghost convert-to-explicit">Convert to empty list</button>
    `;
    banner.querySelector('.convert-to-explicit').addEventListener('click', () => {
      currentSkills = [];
      saveActive(el);
    });
    ul.appendChild(banner);
    return;
  }

  for (const skill of currentSkills) {
    const entry = libraryCache.find((e) => e.name === skill);
    const li = document.createElement('li');
    li.className = entry && entry.builtin ? 'active-entry active-entry-builtin' : 'active-entry';
    const icon = entry && entry.builtin ? '📦' : '🔧';
    const costText = entry && entry.costTokens != null ? `+~${entry.costTokens} tok` : '';
    li.innerHTML = `
      <span>${icon} ${escapeHtml(skill)}</span>
      <span class="active-cost">${costText}</span>
      <button class="active-remove" title="Remove">×</button>
    `;
    li.querySelector('.active-remove').addEventListener('click', () => {
      currentSkills = currentSkills.filter((s) => s !== skill);
      saveActive(el);
    });
    ul.appendChild(li);
  }
  if (currentSkills.length === 0) {
    const li = document.createElement('li');
    li.className = 'active-empty';
    li.textContent = 'This agent has no skills active. Add some from the left to grant capabilities.';
    ul.appendChild(li);
  }
}

function addSkillToActive(el, name) {
  // New agents default to []. Legacy agents on the "all" sentinel are
  // converted to an explicit list seeded with the full library before
  // append, so the click still reads as "add" (no skill is dropped).
  if (currentSkills === 'all') {
    currentSkills = libraryCache.map((e) => e.name).filter((n) => typeof n === 'string');
  }
  if (currentSkills.includes(name)) return;
  currentSkills.push(name);
  saveActive(el);
}

function saveActive(el) {
  const folder = window.__pg.agent.folder;
  fetch(`/api/drafts/${folder}/skills`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ skills: currentSkills }),
  })
    .then((r) => (r.ok ? r.json() : null))
    .then(() => {
      renderActiveList(el);
      // Keep the library panel's active-highlight in sync.
      renderLibraryList(el);
      recomputeRollup(el);
      if (JSON.stringify(currentSkills) !== JSON.stringify(originalSkills)) {
        showDraftBanner(`${window.__pg.agent.name} has unsaved skill changes.`);
      } else {
        hideDraftBanner();
      }
    });
}

function recomputeRollup(el) {
  let tokens = 0;
  let latency = 0;
  let unknown = false;
  const skills = Array.isArray(currentSkills) ? currentSkills : [];
  for (const name of skills) {
    const entry = libraryCache.find((e) => e.name === name);
    if (!entry) { unknown = true; continue; }
    if (entry.costTokens != null) tokens += entry.costTokens; else unknown = true;
    if (entry.latencyMs != null) latency += entry.latencyMs;
  }
  el.querySelector('#rollup-tokens').textContent =
    currentSkills === 'all' ? 'depends on what gets used' :
    skills.length === 0 ? 'none' :
    `+~${tokens} tok/turn${unknown ? ' (some skills missing cost metadata)' : ''}`;
  el.querySelector('#rollup-latency').textContent =
    currentSkills === 'all' ? 'depends' :
    skills.length === 0 ? '—' :
    `+~${latency}ms/turn`;
}

function wireFilter(el) {
  el.querySelector('#skill-filter').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase().trim();
    for (const li of el.querySelectorAll('.skill-entry')) {
      const visible = !q || li.dataset.name.toLowerCase().includes(q);
      li.style.display = visible ? '' : 'none';
    }
  });
}

function wireAuthorButton(el) {
  el.querySelector('#author-skill').addEventListener('click', () => {
    alert('Skill authoring sub-flow — design pending. (v3 placeholder.)');
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
