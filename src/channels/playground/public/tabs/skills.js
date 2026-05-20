import { showDraftBanner, hideDraftBanner } from '../draft-banner.js';

// Active-set state — 'all' (legacy sentinel) or string[].
let originalSkills = null; // active set at tab-open, for dirty detection
let currentSkills = null;

// Merged skill list: built-in + Anthropic library + this agent's custom skills.
let libraryCache = [];

// Editor state.
let currentSelection = null; // { category, name } of the previewed/edited skill
let editorBaseline = ''; // last-loaded SKILL.md text, for dirty detection
let editorSourceIsCustom = false;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const CATEGORY_LABEL = { 'built-in': 'Library', skills: 'Anthropic', custom: 'Custom' };
const CATEGORY_ORDER = ['built-in', 'skills', 'custom'];

const SKILL_TEMPLATE = `---
name: my-skill
description: One-line summary of when the agent should use this skill.
---

# My skill

Describe what the agent should do when this skill is active.
`;

export function mountSkills(el) {
  const folder = window.__pg.agent.folder;

  el.replaceChildren();
  el.insertAdjacentHTML(
    'beforeend',
    `
    <div class="skills-layout">
      <aside class="library-panel skills-browser">
        <h3>Skills</h3>
        <input id="skill-filter" placeholder="filter…" autocomplete="off">
        <div id="skills-list"></div>
        <button id="author-skill" class="btn btn-ghost">+ New skill…</button>
        <footer class="cost-rollup" id="cost-rollup">
          <div>Estimated cost: <strong id="rollup-tokens">—</strong></div>
          <div>Latency: <strong id="rollup-latency">—</strong></div>
        </footer>
      </aside>

      <section class="preview-panel">
        <header class="preview-header">
          <span id="skill-prev-title">Preview</span>
          <span id="skill-prev-meta" class="hint"></span>
        </header>
        <div class="file-pane">
          <ul id="file-tree" class="file-tree"></ul>
          <pre id="file-body" class="file-body">Select a skill to preview.</pre>
        </div>
      </section>

      <section class="preview-panel skills-editor">
        <header class="preview-header">
          <span>Edit</span>
          <span class="hint">saves as a custom skill for this agent</span>
        </header>
        <textarea id="skill-edit" class="active-text" placeholder="Select a skill on the left to edit it, or click + New skill…"></textarea>
        <footer class="editor-footer">
          <label class="editor-name">name <input id="skill-name" placeholder="name your custom skill" autocomplete="off"></label>
          <button id="skill-save" class="btn btn-primary" disabled>Save custom skill</button>
          <button id="skill-delete" class="btn btn-ghost" hidden>Delete</button>
        </footer>
      </section>
    </div>
  `,
  );

  loadSkills(el, folder);

  el.querySelector('#skill-filter').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase().trim();
    for (const li of el.querySelectorAll('.skill-entry')) {
      li.style.display = !q || li.dataset.name.toLowerCase().includes(q) ? '' : 'none';
    }
  });
  el.querySelector('#author-skill').addEventListener('click', () => authorNewSkill(el));
  el.querySelector('#skill-save').addEventListener('click', () => saveSkill(el));
  el.querySelector('#skill-delete').addEventListener('click', () => deleteSkill(el));
  el.querySelector('#skill-edit').addEventListener('input', () => refreshDraftBanner(el));
}

/** Fetch the shared library, this agent's custom skills, and the active set. */
function loadSkills(el, folder) {
  return Promise.all([
    fetch('/api/skills/library', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : { entries: [] })),
    fetch(`/api/drafts/${folder}/custom-skills`, { credentials: 'same-origin' }).then((r) =>
      r.ok ? r.json() : { entries: [] },
    ),
    fetch(`/api/drafts/${folder}/skills`, { credentials: 'same-origin' }).then((r) =>
      r.ok ? r.json() : { skills: [] },
    ),
  ])
    .then(([lib, custom, active]) => {
      const customEntries = (custom.entries || []).map((c) => ({
        category: 'custom',
        name: c.name,
        description: c.description || '',
        compatibility: 'compatible',
      }));
      libraryCache = [...(lib.entries || []), ...customEntries];
      currentSkills = active.skills;
      originalSkills = Array.isArray(currentSkills) ? [...currentSkills] : currentSkills;
      renderLibraryList(el);
      recomputeRollup(el);
    })
    .catch(() => {
      /* ignore — tab still renders empty */
    });
}

function isSkillActive(name) {
  if (currentSkills === 'all') return true;
  return Array.isArray(currentSkills) && currentSkills.includes(name);
}

function renderLibraryList(el) {
  const listEl = el.querySelector('#skills-list');
  listEl.replaceChildren();
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
      ul.appendChild(renderEntry(el, entry));
    }
    section.appendChild(ul);
    listEl.appendChild(section);
  }
}

function renderEntry(el, entry) {
  const li = document.createElement('li');
  li.className = 'lib-entry skill-entry';
  li.dataset.category = entry.category;
  li.dataset.name = entry.name;
  li.title = entry.description || '';
  if (entry.compatibility === 'incompatible') li.classList.add('skill-incompatible');
  if (entry.compatibility === 'partial') li.classList.add('skill-partial');
  if (currentSelection && currentSelection.category === entry.category && currentSelection.name === entry.name) {
    li.classList.add('selected');
  }

  // Green toggle — click to activate / deactivate. Stops propagation so it
  // doesn't also fire the row's select handler.
  const active = isSkillActive(entry.name);
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = active ? 'skill-toggle active' : 'skill-toggle';
  toggle.title = active ? 'Active — click to deactivate' : 'Inactive — click to activate';
  toggle.setAttribute('aria-pressed', active ? 'true' : 'false');
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleActive(el, entry.name);
  });

  const label = document.createElement('span');
  label.className = 'skill-name';
  const icon = entry.category === 'custom' ? '✏️' : entry.builtin ? '📦' : '🔧';
  const costText = entry.costTokens != null ? ` (+~${entry.costTokens} tok)` : '';
  label.textContent = `${icon} ${entry.name}${costText}`;

  li.appendChild(toggle);
  li.appendChild(label);
  li.addEventListener('click', () => selectSkill(el, entry.category, entry.name));
  return li;
}

function toggleActive(el, name) {
  // Legacy "all" → explicit list (seeded with every known skill) so the
  // click still reads as a single add/remove.
  if (currentSkills === 'all') {
    currentSkills = libraryCache.map((e) => e.name);
  }
  if (currentSkills.includes(name)) {
    currentSkills = currentSkills.filter((s) => s !== name);
  } else {
    currentSkills.push(name);
  }
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
      renderLibraryList(el);
      recomputeRollup(el);
      refreshDraftBanner(el);
    });
}

function selectSkill(el, category, name) {
  // Guard against silently discarding unsaved editor edits.
  const ta = el.querySelector('#skill-edit');
  if (ta.value !== editorBaseline && !confirm('Discard unsaved skill edits?')) return;
  currentSelection = { category, name };
  for (const li of el.querySelectorAll('.skill-entry')) li.classList.remove('selected');
  const sel = el.querySelector(`.skill-entry[data-category="${category}"][data-name="${name}"]`);
  if (sel) sel.classList.add('selected');
  loadPreview(el, category, name);
  loadEditor(el, category, name);
}

function loadPreview(el, category, name) {
  el.querySelector('#skill-prev-title').textContent = `${category}/${name}`;
  const entry = libraryCache.find((e) => e.category === category && e.name === name);
  const metaParts = [];
  if (entry) {
    if (entry.compatibility) metaParts.push(entry.compatibility);
    if (entry.costTokens != null) metaParts.push(`~${entry.costTokens} tok/turn`);
    if (entry.latencyMs != null) metaParts.push(`+${entry.latencyMs}ms/turn`);
  }
  el.querySelector('#skill-prev-meta').textContent = metaParts.join(' · ');
  if (category === 'custom') {
    // Custom skills are a single SKILL.md — no multi-file tree.
    renderFileTree(el, [{ path: 'SKILL.md', isDir: false }]);
    loadFile(el, category, name, 'SKILL.md');
  } else {
    fetch(`/api/skills/library/${encodeURIComponent(category)}/${encodeURIComponent(name)}/files`, {
      credentials: 'same-origin',
    })
      .then((r) => (r.ok ? r.json() : { files: [] }))
      .then((data) => renderFileTree(el, data.files || []));
    loadFile(el, category, name, 'SKILL.md');
  }
}

function renderFileTree(el, files) {
  const tree = el.querySelector('#file-tree');
  tree.replaceChildren();
  for (const f of files) {
    if (f.isDir) continue; // only files are clickable
    const li = document.createElement('li');
    li.className = 'file-entry';
    li.textContent = `📄 ${f.path}`;
    li.dataset.path = f.path;
    if (f.path === 'SKILL.md') li.classList.add('selected');
    li.addEventListener('click', () => {
      if (!currentSelection) return;
      for (const x of tree.querySelectorAll('.file-entry')) x.classList.remove('selected');
      li.classList.add('selected');
      loadFile(el, currentSelection.category, currentSelection.name, f.path);
    });
    tree.appendChild(li);
  }
}

function skillFileUrl(category, name, relPath) {
  if (category === 'custom') {
    return `/api/drafts/${window.__pg.agent.folder}/custom-skills/${encodeURIComponent(name)}`;
  }
  return `/api/skills/library/${encodeURIComponent(category)}/${encodeURIComponent(name)}/file?path=${encodeURIComponent(relPath)}`;
}

function loadFile(el, category, name, relPath) {
  fetch(skillFileUrl(category, name, relPath), { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : { text: '(not found)' }))
    .then((data) => {
      el.querySelector('#file-body').textContent = data.text || '';
    });
}

function loadEditor(el, category, name) {
  const nameInput = el.querySelector('#skill-name');
  const ta = el.querySelector('#skill-edit');
  editorSourceIsCustom = category === 'custom';
  el.querySelector('#skill-delete').hidden = !editorSourceIsCustom;
  el.querySelector('#skill-save').disabled = false;
  fetch(skillFileUrl(category, name, 'SKILL.md'), { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : { text: '' }))
    .then((d) => {
      ta.value = d.text || '';
      editorBaseline = ta.value;
      // Editing a custom skill saves in place; editing a shared library /
      // built-in skill forks a new custom skill, so its name starts blank.
      nameInput.value = editorSourceIsCustom ? name : '';
      nameInput.placeholder = editorSourceIsCustom ? '' : 'name your custom skill';
      refreshDraftBanner(el);
    });
}

function authorNewSkill(el) {
  currentSelection = null;
  for (const li of el.querySelectorAll('.skill-entry')) li.classList.remove('selected');
  editorSourceIsCustom = false;
  el.querySelector('#skill-delete').hidden = true;
  el.querySelector('#skill-save').disabled = false;
  const ta = el.querySelector('#skill-edit');
  ta.value = SKILL_TEMPLATE;
  editorBaseline = SKILL_TEMPLATE;
  const nameInput = el.querySelector('#skill-name');
  nameInput.value = '';
  nameInput.placeholder = 'name your custom skill';
  nameInput.focus();
  el.querySelector('#skill-prev-title').textContent = 'New custom skill';
  el.querySelector('#skill-prev-meta').textContent = '';
  el.querySelector('#file-tree').replaceChildren();
  el.querySelector('#file-body').textContent = 'Name it and Save to add it to your skills.';
}

async function saveSkill(el) {
  const folder = window.__pg.agent.folder;
  const name = el.querySelector('#skill-name').value.trim();
  const content = el.querySelector('#skill-edit').value;
  if (!name) {
    alert('Give the skill a name first.');
    return;
  }
  if (!NAME_RE.test(name)) {
    alert('Name must start alphanumeric; only letters, digits, dashes, dots, underscores.');
    return;
  }
  // A custom skill can't shadow a shared built-in / Anthropic skill.
  const clash = libraryCache.find((e) => e.name === name && e.category !== 'custom');
  if (clash) {
    alert(`"${name}" is already a ${CATEGORY_LABEL[clash.category] || clash.category} skill — pick another name.`);
    return;
  }
  const r = await fetch(`/api/drafts/${folder}/custom-skills/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ content }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    alert(`Save failed: ${e.error || r.status}`);
    return;
  }
  editorBaseline = content; // mark clean so the reselect guard doesn't prompt
  await loadSkills(el, folder);
  selectSkill(el, 'custom', name);
}

async function deleteSkill(el) {
  const folder = window.__pg.agent.folder;
  if (!currentSelection || !editorSourceIsCustom) return;
  const name = currentSelection.name;
  if (!confirm(`Delete custom skill "${name}"? This cannot be undone.`)) return;
  const r = await fetch(`/api/drafts/${folder}/custom-skills/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  if (!r.ok) {
    alert('Delete failed.');
    return;
  }
  // Drop it from the active set if it was on.
  if (Array.isArray(currentSkills) && currentSkills.includes(name)) {
    currentSkills = currentSkills.filter((s) => s !== name);
    await fetch(`/api/drafts/${folder}/skills`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ skills: currentSkills }),
    });
  }
  currentSelection = null;
  editorBaseline = '';
  el.querySelector('#skill-edit').value = '';
  el.querySelector('#skill-name').value = '';
  el.querySelector('#skill-delete').hidden = true;
  el.querySelector('#skill-prev-title').textContent = 'Preview';
  el.querySelector('#skill-prev-meta').textContent = '';
  el.querySelector('#file-tree').replaceChildren();
  el.querySelector('#file-body').textContent = 'Select a skill to preview.';
  await loadSkills(el, folder);
}

function recomputeRollup(el) {
  let tokens = 0;
  let latency = 0;
  let unknown = false;
  const skills = Array.isArray(currentSkills) ? currentSkills : [];
  for (const name of skills) {
    const entry = libraryCache.find((e) => e.name === name);
    if (!entry) {
      unknown = true;
      continue;
    }
    if (entry.costTokens != null) tokens += entry.costTokens;
    else unknown = true;
    if (entry.latencyMs != null) latency += entry.latencyMs;
  }
  el.querySelector('#rollup-tokens').textContent =
    currentSkills === 'all'
      ? 'depends on what gets used'
      : skills.length === 0
        ? 'none'
        : `+~${tokens} tok/turn${unknown ? ' (some skills missing cost metadata)' : ''}`;
  el.querySelector('#rollup-latency').textContent =
    currentSkills === 'all' ? 'depends' : skills.length === 0 ? '—' : `+~${latency}ms/turn`;
}

/** One draft banner for both dirty sources: the active set and the editor. */
function refreshDraftBanner(el) {
  const activeDirty = JSON.stringify(currentSkills) !== JSON.stringify(originalSkills);
  const editorDirty = el.querySelector('#skill-edit').value !== editorBaseline;
  if (activeDirty || editorDirty) {
    showDraftBanner(`${window.__pg.agent.name} has unsaved skill changes.`);
  } else {
    hideDraftBanner();
  }
}
