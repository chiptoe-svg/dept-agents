import { mountHome } from './tabs/home.js';
import { mountChat, refreshChatModels } from './tabs/chat.js';
import { mountPersona } from './tabs/persona.js';
import { mountSkills } from './tabs/skills.js';
import { mountModels } from './tabs/models.js';
import { initDraftBanner } from './draft-banner.js';

const TABS = ['home', 'chat', 'persona', 'skills', 'models'];
const mounters = { home: mountHome, chat: mountChat, persona: mountPersona, skills: mountSkills, models: mountModels };
const mounted = {};

function showTab(name) {
  for (const t of TABS) {
    document.querySelector(`[data-tab="${t}"]`).classList.toggle('active', t === name);
    document.getElementById(`tab-${t}`).hidden = t !== name;
  }
  const tabEl = document.getElementById(`tab-${name}`);
  if (!mounted[name]) {
    mounters[name](tabEl);
    mounted[name] = true;
  } else if (name === 'chat') {
    // Tab was previously mounted but the user may have changed the
    // allowedModels whitelist in the Models tab since then — re-fetch so
    // the dropdowns reflect the current curation.
    refreshChatModels(tabEl);
  }
}

async function init() {
  // Resolve the agent group this user is assigned to (or the first non-draft
  // group as a fallback for operators not formally membered).
  let agent = { id: '?', name: '(no agent)', folder: '?' };
  let user = { id: '?', email: undefined, role: 'member' };
  try {
    const r = await fetch('/api/me/agent', { credentials: 'same-origin' });
    if (r.ok) {
      const data = await r.json();
      agent = data.agent;
      user = data.user;
    }
  } catch {
    /* /api/me/agent not yet wired or user not signed in */
  }

  // Pull the class-controls config so we can gate tabs (and Models/auth UIs
  // later). Owner always sees every tab. Other roles see only what the
  // instructor authorized — empty/missing config falls back to "everything"
  // so installs that never touched the file behave as before.
  // v2 shape: { classes: { default: { tabsVisibleToStudents, authModesAvailable,
  //   providers: { [id]: { allow, provideDefault, allowByo } } } } }
  const DEFAULT_CLASS_ID = 'default';
  let classControls = {
    classes: {
      [DEFAULT_CLASS_ID]: {
        tabsVisibleToStudents: ['home', 'chat', 'persona', 'skills', 'models'],
        authModesAvailable: ['api-key', 'oauth', 'claude-code-oauth'],
        providers: {
          codex:  { allow: true, provideDefault: true,  allowByo: true  },
          claude: { allow: true, provideDefault: false, allowByo: true  },
          local:  { allow: true, provideDefault: true,  allowByo: false },
        },
      },
    },
  };
  try {
    const r = await fetch('/api/class-controls', { credentials: 'same-origin' });
    if (r.ok) classControls = await r.json();
  } catch {
    /* default stands */
  }
  const activeClass = classControls.classes[DEFAULT_CLASS_ID];

  window.__pg = { agent, user, classControls, activeClass, DEFAULT_CLASS_ID };
  document.getElementById('active-agent-name').textContent = agent.name;
  document.getElementById('who').textContent = user.email || user.id;

  // Hide tabs the student isn't authorized to see. Owner sees everything.
  const allowedTabs =
    user.role === 'owner' ? TABS : TABS.filter((t) => activeClass.tabsVisibleToStudents.includes(t));
  for (const t of TABS) {
    const btn = document.querySelector(`[data-tab="${t}"]`);
    if (!btn) continue;
    btn.hidden = !allowedTabs.includes(t);
  }

  initDraftBanner();

  for (const t of allowedTabs) {
    document.querySelector(`[data-tab="${t}"]`).addEventListener('click', () => showTab(t));
  }
  // First visible tab — home if allowed, else whatever's available.
  showTab(allowedTabs.includes('home') ? 'home' : allowedTabs[0] || 'home');
}

init();
