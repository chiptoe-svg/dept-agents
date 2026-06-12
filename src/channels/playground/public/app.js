import { mountHome } from './tabs/home.js';
import { mountSimple } from './tabs/simple.js';
import { mountChat, refreshChatModels } from './tabs/chat.js';
import { mountPersona } from './tabs/persona.js';
import { mountSkills } from './tabs/skills.js';
import { mountModels } from './tabs/models.js';
import { mountAgents } from './tabs/agents.js';
import { mountSources } from './tabs/sources.js';
import { mountRetrieval } from './tabs/retrieval.js';
import { mountBenchmarks } from './tabs/benchmarks.js';
import { mountStatus } from './tabs/status.js';
import { initDraftBanner } from './draft-banner.js';

const TABS = ['home', 'simple', 'chat', 'persona', 'skills', 'models', 'agents', 'sources', 'retrieval', 'benchmarks', 'status'];
const mounters = { home: mountHome, simple: mountSimple, chat: mountChat, persona: mountPersona, skills: mountSkills, models: mountModels, agents: mountAgents, sources: mountSources, retrieval: mountRetrieval, benchmarks: mountBenchmarks, status: mountStatus };
const mounted = {};
let allowedTabs = TABS.slice();

function showTab(name) {
  if (!allowedTabs.includes(name)) return;
  for (const t of TABS) {
    document.querySelector(`[data-tab="${t}"]`).classList.toggle('active', t === name);
    document.getElementById(`tab-${t}`).hidden = t !== name;
  }
  const tabEl = document.getElementById(`tab-${name}`);
  if (!mounted[name]) {
    mounters[name](tabEl);
    mounted[name] = true;
  } else if (name === 'chat') {
    refreshChatModels(tabEl);
  }
}

function applyClassControls(classControls, user) {
  const activeClass = classControls.classes['default'];
  window.__pg.classControls = classControls;
  window.__pg.activeClass = activeClass;
  allowedTabs = (user.role === 'owner' || user.role === 'ta') ? TABS : TABS.filter((t) => activeClass.tabsVisibleToStudents.includes(t));
  for (const t of TABS) {
    const btn = document.querySelector(`[data-tab="${t}"]`);
    if (btn) btn.hidden = !allowedTabs.includes(t);
  }
  // If the currently visible tab was just hidden, jump to the first allowed one.
  const activeBtn = document.querySelector('[data-tab].active');
  const currentTab = activeBtn?.dataset?.tab;
  if (currentTab && !allowedTabs.includes(currentTab)) {
    showTab(allowedTabs[0] || 'home');
  }
  // A student stripped down to exactly one tab gets a single uncluttered
  // page — no tab strip at all.
  const tabBar = document.getElementById('tab-bar');
  if (tabBar) tabBar.hidden = allowedTabs.length === 1;
}

async function init() {
  // Resolve the agent group this user is assigned to (or the first non-draft
  // group as a fallback for operators not formally membered).
  // In bypass+seats mode the ?seat=<folder> URL param selects which seat to load.
  let agent = { id: '?', name: '(no agent)', folder: '?' };
  let user = { id: '?', email: undefined, role: 'member' };
  try {
    const seatParam = new URLSearchParams(location.search).get('seat');
    const meUrl = seatParam ? `/api/me/agent?seat=${encodeURIComponent(seatParam)}` : '/api/me/agent';
    const r = await fetch(meUrl, { credentials: 'same-origin' });
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
        tabsVisibleToStudents: ['home', 'chat', 'persona', 'skills', 'models', 'agents'],
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
  if (user.role === 'ta') document.body.classList.add('pg-ta-view');
  document.getElementById('active-agent-name').textContent = agent.name;
  document.getElementById('who').textContent = user.email || user.id || '';
  if (user.seatLabel) {
    const lbl = document.getElementById('seat-label');
    lbl.textContent = user.seatLabel;
    lbl.hidden = false;
    document.getElementById('switch-seat').hidden = false;
    document.title = `${user.seatLabel} · Agent Playground`;
  }

  // Wire all tab buttons once. showTab() guards against hidden tabs internally.
  for (const t of TABS) {
    const btn = document.querySelector(`[data-tab="${t}"]`);
    if (btn) btn.addEventListener('click', () => showTab(t));
  }

  applyClassControls(classControls, user);
  initDraftBanner();

  // First visible tab — home if allowed, else whatever's available.
  showTab(allowedTabs.includes('home') ? 'home' : allowedTabs[0] || 'home');

  // Listen for live class-controls updates pushed by the instructor.
  const es = new EventSource(`/api/drafts/${agent.folder}/stream`);
  es.addEventListener('class-controls-changed', (e) => {
    try {
      applyClassControls(JSON.parse(e.data), window.__pg.user);
    } catch { /* malformed push — ignore */ }
  });
}

init();
