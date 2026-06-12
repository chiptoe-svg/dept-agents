/**
 * "My Agent" — the beginner tab. One chat window + one side panel.
 *
 * The chat is the REAL chat tab embedded unchanged (mountChat) inside a
 * `.simple-mode` wrapper; scoped CSS hides the advanced chrome (toolbar,
 * trace panel). The panel drives chat.js's hidden controls programmatically:
 *   - Use-agent toggle → clicks the hidden #mode-agent / #mode-direct
 *   - model dropdown   → PUT active-model + silently sync the hidden
 *     #provider-sel / #model-sel (NO change event — chat.js's own change
 *     handler pops a confirm modal and PUTs active-model itself)
 *
 * Hidden-control contract pinned by simple.test.ts: #mode-agent,
 * #mode-direct, #provider-sel, #model-sel.
 *
 * Spec: docs/superpowers/specs/2026-06-11-simple-my-agent-tab-design.md
 */
import { mountChat } from './chat.js';
import { PROVIDER_GROUPS } from '../provider-groups.js';

/** Render the shortlist as checkbox rows with ⓘ inline-expand descriptions. */
export function renderSkillRows(container, skills) {
  container.innerHTML = '';
  for (const s of skills) {
    const row = document.createElement('div');
    row.className = 'simple-skill-row';

    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!s.enabled;
    cb.dataset.skill = s.name;
    label.appendChild(cb);
    label.appendChild(document.createTextNode(` ${s.title} `));

    const info = document.createElement('button');
    info.type = 'button';
    info.className = 'simple-info-btn';
    info.setAttribute('aria-label', `About ${s.title}`);
    info.textContent = 'ⓘ';

    const desc = document.createElement('div');
    desc.className = 'simple-skill-desc';
    desc.hidden = true;
    desc.textContent = s.description || '';

    info.addEventListener('click', () => {
      const wasHidden = desc.hidden;
      for (const d of container.querySelectorAll('.simple-skill-desc')) d.hidden = true; // one open at a time
      desc.hidden = !wasHidden;
    });

    row.appendChild(label);
    row.appendChild(info);
    row.appendChild(desc);
    container.appendChild(row);
  }
}

/** The checked subset of the rendered shortlist, as skill names. */
export function checkedSkills(container) {
  return [...container.querySelectorAll('input[type="checkbox"]')]
    .filter((cb) => cb.checked)
    .map((cb) => cb.dataset.skill);
}

/**
 * Flip between agent and direct-model chat by clicking the embedded chat's
 * hidden mode buttons (chat.js's setMode handles the rest). OFF also grays
 * the panel body — you can't edit an agent you're not talking to — and adds
 * .agent-off to the wrapper, which drives the layering CSS (the agent card
 * flattens onto the model layer; see the layering block in style.css).
 */
export function applyUseAgentToggle(wrapper, useAgent) {
  const btn = wrapper.querySelector(useAgent ? '#mode-agent' : '#mode-direct');
  if (btn) btn.click();
  const body = wrapper.querySelector('.simple-panel-body');
  if (body) body.classList.toggle('simple-disabled', !useAgent);
  wrapper.classList.toggle('agent-off', !useAgent);
  const nameEl = wrapper.querySelector('#simple-agent-name');
  setLayerLabels(wrapper, (nameEl && nameEl.value.trim()) || 'Your agent', currentModelLabel(wrapper) || 'model');
}

export function mountSimple(el) {
  const folder = window.__pg.agent.folder;

  el.innerHTML = `
    <div class="simple-mode">
      <div class="simple-topbar">
        <label>model <select id="simple-model-sel"></select></label>
      </div>
      <div class="simple-layout">
        <div class="simple-stack">
          <div class="simple-agent-card">
            <div class="simple-card-header"></div>
            <div class="simple-chat-host"></div>
          </div>
          <div class="simple-model-strip"></div>
        </div>
        <aside class="simple-panel">
          <div class="simple-panel-header">
            <label class="simple-toggle" title="Off = talk to the raw model — no skills, no personality">
              <input type="checkbox" id="simple-use-agent" checked>
              <span>Use agent</span>
            </label>
            <input id="simple-agent-name" class="simple-name-input" maxlength="40"
                   title="Your agent's name — click to edit" aria-label="Agent name">
          </div>
          <div class="simple-panel-body">
            <div class="simple-section-label">Skills <span class="simple-hint">(click ⓘ to learn)</span></div>
            <div id="simple-skills"></div>
            <div class="simple-section-label">Personality</div>
            <textarea id="simple-persona" rows="6"></textarea>
            <button id="simple-save" class="btn btn-primary" type="button">Save my agent</button>
            <div id="simple-save-status" class="simple-save-status" role="status"></div>
          </div>
        </aside>
      </div>
    </div>
  `;

  const wrapper = el.querySelector('.simple-mode');
  mountChat(el.querySelector('.simple-chat-host'));

  initPanel(wrapper, folder);
}

// Panel orchestration — fleshed out in Task 6 (data load + wiring) and
// Task 7 (model dropdown + bubble labels). Kept separate from mountSimple
// so the testable helpers below stay pure DOM.
export function initPanel(wrapper, folder) {
  const nameInput = wrapper.querySelector('#simple-agent-name');
  const skillsHost = wrapper.querySelector('#simple-skills');
  const personaEl = wrapper.querySelector('#simple-persona');
  const saveBtn = wrapper.querySelector('#simple-save');
  const statusEl = wrapper.querySelector('#simple-save-status');
  const toggleEl = wrapper.querySelector('#simple-use-agent');

  let lastSavedName = '';

  toggleEl.addEventListener('change', () => applyUseAgentToggle(wrapper, toggleEl.checked));

  // Load config + persona in parallel; render the panel when both land.
  Promise.all([
    fetch(`/api/simple-config?folder=${encodeURIComponent(folder)}`, { credentials: 'same-origin' }).then((r) =>
      r.ok ? r.json() : null,
    ),
    fetch(`/api/drafts/${folder}/persona`, { credentials: 'same-origin' }).then((r) =>
      r.ok ? r.json() : { text: '' },
    ),
  ])
    .then(([config, persona]) => {
      if (!config) {
        statusEl.textContent = "Couldn't load your agent's setup — refresh to retry.";
        return;
      }
      lastSavedName = config.agentName || '';
      nameInput.value = lastSavedName;
      renderSkillRows(skillsHost, config.skills);
      personaEl.value = persona.text || '';
      initModelDropdown(wrapper, folder, config); // Task 7
    })
    .catch(() => {
      statusEl.textContent = "Couldn't load your agent's setup — refresh to retry.";
    });

  // Name saves on blur / Enter; the bubble label follows live.
  async function saveName() {
    const name = nameInput.value.trim();
    if (!name || name === lastSavedName) return true;
    try {
      const r = await fetch(`/api/drafts/${folder}/name`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ name }),
      });
      if (r.ok) {
        lastSavedName = name;
        setBubbleLabels(wrapper, name, currentModelLabel(wrapper)); // Task 7
        return true;
      } else {
        statusEl.textContent = "Couldn't save the name — try again.";
        return false;
      }
    } catch {
      statusEl.textContent = "Couldn't save the name — try again.";
      return false;
    }
  }
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') nameInput.blur();
  });
  nameInput.addEventListener('blur', saveName);

  // Save = skills + persona (+ name if dirty), then restart so the next
  // message respawns the container with the new setup.
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    statusEl.textContent = 'Saving…';
    try {
      const skillsRes = await fetch(`/api/drafts/${folder}/skills`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ skills: checkedSkills(skillsHost) }),
      });
      const personaRes = await fetch(`/api/drafts/${folder}/persona`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ text: personaEl.value }),
      });
      const nameOk = await saveName();
      const restartRes = await fetch('/api/simple-restart', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ folder }),
      });
      if (!skillsRes.ok || !personaRes.ok || !nameOk || !restartRes.ok) throw new Error('save failed');
      statusEl.textContent = 'Saved! Your agent will use this from its next reply.';
    } catch {
      statusEl.textContent = "Couldn't save — try again.";
    } finally {
      saveBtn.disabled = false;
    }
  });
}

/**
 * Keep the embedded chat's hidden #provider-sel / #model-sel in step with
 * the simple dropdown so DIRECT mode (which reads the selects verbatim at
 * send time) uses the same model. Values are set silently — dispatching
 * 'change' on #provider-sel would trip chat.js's provider-switch modal and
 * a second active-model PUT. #provider-sel holds PROVIDER_GROUP ids, so map
 * the catalog modelProvider first; append missing <option>s because the
 * student's whitelist may be narrower than the template's choices.
 */
export function syncHiddenModelSelects(wrapper, provider, modelId) {
  const group = PROVIDER_GROUPS.find((g) => (g.memberModelProviders || []).includes(provider));
  const groupId = group ? group.id : provider;
  const provSel = wrapper.querySelector('#provider-sel');
  const modelSel = wrapper.querySelector('#model-sel');
  if (!provSel || !modelSel) return;
  if (![...provSel.options].some((o) => o.value === groupId)) {
    provSel.add(new Option(group ? group.displayName : provider, groupId));
  }
  provSel.value = groupId;
  if (![...modelSel.options].some((o) => o.value === modelId)) {
    modelSel.add(new Option(modelId, modelId));
  }
  modelSel.value = modelId;
}

/** Bubble headers via CSS vars — see the .simple-mode bubble rules in style.css. */
export function setBubbleLabels(wrapper, agentName, modelLabel) {
  const esc = (s) => String(s).replace(/[\r\n\u2028\u2029]/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  wrapper.style.setProperty('--agent-label', `"🤖 ${esc(agentName)} — your agent"`);
  wrapper.style.setProperty('--model-label', `"⚡ ${esc(modelLabel)} — model only (no skills, no personality)"`);
}

/**
 * Layering chrome text — the slim header on the agent card and the model
 * strip peeking out beneath it. The header names whichever layer you're
 * talking to (agent ON → the agent; .agent-off → the bare model).
 */
export function setLayerLabels(wrapper, agentName, modelLabel) {
  const strip = wrapper.querySelector('.simple-model-strip');
  const header = wrapper.querySelector('.simple-card-header');
  if (strip) strip.textContent = `⚡ ${modelLabel} — underneath`;
  if (header) {
    header.textContent = wrapper.classList.contains('agent-off')
      ? `⚡ ${modelLabel} — model only`
      : `🤖 ${agentName}`;
  }
}

function currentModelLabel(wrapper) {
  const sel = wrapper.querySelector('#simple-model-sel');
  const opt = sel && sel.selectedOptions[0];
  return opt ? opt.textContent : '';
}

/**
 * Top-bar model dropdown — populated from the TEMPLATE's allowed_models
 * (config.models), preselected from the agent's active model. On change:
 * our own PUT active-model (server resolves + recycles the container) and
 * a silent hidden-select sync for direct mode.
 */
export function initModelDropdown(wrapper, folder, config) {
  const sel = wrapper.querySelector('#simple-model-sel');
  sel.innerHTML = '';
  for (const m of config.models) {
    const opt = new Option(m.displayName, m.id);
    opt.dataset.provider = m.provider;
    sel.add(opt);
  }
  if (config.activeModel) {
    let match = [...sel.options].find(
      (o) => o.value === config.activeModel.id && o.dataset.provider === config.activeModel.provider,
    );
    if (!match) {
      // Active model isn't in the template's choices (template changed after
      // this agent was set up) — add it so the dropdown reflects reality.
      match = new Option(config.activeModel.id, config.activeModel.id);
      match.dataset.provider = config.activeModel.provider;
      sel.add(match);
    }
    sel.value = match.value;
  }

  const applySelection = () => {
    const opt = sel.selectedOptions[0];
    if (!opt) return;
    syncHiddenModelSelects(wrapper, opt.dataset.provider, opt.value);
    setBubbleLabels(wrapper, wrapper.querySelector('#simple-agent-name').value.trim() || 'Your agent', opt.textContent);
  };
  applySelection(); // initial labels + hidden-select state

  sel.addEventListener('change', async () => {
    const opt = sel.selectedOptions[0];
    if (!opt) return;
    applySelection();
    try {
      await fetch(`/api/drafts/${folder}/active-model`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ modelProvider: opt.dataset.provider, model: opt.value }),
      });
    } catch {
      /* silent fail — the next agent reply shows the model actually used */
    }
  });
}
