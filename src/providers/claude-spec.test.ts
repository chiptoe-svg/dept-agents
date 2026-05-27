import { describe, it, expect } from 'vitest';
import { getProviderSpec } from './auth-registry.js';
import './claude-spec.js'; // side-effect import to register

describe('claude-spec owns Anthropic catalog entries', () => {
  it('registers catalogModels with claude-haiku-4-5 and claude-sonnet-4-6', () => {
    const spec = getProviderSpec('claude');
    expect(spec).not.toBeNull();
    expect(spec!.catalogModels).toBeDefined();
    const ids = spec!.catalogModels!.map((m) => m.id);
    expect(ids).toContain('claude-haiku-4-5');
    expect(ids).toContain('claude-sonnet-4-6');
  });

  it('catalog entries use modelProvider="anthropic" (Phase D rename)', () => {
    const spec = getProviderSpec('claude');
    for (const entry of spec!.catalogModels!) {
      expect(entry.modelProvider).toBe('anthropic');
    }
  });
});
