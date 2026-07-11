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
import { mountMemberHome } from './tabs/member-home.js';
import { TABS, MEMBER_TABS, hasFullAccess, tabsForRole } from './tab-gating.js';

const mounters = {
  home: (tabEl) => (hasFullAccess(window.__pg?.user?.role) ? mountHome(tabEl) : mountMemberHome(tabEl)),
  simple: mountSimple, chat: mountChat, persona: mountPersona, skills: mountSkills,
  models: mountModels, agents: mountAgents, sources: mountSources,
  retrieval: mountRetrieval, benchmarks: mountBenchmarks, status: mountStatus,
};
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

function applyTabGating(user) {
  allowedTabs = tabsForRole(user.role);
  for (const t of TABS) {
    const btn = document.querySelector(`[data-tab="${t}"]`);
    if (btn) btn.hidden = !allowedTabs.includes(t);
  }
  // Members see the chat surface labeled "Chat" rather than "My Agent".
  if (!hasFullAccess(user.role)) {
    const chatBtn = document.querySelector('[data-tab="simple"]');
    if (chatBtn) chatBtn.textContent = 'Chat';
  }
  const activeBtn = document.querySelector('[data-tab].active');
  const currentTab = activeBtn?.dataset?.tab;
  if (currentTab && !allowedTabs.includes(currentTab)) {
    showTab(allowedTabs[0] || 'home');
  }
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

  window.__pg = { agent, user };
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

  applyTabGating(user);
  initDraftBanner();

  // First visible tab — home if allowed, else whatever's available.
  showTab(allowedTabs.includes('home') ? 'home' : allowedTabs[0] || 'home');
}

init();
