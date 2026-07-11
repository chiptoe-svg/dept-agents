/**
 * Member Home — the department member's landing/setup dashboard.
 *
 * Composes connect flows that already exist (Plan 4 cred-dialog + codex
 * OAuth; class-telegram-pair). Steers the member to connect their own
 * ChatGPT; the free Clemson campus model keeps the agent working meanwhile,
 * so nothing here gates. Google is a disabled "Available soon" placeholder
 * until the one-time GCP step lands.
 */
import { openCredDialog } from '../components/cred-dialog.js';

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('data') || k === 'disabled') node.setAttribute(k, v === true ? '' : v);
    else node[k] = v;
  }
  for (const c of children) node.append(c);
  return node;
}

/** Pure: build the member dashboard into `host` from `state`. */
export function renderDashboard(host, state) {
  host.replaceChildren();
  const { displayName, chatgptConnected, telegram, modelLabel } = state;

  host.append(el('h2', { class: 'pg-greeting', text: `Welcome, ${displayName}` }));

  // Hero — connect ChatGPT (prominent) or collapsed status.
  const hero = el('section', { class: 'pg-hero', 'data-hero': chatgptConnected ? 'collapsed' : 'prominent' });
  if (chatgptConnected) {
    hero.append(el('span', { text: '✓ ChatGPT connected — usage on your account. ' }));
    hero.append(el('button', { 'data-action': 'connect-chatgpt', text: 'Manage', onclick: state.onConnectChatgpt }));
  } else {
    hero.append(el('h3', { text: 'Connect your ChatGPT' }));
    hero.append(el('p', { text: 'Put your AI usage on your own account.' }));
    hero.append(el('button', { class: 'pg-primary', 'data-action': 'connect-chatgpt', text: 'Connect your ChatGPT', onclick: state.onConnectChatgpt }));
  }
  host.append(hero);

  host.append(el('p', { class: 'pg-reassure', text: 'Your agent already works on the free Clemson campus model — connecting is optional but recommended.' }));

  const chip = el('div', { class: 'pg-model-chip', 'data-model-chip': '' });
  chip.append(el('span', { text: 'Running on: ' }));
  chip.append(el('b', { text: modelLabel || 'Clemson campus model (free)' }));
  host.append(chip);

  // Secondary: Telegram + Google.
  const more = el('section', { class: 'pg-connections' });
  more.append(el('h4', { text: 'More connections' }));

  const tgCard = el('div', { class: 'pg-card', 'data-card': 'telegram' });
  tgCard.append(el('span', { text: 'Telegram' }));
  if (telegram.paired) {
    tgCard.append(el('span', { text: ` — ✓ Linked${telegram.label ? ' as ' + telegram.label : ''}` }));
  } else {
    tgCard.append(el('button', { 'data-action': 'connect-telegram', text: 'Connect', onclick: state.onConnectTelegram }));
  }
  more.append(tgCard);

  const gCard = el('div', { class: 'pg-card', 'data-card': 'google' });
  gCard.append(el('span', { text: 'Google Docs/Sheets — Available soon' }));
  gCard.append(el('button', { disabled: true, text: 'Connect' }));
  more.append(gCard);

  host.append(more);

  host.append(el('button', { class: 'pg-goto-chat', 'data-action': 'go-to-chat', text: 'Go to Chat →', onclick: state.onGoToChat }));
}

/** Pure: render the Telegram pair-code instruction block into `host`. */
export function renderTelegramPair(host, { code, botUsername }) {
  host.replaceChildren();
  host.append(el('p', { text: `Message @${botUsername} on Telegram with this code:` }));
  host.append(el('code', { class: 'pg-pair-code', text: code }));
  host.append(el('p', { class: 'pg-pair-hint', text: "This code expires shortly — this panel updates once you're linked." }));
}

async function getJson(url, fallback) {
  try {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (!r.ok) return fallback;
    return await r.json();
  } catch {
    return fallback;
  }
}

const MODEL_LABELS = {
  'openai-codex': 'Your ChatGPT',
  openai: 'Your ChatGPT',
  anthropic: 'Department account',
};

/** Pure: map a container config's modelProvider to the chip's display label. */
function labelForModelProvider(modelProvider) {
  return MODEL_LABELS[modelProvider] || 'Clemson campus model (free)';
}

/** Tab mount entry: fetch state, render, wire actions. */
export async function mountMemberHome(el0) {
  const windowUser = (window.__pg && window.__pg.user) || {};

  // Fetch /api/me/agent fresh rather than trusting the possibly-stale
  // window.__pg snapshot — modelProvider and displayName can change after
  // a connect action re-mounts this tab.
  const [codex, tg, meAgent] = await Promise.all([
    getJson('/provider-auth/codex/status', { active: null }),
    getJson('/api/me/telegram', { paired: false, botUsername: '' }),
    getJson('/api/me/agent', null),
  ]);

  const user = meAgent?.user || windowUser;
  const agent = meAgent?.agent || {};
  const displayName = user.displayName || agent.name || user.id || windowUser.email || windowUser.id || 'there';
  const folder = agent.folder || windowUser.agent?.folder;

  // Guard against re-entry: one Telegram pair panel/poll at a time.
  let tgInFlight = false;
  // Reused across repeated Telegram-connect clicks so failures/expiries
  // don't stack new panels down the page.
  let tgPanel = null;

  const state = {
    displayName,
    chatgptConnected: codex.active !== null,
    modelLabel: labelForModelProvider(agent.modelProvider),
    telegram: { paired: !!tg.paired, botUsername: tg.botUsername || '', label: tg.telegramHandle ? '@' + tg.telegramHandle : undefined },
    onConnectChatgpt: () =>
      openCredDialog({
        providerId: 'codex',
        providerSpec: { id: 'codex', displayName: 'ChatGPT', credentialFileShape: 'oauth-token' },
        currentCredState: { hasApiKey: !!codex.hasApiKey, hasOAuth: !!codex.hasOAuth, active: codex.active },
        onSaved: async () => {
          // Connecting ChatGPT must actually switch the agent onto it —
          // otherwise the agent keeps running on Clemson while the chip
          // (once re-mounted) would lie about what's active.
          if (folder) {
            try {
              const r = await fetch(`/api/drafts/${encodeURIComponent(folder)}/active-model`, {
                method: 'PUT',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ modelProvider: 'openai-codex', model: 'gpt-5.4' }),
              });
              // Non-ok is not fatal here — the OAuth connect itself already
              // succeeded; the chip will just stay on its prior label until
              // the member retries.
              void r.ok;
            } catch {
              // Same as above: don't throw on a failed model switch.
            }
          }
          mountMemberHome(el0);
        },
      }),
    onConnectTelegram: async () => {
      if (tgInFlight) return;
      tgInFlight = true;
      const btn = el0.querySelector('[data-action="connect-telegram"]');
      if (btn) btn.disabled = true;
      const release = () => {
        tgInFlight = false;
        if (btn) btn.disabled = false;
      };

      if (!tgPanel) {
        tgPanel = document.createElement('div');
        el0.append(tgPanel);
      } else {
        tgPanel.replaceChildren();
      }
      const panel = tgPanel;

      // POST mints a fresh single-use code (GET only reports status).
      let minted;
      try {
        const r = await fetch('/api/me/telegram/pair-code', {
          method: 'POST',
          credentials: 'same-origin',
        });
        if (!r.ok) throw new Error('pair-code request failed');
        minted = await r.json();
      } catch {
        panel.replaceChildren(el('p', { class: 'pg-pair-error', text: "Couldn't start Telegram linking — try again." }));
        release();
        return;
      }

      renderTelegramPair(panel, { code: minted.code, botUsername: state.telegram.botUsername });

      // Deadline from the mint response so a bad code can't poll forever.
      const expiresAt = typeof minted.expiresAt === 'number' ? minted.expiresAt : Date.now() + 15 * 60 * 1000;
      // Poll until the member DMs the code to the bot and gets linked.
      const poll = setInterval(async () => {
        if (Date.now() > expiresAt) {
          clearInterval(poll);
          panel.replaceChildren(el('p', { class: 'pg-pair-error', text: 'This code expired — try again.' }));
          release();
          return;
        }
        const s = await getJson('/api/me/telegram', { paired: false });
        if (s.paired) {
          clearInterval(poll);
          mountMemberHome(el0);
        }
      }, 4000);
      poll.unref?.();
    },
    onGoToChat: () => document.querySelector('[data-tab="simple"]')?.click(),
  };
  renderDashboard(el0, state);
}
