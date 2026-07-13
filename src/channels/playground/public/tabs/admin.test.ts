// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { renderUserRow, renderModelDefaults } from './admin.js';

describe('renderUserRow', () => {
  function baseUser(over: Record<string, unknown> = {}) {
    return {
      name: 'Jane',
      email: 'jane@clemson.edu',
      folder: 'u1',
      provider: 'local',
      model: 'Qwen3.6-35B-A3B-UD-MLX-4bit',
      privateMode: true,
      lastActive: '2026-07-12',
      session: 1,
      costMtd: 0,
      ...over,
    };
  }

  it('renders a user row with name + private badge when privateMode:true', () => {
    const html = renderUserRow(baseUser()).outerHTML;
    expect(html).toContain('Jane');
    expect(html).toContain('Private');
  });

  it('does not render a Private badge when privateMode:false', () => {
    const row = renderUserRow(baseUser({ privateMode: false }));
    expect(row.textContent).not.toContain('Private');
  });

  it('includes email, model, lastActive, session count and formatted cost', () => {
    const row = renderUserRow(baseUser({ costMtd: 12.5, session: 3 }));
    expect(row.textContent).toContain('jane@clemson.edu');
    expect(row.textContent).toContain('Qwen3.6-35B-A3B-UD-MLX-4bit');
    expect(row.textContent).toContain('2026-07-12');
    expect(row.textContent).toContain('3');
    expect(row.textContent).toContain('$12.50');
  });

  it('renders Rotate and Deactivate action buttons tagged with the user folder', () => {
    const row = renderUserRow(baseUser({ folder: 'u42' }));
    const rotate = row.querySelector('[data-action="rotate"]');
    const deactivate = row.querySelector('[data-action="deactivate"]');
    expect(rotate).toBeTruthy();
    expect(deactivate).toBeTruthy();
    expect(rotate!.getAttribute('data-folder')).toBe('u42');
    expect(deactivate!.getAttribute('data-folder')).toBe('u42');
  });

  it('is XSS-safe — a hostile name renders as text, not markup', () => {
    const row = renderUserRow(baseUser({ name: '<img src=x onerror=alert(1)>' }));
    expect(row.querySelector('img')).toBeNull();
    expect(row.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('renderModelDefaults', () => {
  const catalog = [
    { modelProvider: 'anthropic', model: 'claude-sonnet-4-6', displayName: 'claude-sonnet-4-6' },
    { modelProvider: 'local', model: 'qwen', displayName: 'Qwen (local)' },
  ];

  it('renders a default-cloud and a private select populated from the catalog', () => {
    const cfg = {
      defaultCloud: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      private: { provider: 'local', model: 'qwen' },
    };
    const host = renderModelDefaults(cfg, catalog);
    const cloudSel = host.querySelector('select[data-select="default-cloud"]') as HTMLSelectElement;
    const privateSel = host.querySelector('select[data-select="private"]') as HTMLSelectElement;
    expect(cloudSel).toBeTruthy();
    expect(privateSel).toBeTruthy();
    expect(cloudSel.options.length).toBe(2);
    expect(privateSel.options.length).toBe(2);
  });

  it('pre-selects the option matching cfg', () => {
    const cfg = {
      defaultCloud: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      private: { provider: 'local', model: 'qwen' },
    };
    const host = renderModelDefaults(cfg, catalog);
    const cloudSel = host.querySelector('select[data-select="default-cloud"]') as HTMLSelectElement;
    const privateSel = host.querySelector('select[data-select="private"]') as HTMLSelectElement;
    expect(cloudSel.value).toBe('anthropic|claude-sonnet-4-6');
    expect(privateSel.value).toBe('local|qwen');
  });
});
