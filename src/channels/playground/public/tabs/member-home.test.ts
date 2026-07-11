// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('../components/cred-dialog.js', () => ({ openCredDialog: vi.fn() }));
import { renderDashboard, renderTelegramPair, mountMemberHome } from './member-home.js';
import { openCredDialog } from '../components/cred-dialog.js';

function baseState(over = {}) {
  return {
    displayName: 'Dr. Smith',
    chatgptConnected: false,
    telegram: { paired: false, botUsername: 'CUInstructorBot' },
    onConnectChatgpt: vi.fn(),
    onConnectTelegram: vi.fn(),
    onGoToChat: vi.fn(),
    ...over,
  };
}

describe('renderDashboard', () => {
  it('greets the member by display name', () => {
    const host = document.createElement('div');
    renderDashboard(host, baseState());
    expect(host.textContent).toContain('Welcome, Dr. Smith');
  });

  it('when ChatGPT is NOT connected: hero is prominent and chip shows the campus model', () => {
    const host = document.createElement('div');
    renderDashboard(host, baseState({ chatgptConnected: false }));
    const hero = host.querySelector('[data-hero]');
    expect(hero).toBeTruthy();
    expect(hero.dataset.hero).toBe('prominent');
    const btn = host.querySelector('[data-action="connect-chatgpt"]');
    expect(btn).toBeTruthy();
    expect(host.textContent).toContain('Connect your ChatGPT');
    // Reassurance + chip
    expect(host.textContent).toContain('free Clemson campus model');
    expect(host.querySelector('[data-model-chip]').textContent).toContain('Clemson campus model (free)');
    // Dept vocabulary only
    expect(host.textContent).not.toMatch(/instructor|student|class\b/i);
  });

  it('when ChatGPT IS connected: hero collapses and chip shows Your ChatGPT', () => {
    const host = document.createElement('div');
    renderDashboard(host, baseState({ chatgptConnected: true }));
    expect(host.querySelector('[data-hero]').dataset.hero).toBe('collapsed');
    expect(host.textContent).toContain('ChatGPT connected');
    expect(host.querySelector('[data-model-chip]').textContent).toContain('Your ChatGPT');
  });

  it('clicking the connect button invokes onConnectChatgpt', () => {
    const host = document.createElement('div');
    const st = baseState();
    renderDashboard(host, st);
    host.querySelector('[data-action="connect-chatgpt"]').click();
    expect(st.onConnectChatgpt).toHaveBeenCalledOnce();
  });

  it('telegram not paired: shows a Connect button wired to onConnectTelegram', () => {
    const host = document.createElement('div');
    const st = baseState({ telegram: { paired: false, botUsername: 'CUInstructorBot' } });
    renderDashboard(host, st);
    const t = host.querySelector('[data-action="connect-telegram"]');
    expect(t).toBeTruthy();
    t.click();
    expect(st.onConnectTelegram).toHaveBeenCalledOnce();
  });

  it('telegram paired: shows linked status, no connect button', () => {
    const host = document.createElement('div');
    renderDashboard(host, baseState({ telegram: { paired: true, botUsername: 'CUInstructorBot', label: '@drsmith' } }));
    expect(host.textContent).toContain('Telegram');
    expect(host.textContent.toLowerCase()).toContain('linked');
    expect(host.querySelector('[data-action="connect-telegram"]')).toBeNull();
  });

  it('Google card is present but disabled and non-interactive', () => {
    const host = document.createElement('div');
    renderDashboard(host, baseState());
    const g = host.querySelector('[data-card="google"] button');
    expect(g).toBeTruthy();
    expect(g.disabled).toBe(true);
    expect(host.querySelector('[data-card="google"]').textContent).toContain('Available soon');
  });

  it('Go to Chat button invokes onGoToChat', () => {
    const host = document.createElement('div');
    const st = baseState();
    renderDashboard(host, st);
    host.querySelector('[data-action="go-to-chat"]').click();
    expect(st.onGoToChat).toHaveBeenCalledOnce();
  });
});

describe('renderTelegramPair', () => {
  it('renders the code and the bot username instruction', () => {
    const host = document.createElement('div');
    renderTelegramPair(host, { code: 'ABC123XYZ0', botUsername: 'CUInstructorBot' });
    expect(host.textContent).toContain('ABC123XYZ0');
    expect(host.textContent).toContain('CUInstructorBot');
  });
});

function jsonRes(obj: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => obj } as unknown as Response;
}

describe('mountMemberHome', () => {
  beforeEach(() => {
    (openCredDialog as ReturnType<typeof vi.fn>).mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('connect-chatgpt opens the cred dialog with an OAuth-only codex spec', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (String(url).includes('/api/me/telegram/pair-code')) return jsonRes({});
      if (String(url).includes('/provider-auth/codex/status'))
        return jsonRes({ active: null, hasApiKey: false, hasOAuth: false });
      if (String(url).includes('/api/me/telegram')) return jsonRes({ paired: false, botUsername: 'CUInstructorBot' });
      return jsonRes({});
    }) as unknown as typeof fetch;

    const el0 = document.createElement('div');
    await mountMemberHome(el0);
    el0.querySelector<HTMLButtonElement>('[data-action="connect-chatgpt"]')!.click();

    expect(openCredDialog).toHaveBeenCalledOnce();
    const arg = (openCredDialog as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.providerId).toBe('codex');
    expect(arg.providerSpec.credentialFileShape).toBe('oauth-token');
    // No bare /api/me/providers fetch is made.
    const urls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/api/me/providers'))).toBe(false);
  });

  it('pair-code POST failure renders an error line and does not throw', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (String(url).includes('/api/me/telegram/pair-code')) return jsonRes({}, false);
      if (String(url).includes('/provider-auth/codex/status')) return jsonRes({ active: null });
      if (String(url).includes('/api/me/telegram')) return jsonRes({ paired: false, botUsername: 'CUInstructorBot' });
      return jsonRes({});
    }) as unknown as typeof fetch;

    const el0 = document.createElement('div');
    await mountMemberHome(el0);
    const btn = el0.querySelector<HTMLButtonElement>('[data-action="connect-telegram"]')!;
    await expect((btn.onclick as () => Promise<void>).call(btn)).resolves.toBeUndefined();
    expect(el0.textContent).toContain("Couldn't start Telegram linking");
    // No pair code rendered on failure.
    expect(el0.querySelector('.pg-pair-code')).toBeNull();
  });

  it('clicking Connect twice while a panel is live creates one panel/one POST', async () => {
    vi.useFakeTimers();
    let pairPosts = 0;
    globalThis.fetch = vi.fn(async (url: string) => {
      if (String(url).includes('/api/me/telegram/pair-code')) {
        pairPosts++;
        return jsonRes({ code: 'CODE12345', expiresAt: Date.now() + 60000 });
      }
      if (String(url).includes('/provider-auth/codex/status')) return jsonRes({ active: null });
      if (String(url).includes('/api/me/telegram')) return jsonRes({ paired: false, botUsername: 'CUInstructorBot' });
      return jsonRes({});
    }) as unknown as typeof fetch;

    const el0 = document.createElement('div');
    await mountMemberHome(el0);
    const btn = el0.querySelector<HTMLButtonElement>('[data-action="connect-telegram"]')!;
    await (btn.onclick as () => Promise<void>).call(btn);
    await (btn.onclick as () => Promise<void>).call(btn);

    expect(pairPosts).toBe(1);
    expect(el0.querySelectorAll('.pg-pair-code').length).toBe(1);
  });
});
