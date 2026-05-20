import { showDraftBanner, hideDraftBanner } from '../draft-banner.js';

// Active-set state — 'all' (legacy sentinel) or string[].
let originalSkills = null; // active set at tab-open, for dirty detection
let currentSkills = null;

// Merged skill list: built-in + Anthropic library + this agent's custom skills.
let libraryCache = [];

let currentSelection = null; // { category, name } highlighted on the left

// Editor working set — the files of the skill being authored / edited.
//   files:      { relPath: content }
//   current:    relPath shown in the textarea
//   customName: name when editing an existing custom skill in place, else null
//   baseline:   JSON snapshot of files at load, for dirty detection
let editor = { files: {}, current: null, customName: null, baseline: '{}' };

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

function enc(s) {
  return encodeURIComponent(s);
}

function fetchJson(url, fallback) {
  return fetch(url, { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : fallback))
    .catch(() => fallback);
}

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
        <footer class="cost-rollup" id="cost-rollup"><span id="rollup-summary">—</span></footer>
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
          <button id="author-skill" class="btn btn-ghost" type="button">+ New skill</button>
        </header>
        <div id="editor-files" class="editor-files"></div>
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
    fetchJson('/api/skills/library', { entries: [] }),
    fetchJson(`/api/drafts/${folder}/custom-skills`, { entries: [] }),
    fetchJson(`/api/drafts/${folder}/skills`, { skills: [] }),
  ]).then(([lib, custom, active]) => {
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
  if (editorSnapshot(el) !== editor.baseline && !confirm('Discard unsaved skill edits?')) return;
  currentSelection = { category, name };
  for (const li of el.querySelectorAll('.skill-entry')) li.classList.remove('selected');
  const sel = el.querySelector(`.skill-entry[data-category="${category}"][data-name="${name}"]`);
  if (sel) sel.classList.add('selected');
  loadPreview(el, category, name);
  loadEditor(el, category, name);
}

// ── Middle preview ─────────────────────────────────────────────────────────

function skillFilesUrl(category, name) {
  if (category === 'custom') {
    return `/api/drafts/${enc(window.__pg.agent.folder)}/custom-skills/${enc(name)}/files`;
  }
  return `/api/skills/library/${enc(category)}/${enc(name)}/files`;
}

function skillFileUrl(category, name, relPath) {
  if (category === 'custom') {
    return `/api/drafts/${enc(window.__pg.agent.folder)}/custom-skills/${enc(name)}/file?path=${enc(relPath)}`;
  }
  return `/api/skills/library/${enc(category)}/${enc(name)}/file?path=${enc(relPath)}`;
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
  fetchJson(skillFilesUrl(category, name), { files: [] }).then((data) => renderFileTree(el, data.files || []));
  loadFile(el, category, name, 'SKILL.md');
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
      // Also move the editor to this file so the right panel tracks the
      // file selection (when the editor holds the same skill).
      if (f.path in editor.files) switchEditorFile(el, f.path);
    });
    tree.appendChild(li);
  }
}

function loadFile(el, category, name, relPath) {
  fetchJson(skillFileUrl(category, name, relPath), { text: '(not found)' }).then((data) => {
    el.querySelector('#file-body').textContent = data.text || '';
  });
}

// ── Right-hand editor (multi-file working set) ──────────────────────────────

/** Save the textarea's current contents back into the working set. */
function stashCurrent(el) {
  if (editor.current) editor.files[editor.current] = el.querySelector('#skill-edit').value;
}

/** Stable JSON of the working set — for dirty detection. */
function editorSnapshot(el) {
  stashCurrent(el);
  const sorted = {};
  for (const k of Object.keys(editor.files).sort()) sorted[k] = editor.files[k];
  return JSON.stringify(sorted);
}

function renderEditorFiles(el) {
  const strip = el.querySelector('#editor-files');
  strip.replaceChildren();
  for (const rel of Object.keys(editor.files).sort()) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = rel === editor.current ? 'editor-file active' : 'editor-file';
    chip.textContent = rel;
    chip.addEventListener('click', () => switchEditorFile(el, rel));
    strip.appendChild(chip);
  }
  // Hide "+ file" until a skill is loaded — nothing to add files to yet.
  if (Object.keys(editor.files).length > 0) {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'editor-file editor-file-add';
    add.textContent = '+ file';
    add.title = 'Add a file to this skill';
    add.addEventListener('click', () => addEditorFile(el));
    strip.appendChild(add);
  }
}

function switchEditorFile(el, rel) {
  if (!(rel in editor.files) || rel === editor.current) return;
  stashCurrent(el);
  editor.current = rel;
  el.querySelector('#skill-edit').value = editor.files[rel];
  renderEditorFiles(el);
}

function addEditorFile(el) {
  const rel = (prompt('New file (e.g. reference.md, examples/demo.md):') || '').trim();
  if (!rel) return;
  if (!rel.split('/').every((seg) => NAME_RE.test(seg))) {
    alert('File path segments must be alphanumeric (dashes, dots, underscores allowed).');
    return;
  }
  if (rel in editor.files) {
    switchEditorFile(el, rel);
    return;
  }
  stashCurrent(el);
  editor.files[rel] = rel.endsWith('.md') ? `# ${rel.replace(/\.md$/, '').replace(/.*\//, '')}\n` : '';
  editor.current = rel;
  el.querySelector('#skill-edit').value = editor.files[rel];
  renderEditorFiles(el);
  refreshDraftBanner(el);
}

async function loadEditor(el, category, name) {
  editor.customName = category === 'custom' ? name : null;
  el.querySelector('#skill-delete').hidden = !editor.customName;
  el.querySelector('#skill-save').disabled = false;
  // Build the working set from the source skill's files. A library/built-in
  // skill is the basis for a fork; a custom skill is edited in place.
  const list = await fetchJson(skillFilesUrl(category, name), { files: [] });
  const entries = await Promise.all(
    (list.files || [])
      .filter((f) => !f.isDir)
      .map(async (f) => {
        const d = await fetchJson(skillFileUrl(category, name, f.path), { text: '' });
        return [f.path, d.text || ''];
      }),
  );
  const files = Object.fromEntries(entries);
  if (Object.keys(files).length === 0) files['SKILL.md'] = '';
  editor.files = files;
  editor.current = 'SKILL.md' in files ? 'SKILL.md' : Object.keys(files).sort()[0];
  el.querySelector('#skill-edit').value = editor.files[editor.current];
  editor.baseline = editorSnapshot(el);
  const nameInput = el.querySelector('#skill-name');
  nameInput.value = editor.customName || '';
  nameInput.placeholder = editor.customName ? '' : 'name your custom skill';
  renderEditorFiles(el);
  refreshDraftBanner(el);
}

function authorNewSkill(el) {
  if (editorSnapshot(el) !== editor.baseline && !confirm('Discard unsaved skill edits?')) return;
  currentSelection = null;
  for (const li of el.querySelectorAll('.skill-entry')) li.classList.remove('selected');
  editor = { files: { 'SKILL.md': SKILL_TEMPLATE }, current: 'SKILL.md', customName: null, baseline: '{}' };
  el.querySelector('#skill-delete').hidden = true;
  el.querySelector('#skill-save').disabled = false;
  el.querySelector('#skill-edit').value = SKILL_TEMPLATE;
  editor.baseline = editorSnapshot(el);
  renderEditorFiles(el);
  const nameInput = el.querySelector('#skill-name');
  nameInput.value = '';
  nameInput.placeholder = 'name your custom skill';
  nameInput.focus();
  el.querySelector('#skill-prev-title').textContent = 'New custom skill';
  el.querySelector('#skill-prev-meta').textContent = '';
  el.querySelector('#file-tree').replaceChildren();
  el.querySelector('#file-body').textContent = 'Name it and Save to add it to your skills.';
  refreshDraftBanner(el);
}

async function saveSkill(el) {
  const folder = window.__pg.agent.folder;
  const name = el.querySelector('#skill-name').value.trim();
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
  stashCurrent(el);
  for (const [rel, content] of Object.entries(editor.files)) {
    const r = await fetch(`/api/drafts/${folder}/custom-skills/${enc(name)}/file?path=${enc(rel)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ content }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      alert(`Save failed for ${rel}: ${e.error || r.status}`);
      return;
    }
  }
  editor.baseline = editorSnapshot(el); // mark clean so the reselect guard stays quiet
  await loadSkills(el, folder);
  selectSkill(el, 'custom', name);
}

async function deleteSkill(el) {
  const folder = window.__pg.agent.folder;
  const name = editor.customName;
  if (!name) return;
  if (!confirm(`Delete custom skill "${name}"? This cannot be undone.`)) return;
  const r = await fetch(`/api/drafts/${folder}/custom-skills/${enc(name)}`, {
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
  resetEditor(el);
  await loadSkills(el, folder);
}

function resetEditor(el) {
  currentSelection = null;
  editor = { files: {}, current: null, customName: null, baseline: '{}' };
  el.querySelector('#skill-edit').value = '';
  el.querySelector('#skill-name').value = '';
  el.querySelector('#skill-delete').hidden = true;
  el.querySelector('#skill-save').disabled = true;
  el.querySelector('#editor-files').replaceChildren();
  el.querySelector('#skill-prev-title').textContent = 'Preview';
  el.querySelector('#skill-prev-meta').textContent = '';
  el.querySelector('#file-tree').replaceChildren();
  el.querySelector('#file-body').textContent = 'Select a skill to preview.';
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
  const footer = el.querySelector('#cost-rollup');
  const summary = el.querySelector('#rollup-summary');
  if (currentSkills === 'all') {
    summary.textContent = 'all skills active · cost depends on usage';
    footer.removeAttribute('title');
  } else if (skills.length === 0) {
    summary.textContent = 'no skills active';
    footer.removeAttribute('title');
  } else {
    summary.textContent = `${skills.length} active · +~${tokens} tok · +~${latency} ms / turn${unknown ? ' *' : ''}`;
    if (unknown) {
      footer.title = 'Some active skills have no cost metadata — estimate is a lower bound.';
    } else {
      footer.removeAttribute('title');
    }
  }
}

/** One draft banner for both dirty sources: the active set and the editor. */
function refreshDraftBanner(el) {
  const activeDirty = JSON.stringify(currentSkills) !== JSON.stringify(originalSkills);
  const editorDirty = editorSnapshot(el) !== editor.baseline;
  if (activeDirty || editorDirty) {
    showDraftBanner(`${window.__pg.agent.name} has unsaved skill changes.`);
  } else {
    hideDraftBanner();
  }
}
