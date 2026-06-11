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

export function mountSimple(el) {
  const folder = window.__pg.agent.folder;

  el.innerHTML = `
    <div class="simple-mode">
      <div class="simple-topbar">
        <label>model <select id="simple-model-sel"></select></label>
      </div>
      <div class="simple-layout">
        <div class="simple-chat-host"></div>
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
function initPanel(wrapper, folder) {
  /* Task 6 */
}
