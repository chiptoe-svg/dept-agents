/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openCredDialog, closeCredDialog } from './cred-dialog.js';

beforeEach(() => {
  // Set up modal-root element for the dialog to attach to
  const modalRoot = document.createElement('div');
  modalRoot.id = 'modal-root';
  document.body.appendChild(modalRoot);
  // Stub fetch so any handlers triggered during open don't crash.
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
});

afterEach(() => {
  closeCredDialog();
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
});

const oauthOnly = {
  id: 'codex',
  displayName: 'ChatGPT',
  credentialFileShape: 'oauth-token' as const,
  oauth: { clientId: 'x' },
};
const apiKeyOnly = {
  id: 'openai-platform',
  displayName: 'OpenAI Platform',
  credentialFileShape: 'api-key' as const,
  apiKey: { placeholder: 'sk-…' },
};
const mixed = {
  id: 'claude',
  displayName: 'Anthropic',
  credentialFileShape: 'mixed' as const,
  oauth: { clientId: 'y' },
  apiKey: { placeholder: 'sk-ant-…' },
};
const local = {
  id: 'omlx',
  displayName: 'OMLX',
  credentialFileShape: 'none' as const,
};

describe('cred-dialog variants', () => {
  it('oauth-only: renders one tab, no api-key tab, no active-method radio', () => {
    openCredDialog({
      providerId: 'codex',
      providerSpec: oauthOnly,
      currentCredState: { hasOAuth: true, hasApiKey: false },
      onSaved: () => {},
    });
    const tabs = document.querySelectorAll('[data-tab]');
    expect(tabs.length).toBe(1);
    expect(document.querySelector('[data-active-method]')).toBeNull();
  });

  it('api-key-only: paste input visible, no oauth UI', () => {
    openCredDialog({
      providerId: 'openai-platform',
      providerSpec: apiKeyOnly,
      currentCredState: { hasOAuth: false, hasApiKey: false },
      onSaved: () => {},
    });
    expect(document.querySelector('[data-role="api-key"]')).not.toBeNull();
    expect(document.querySelector('[data-tab="oauth"]')).toBeNull();
  });

  it('mixed with both methods set: two tabs + active-method radio', () => {
    openCredDialog({
      providerId: 'claude',
      providerSpec: mixed,
      currentCredState: { hasOAuth: true, hasApiKey: true },
      onSaved: () => {},
    });
    const tabs = document.querySelectorAll('[data-tab]');
    expect(tabs.length).toBe(2);
    expect(document.querySelector('[data-active-method]')).not.toBeNull();
  });

  it('local: URL field + reachability state visible, no cred fields', () => {
    openCredDialog({
      providerId: 'omlx',
      providerSpec: local,
      currentCredState: { hasOAuth: false, hasApiKey: false },
      onSaved: () => {},
    });
    expect(document.querySelector('[data-role="server-url"]')).not.toBeNull();
    expect(document.querySelector('[data-role="reachability"]')).not.toBeNull();
    expect(document.querySelector('[data-tab]')).toBeNull();
  });
});
