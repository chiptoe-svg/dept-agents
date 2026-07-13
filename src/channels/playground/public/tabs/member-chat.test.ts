// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { renderMessage, renderFileCard, renderAttachChips, modelLabel, privacyLabel } from './member-chat.js';

describe('renderMessage', () => {
  it('renders a user message with its text', () => {
    const host = document.createElement('div');
    renderMessage(host, { role: 'user', text: 'hello agent' });
    const bubble = host.querySelector('[data-role="user"]');
    expect(bubble).toBeTruthy();
    expect(host.textContent).toContain('hello agent');
  });
  it('renders an agent message with a file download card', () => {
    const host = document.createElement('div');
    renderMessage(host, {
      role: 'agent',
      text: 'here you go',
      files: [{ name: 'report.pdf', url: '/api/drafts/f/files/m/report.pdf' }],
    });
    expect(host.querySelector('[data-role="agent"]')).toBeTruthy();
    const link = host.querySelector('a[download]');
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe('/api/drafts/f/files/m/report.pdf');
    expect(link.textContent).toContain('report.pdf');
  });
});

describe('renderFileCard', () => {
  it('is a download link with the filename', () => {
    const host = document.createElement('div');
    renderFileCard(host, { name: 'data.csv', url: '/x/data.csv' });
    const a = host.querySelector('a[download]');
    expect(a.getAttribute('href')).toBe('/x/data.csv');
    expect(host.textContent).toContain('data.csv');
  });
});

describe('renderAttachChips', () => {
  it('renders one removable chip per file and fires onRemove', () => {
    const host = document.createElement('div');
    const onRemove = vi.fn();
    renderAttachChips(host, [{ name: 'a.docx' }, { name: 'b.png' }], onRemove);
    const chips = host.querySelectorAll('[data-chip]');
    expect(chips.length).toBe(2);
    expect(host.textContent).toContain('a.docx');
    host.querySelectorAll('[data-remove]')[0].click();
    expect(onRemove).toHaveBeenCalledWith(0);
  });
});

describe('modelLabel', () => {
  it('maps the model provider to a friendly label', () => {
    expect(modelLabel('clemson')).toContain('Clemson campus model');
    expect(modelLabel(null)).toContain('Clemson campus model');
    expect(modelLabel('openai-codex')).toContain('Your ChatGPT');
    expect(modelLabel('openai')).toContain('Your ChatGPT');
    expect(modelLabel('anthropic')).toContain('Department account');
  });
});

describe('privacyLabel', () => {
  it('labels Private when the active provider matches the private provider', () => {
    expect(privacyLabel({ modelProvider: 'local', privateProvider: 'local' })).toBe('Private — on-box, stays local');
  });
  it('labels Clemson cloud mode', () => {
    expect(privacyLabel({ modelProvider: 'clemson', privateProvider: 'local' })).toBe('Cloud — Clemson (free)');
  });
  it('labels ChatGPT cloud mode', () => {
    expect(privacyLabel({ modelProvider: 'openai-codex', privateProvider: 'local' })).toBe('Cloud — your ChatGPT');
  });
  it('falls back to a generic cloud label for any other provider', () => {
    expect(privacyLabel({ modelProvider: 'anthropic', privateProvider: 'local' })).toBe('Cloud — department account');
  });
  it('treats a null active provider as cloud, not private', () => {
    expect(privacyLabel({ modelProvider: null, privateProvider: 'local' })).toBe('Cloud — department account');
  });
});
