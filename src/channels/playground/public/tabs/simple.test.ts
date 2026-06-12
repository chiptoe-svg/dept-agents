// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  renderSkillRows,
  checkedSkills,
  applyUseAgentToggle,
  syncHiddenModelSelects,
  setBubbleLabels,
  setLayerLabels,
  initPanel,
  initModelDropdown,
  adoptTracePanel,
  wireTraceRollup,
  updateDirtyUi,
} from './simple.js';

const SKILLS = [
  { name: 'image-gen', title: 'Image gen', description: 'Create pictures and logos.', enabled: true },
  { name: 'pdf-reader', title: 'Pdf reader', description: 'Read PDFs.', enabled: false },
];

describe('renderSkillRows / checkedSkills', () => {
  it('renders one checkbox row per skill with the saved checked state', () => {
    const host = document.createElement('div');
    renderSkillRows(host, SKILLS);
    const boxes = host.querySelectorAll('input[type="checkbox"]');
    expect(boxes.length).toBe(2);
    expect((boxes[0] as HTMLInputElement).checked).toBe(true);
    expect((boxes[1] as HTMLInputElement).checked).toBe(false);
    expect(host.textContent).toContain('Image gen');
    expect(checkedSkills(host)).toEqual(['image-gen']);
  });

  it('ⓘ expands the description inline, one open at a time', () => {
    const host = document.createElement('div');
    renderSkillRows(host, SKILLS);
    const infos = host.querySelectorAll('.simple-info-btn');
    const descs = host.querySelectorAll('.simple-skill-desc');
    expect((descs[0] as HTMLElement).hidden).toBe(true);

    (infos[0] as HTMLElement).click();
    expect((descs[0] as HTMLElement).hidden).toBe(false);
    expect((descs[0] as HTMLElement).textContent).toContain('Create pictures');

    (infos[1] as HTMLElement).click(); // opening the second closes the first
    expect((descs[0] as HTMLElement).hidden).toBe(true);
    expect((descs[1] as HTMLElement).hidden).toBe(false);

    (infos[1] as HTMLElement).click(); // clicking again closes it
    expect((descs[1] as HTMLElement).hidden).toBe(true);
  });
});

describe('applyUseAgentToggle', () => {
  function wrapperWithHiddenModeButtons() {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
      <button id="mode-agent"></button>
      <button id="mode-direct"></button>
      <div class="simple-panel-body"></div>
    `;
    return wrapper;
  }

  it('OFF clicks the hidden #mode-direct and grays the panel body', () => {
    const wrapper = wrapperWithHiddenModeButtons();
    let clicked = '';
    wrapper.querySelector('#mode-agent')!.addEventListener('click', () => (clicked = 'agent'));
    wrapper.querySelector('#mode-direct')!.addEventListener('click', () => (clicked = 'direct'));

    applyUseAgentToggle(wrapper, false);
    expect(clicked).toBe('direct');
    expect(wrapper.querySelector('.simple-panel-body')!.classList.contains('simple-disabled')).toBe(true);

    applyUseAgentToggle(wrapper, true);
    expect(clicked).toBe('agent');
    expect(wrapper.querySelector('.simple-panel-body')!.classList.contains('simple-disabled')).toBe(false);
  });
});

// happy-dom does not expose Option as a global constructor; polyfill it so
// the tests below (and syncHiddenModelSelects) can use `new Option(text, val)`.
if (typeof Option === 'undefined') {
  (globalThis as any).Option = function (text?: string, value?: string) {
    const opt = document.createElement('option');
    if (text !== undefined) opt.text = text;
    if (value !== undefined) opt.value = value;
    return opt;
  };
}

describe('syncHiddenModelSelects', () => {
  function wrapperWithHiddenSelects() {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `<select id="provider-sel"></select><select id="model-sel"></select>`;
    return wrapper;
  }

  it('maps a catalog modelProvider to its PROVIDER_GROUP id and sets both selects', () => {
    const wrapper = wrapperWithHiddenSelects();
    syncHiddenModelSelects(wrapper, 'openai-codex', 'gpt-5.4-mini');
    expect((wrapper.querySelector('#provider-sel') as HTMLSelectElement).value).toBe('openai');
    expect((wrapper.querySelector('#model-sel') as HTMLSelectElement).value).toBe('gpt-5.4-mini');
  });

  it('appends missing options instead of silently failing (template wider than whitelist)', () => {
    const wrapper = wrapperWithHiddenSelects();
    const modelSel = wrapper.querySelector('#model-sel') as HTMLSelectElement;
    modelSel.add(new Option('other-model', 'other-model'));
    syncHiddenModelSelects(wrapper, 'anthropic', 'claude-haiku-4-5');
    expect(modelSel.value).toBe('claude-haiku-4-5');
    expect([...modelSel.options].map((o) => o.value)).toContain('other-model'); // existing options kept
  });

  it('passes unknown providers through as-is (clemson/local style ids)', () => {
    const wrapper = wrapperWithHiddenSelects();
    syncHiddenModelSelects(wrapper, 'clemson', 'some-model');
    expect((wrapper.querySelector('#provider-sel') as HTMLSelectElement).value).toBe('clemson');
  });
});

describe('setBubbleLabels', () => {
  it('writes both CSS custom properties on the wrapper', () => {
    const wrapper = document.createElement('div');
    setBubbleLabels(wrapper, 'JaneBot', 'gpt-5.4-mini');
    expect(wrapper.style.getPropertyValue('--agent-label')).toBe('"🤖 JaneBot — your agent"');
    expect(wrapper.style.getPropertyValue('--model-label')).toBe(
      '"⚡ gpt-5.4-mini — model only (no skills, no personality)"',
    );
  });

  it('escapes double quotes so a name cannot break out of the CSS string', () => {
    const wrapper = document.createElement('div');
    setBubbleLabels(wrapper, 'Jane"Bot', 'm"x');
    expect(wrapper.style.getPropertyValue('--agent-label')).toBe('"🤖 Jane\\"Bot — your agent"');
    expect(wrapper.style.getPropertyValue('--model-label')).toBe('"⚡ m\\"x — model only (no skills, no personality)"');
  });

  it('strips line terminators so a label cannot break the CSS string', () => {
    const wrapper = document.createElement('div');
    setBubbleLabels(wrapper, 'Jane\nBot', 'm\rx');
    expect(wrapper.style.getPropertyValue('--agent-label')).toBe('"🤖 Jane Bot — your agent"');
    expect(wrapper.style.getPropertyValue('--model-label')).toBe('"⚡ m x — model only (no skills, no personality)"');
  });
});

// ---------------------------------------------------------------------------
// Helpers shared by the Save-flow and model-change tests
// ---------------------------------------------------------------------------

function buildPanelWrapper() {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <input id="simple-agent-name" value="TestBot">
    <div id="simple-skills"></div>
    <textarea id="simple-persona"></textarea>
    <button id="simple-save" type="button">Save my agent</button>
    <div id="simple-save-status"></div>
    <input type="checkbox" id="simple-use-agent" checked>
    <div class="simple-panel-body"></div>
    <button id="mode-agent"></button>
    <button id="mode-direct"></button>
    <select id="simple-model-sel"></select>
    <select id="provider-sel"></select>
    <select id="model-sel"></select>
    <div class="simple-card-header"></div>
    <div class="simple-model-strip"></div>
  `;
  return wrapper;
}

/** Minimal ok-response that returns JSON once. */
function okJson(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body } as Response);
}

describe('updateDirtyUi', () => {
  function dirtyWrapper() {
    const wrapper = buildPanelWrapper();
    renderSkillRows(wrapper.querySelector('#simple-skills')!, SKILLS);
    return wrapper;
  }

  it('marks changed skill rows pending and lights the Save button', () => {
    const wrapper = dirtyWrapper();
    const baseline = { skills: new Set(['image-gen']), persona: '' };
    expect(updateDirtyUi(wrapper, baseline)).toBe(false);

    // Toggle pdf-reader on — its row goes pending, image-gen's doesn't.
    const boxes = wrapper.querySelectorAll<HTMLInputElement>('input[data-skill]');
    boxes[1]!.checked = true;
    expect(updateDirtyUi(wrapper, baseline)).toBe(true);
    const rows = wrapper.querySelectorAll('.simple-skill-row');
    expect(rows[0]!.classList.contains('simple-pending')).toBe(false);
    expect(rows[1]!.classList.contains('simple-pending')).toBe(true);
    const saveBtn = wrapper.querySelector('#simple-save')!;
    const status = wrapper.querySelector('#simple-save-status')!;
    expect(saveBtn.classList.contains('btn-attention')).toBe(true);
    expect(status.textContent).toContain('Unsaved changes');

    // Toggle it back off — everything clears, stale hint blanked.
    boxes[1]!.checked = false;
    expect(updateDirtyUi(wrapper, baseline)).toBe(false);
    expect(rows[1]!.classList.contains('simple-pending')).toBe(false);
    expect(saveBtn.classList.contains('btn-attention')).toBe(false);
    expect(status.textContent).toBe('');
  });

  it('persona edits count as dirty without marking any skill row', () => {
    const wrapper = dirtyWrapper();
    const baseline = { skills: new Set(['image-gen']), persona: 'original' };
    (wrapper.querySelector('#simple-persona') as HTMLTextAreaElement).value = 'edited';
    expect(updateDirtyUi(wrapper, baseline)).toBe(true);
    expect(wrapper.querySelectorAll('.simple-pending').length).toBe(0);
    expect(wrapper.querySelector('#simple-save')!.classList.contains('btn-attention')).toBe(true);
  });
});

describe('initPanel — Save flow', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('PUT skills + PUT persona + POST simple-restart on Save click, shows success status', async () => {
    const folder = 'test-folder';
    const wrapper = buildPanelWrapper();

    // Pre-render two skills so the Save can read checkedSkills().
    renderSkillRows(wrapper.querySelector('#simple-skills')!, [
      { name: 'image-gen', title: 'Image gen', description: '', enabled: true },
      { name: 'pdf-reader', title: 'Pdf reader', description: '', enabled: false },
    ]);
    (wrapper.querySelector('#simple-persona') as HTMLTextAreaElement).value = 'Be helpful.';

    const calls: Array<[string, RequestInit]> = [];
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      calls.push([url, init]);
      // Config load triggered by initPanel — return skills matching our pre-render.
      if (url.startsWith('/api/simple-config')) {
        return okJson({
          agentName: 'TestBot',
          skills: [
            { name: 'image-gen', title: 'Image gen', description: '', enabled: true },
            { name: 'pdf-reader', title: 'Pdf reader', description: '', enabled: false },
          ],
          models: [],
          activeModel: null,
        });
      }
      // Persona GET triggered by initPanel's Promise.all.
      if (
        url === `/api/drafts/${folder}/persona` &&
        (!(init as RequestInit).method || (init as RequestInit).method === 'GET')
      ) {
        return okJson({ text: 'Be helpful.' });
      }
      return okJson({ ok: true });
    });

    initPanel(wrapper, folder);

    // Let the initial fetch Promise.all resolve (skills are rendered after this).
    await new Promise((r) => setTimeout(r, 0));

    // After initPanel's .then runs, persona textarea may have been reset — restore it.
    (wrapper.querySelector('#simple-persona') as HTMLTextAreaElement).value = 'Be helpful.';

    const saveBtn = wrapper.querySelector('#simple-save') as HTMLButtonElement;
    saveBtn.click();

    // Await the full async save chain (skills + persona + restart are sequential awaits).
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const methods = (url: string, method: string) =>
      calls.filter(([u, i]) => u === url && (i as RequestInit).method === method);

    expect(methods(`/api/drafts/${folder}/skills`, 'PUT').length).toBe(1);
    const skillsBody = JSON.parse(methods(`/api/drafts/${folder}/skills`, 'PUT')[0][1].body as string);
    expect(skillsBody.skills).toEqual(['image-gen']); // only checked skill

    expect(methods(`/api/drafts/${folder}/persona`, 'PUT').length).toBe(1);
    const personaBody = JSON.parse(methods(`/api/drafts/${folder}/persona`, 'PUT')[0][1].body as string);
    expect(personaBody.text).toBe('Be helpful.');

    expect(methods('/api/simple-restart', 'POST').length).toBe(1);
    const restartBody = JSON.parse(methods('/api/simple-restart', 'POST')[0][1].body as string);
    expect(restartBody.folder).toBe(folder);

    const statusEl = wrapper.querySelector('#simple-save-status') as HTMLElement;
    expect(statusEl.textContent).toBe('Saved! Your agent will use this from its next reply.');
  });
});

describe('initModelDropdown — model change', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('PUT active-model and syncs hidden selects when #simple-model-sel changes', async () => {
    const folder = 'test-folder';
    const wrapper = buildPanelWrapper();

    const calls: Array<[string, RequestInit]> = [];
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return okJson({ ok: true });
    });

    const config = {
      models: [
        { id: 'gpt-5.5', displayName: 'GPT-5.5', provider: 'openai-codex' },
        { id: 'claude-sonnet-4-5', displayName: 'Claude Sonnet', provider: 'anthropic' },
      ],
      activeModel: { id: 'claude-sonnet-4-5', provider: 'anthropic' },
    };

    initModelDropdown(wrapper, folder, config);

    // Change selection to the OpenAI model.
    // happy-dom v20 only updates selectedOptions[] when the `selected` attribute
    // is toggled via removeAttribute/setAttribute — `sel.value =` or
    // `.selected = true` alone leave selectedOptions stale.
    const sel = wrapper.querySelector('#simple-model-sel') as HTMLSelectElement;
    for (const o of sel.options) o.removeAttribute('selected');
    sel.options[0].setAttribute('selected', ''); // gpt-5.5 / openai-codex
    sel.value = 'gpt-5.5'; // keep .value in sync too
    sel.dispatchEvent(new Event('change'));

    // Await the async fetch inside the change handler.
    await new Promise((r) => setTimeout(r, 0));

    const putCalls = calls.filter(
      ([u, i]) => u === `/api/drafts/${folder}/active-model` && (i as RequestInit).method === 'PUT',
    );
    expect(putCalls.length).toBe(1);
    const body = JSON.parse(putCalls[0][1].body as string);
    expect(body.modelProvider).toBe('openai-codex');
    expect(body.model).toBe('gpt-5.5');

    // Hidden selects should be synced: openai-codex maps to PROVIDER_GROUP id 'openai'.
    expect((wrapper.querySelector('#provider-sel') as HTMLSelectElement).value).toBe('openai');
    expect((wrapper.querySelector('#model-sel') as HTMLSelectElement).value).toBe('gpt-5.5');

    // Layer labels track the dropdown (group-prefixed option label): strip
    // shows the new model, ON-state header shows the agent name.
    expect(wrapper.querySelector('.simple-model-strip')!.textContent).toBe('⚡ OpenAI GPT-5.5 — underneath');
    expect(wrapper.querySelector('.simple-card-header')!.textContent).toBe('🤖 TestBot');
  });
});

describe('trace roll-up', () => {
  function rollupWrapper() {
    const wrapper = document.createElement('div');
    wrapper.className = 'simple-mode';
    wrapper.innerHTML = `
      <div class="simple-chat-host">
        <aside class="trace-panel"><ul id="trace-log"></ul></aside>
      </div>
      <button type="button" class="simple-rollup-btn" aria-expanded="false" title="Show trace">▴</button>
      <div class="simple-trace-strip">🔍 trace — underneath</div>
      <div class="simple-trace-host"></div>
    `;
    return wrapper;
  }

  it('adoptTracePanel moves the SAME trace-panel node into the side host', () => {
    const wrapper = rollupWrapper();
    const panel = wrapper.querySelector('.trace-panel')!;
    const log = wrapper.querySelector('#trace-log')!;
    adoptTracePanel(wrapper);
    // Same node, not a copy — chat.js's captured references must survive.
    expect(wrapper.querySelector('.simple-trace-host .trace-panel')).toBe(panel);
    expect(wrapper.querySelector('.simple-trace-host #trace-log')).toBe(log);
    expect(wrapper.querySelector('.simple-chat-host .trace-panel')).toBeNull();
  });

  it('chevron click toggles .trace-open, aria-expanded, glyph, and title', () => {
    const wrapper = rollupWrapper();
    wireTraceRollup(wrapper);
    const btn = wrapper.querySelector('.simple-rollup-btn') as HTMLButtonElement;

    btn.click();
    expect(wrapper.classList.contains('trace-open')).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(btn.textContent).toBe('▾');
    expect(btn.title).toBe('Hide trace');

    btn.click();
    expect(wrapper.classList.contains('trace-open')).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.textContent).toBe('▴');
    expect(btn.title).toBe('Show trace');
  });

  it('clicking the peek strip rolls up (opens only, never toggles closed)', () => {
    const wrapper = rollupWrapper();
    wireTraceRollup(wrapper);
    const strip = wrapper.querySelector('.simple-trace-strip') as HTMLElement;
    strip.click();
    expect(wrapper.classList.contains('trace-open')).toBe(true);
    strip.click(); // strip is CSS-collapsed when open, but must not toggle closed either way
    expect(wrapper.classList.contains('trace-open')).toBe(true);
  });
});

describe('setLayerLabels / applyUseAgentToggle layering', () => {
  function layeredWrapper() {
    const wrapper = document.createElement('div');
    wrapper.className = 'simple-mode';
    wrapper.innerHTML = `
      <button id="mode-agent"></button>
      <button id="mode-direct"></button>
      <div class="simple-panel-body"></div>
      <div class="simple-card-header"></div>
      <div class="simple-model-strip"></div>
      <input id="simple-agent-name" value="JaneBot">
      <select id="simple-model-sel"><option selected>GPT-5.5</option></select>
    `;
    return wrapper;
  }

  it('writes the strip text and an ON header', () => {
    const wrapper = layeredWrapper();
    setLayerLabels(wrapper, 'JaneBot', 'GPT-5.5');
    expect(wrapper.querySelector('.simple-model-strip')!.textContent).toBe('⚡ GPT-5.5 — underneath');
    expect(wrapper.querySelector('.simple-card-header')!.textContent).toBe('🤖 JaneBot');
  });

  it('swaps both labels when the wrapper is .agent-off — header names the model, strip parks the agent', () => {
    const wrapper = layeredWrapper();
    wrapper.classList.add('agent-off');
    setLayerLabels(wrapper, 'JaneBot', 'GPT-5.5');
    expect(wrapper.querySelector('.simple-card-header')!.textContent).toBe('⚡ GPT-5.5 — model only');
    expect(wrapper.querySelector('.simple-model-strip')!.textContent).toBe('🤖 JaneBot — standing by');
  });

  it('toggle OFF adds .agent-off and swaps the labels; ON restores them', () => {
    const wrapper = layeredWrapper();
    applyUseAgentToggle(wrapper, false);
    expect(wrapper.classList.contains('agent-off')).toBe(true);
    expect(wrapper.querySelector('.simple-card-header')!.textContent).toBe('⚡ GPT-5.5 — model only');
    expect(wrapper.querySelector('.simple-model-strip')!.textContent).toBe('🤖 JaneBot — standing by');

    applyUseAgentToggle(wrapper, true);
    expect(wrapper.classList.contains('agent-off')).toBe(false);
    expect(wrapper.querySelector('.simple-card-header')!.textContent).toBe('🤖 JaneBot');
    expect(wrapper.querySelector('.simple-model-strip')!.textContent).toBe('⚡ GPT-5.5 — underneath');
  });
});
