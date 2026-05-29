import { describe, it, expect } from 'vitest';
import { getProviderSpec } from './auth-registry.js';
import './openai-platform-spec.js';

describe('openai-platform-spec', () => {
  it('registers as id="openai-platform" with apiKey-only credential shape', () => {
    const spec = getProviderSpec('openai-platform');
    expect(spec).not.toBeNull();
    expect(spec!.credentialFileShape).toBe('api-key');
    expect(spec!.oauth).toBeUndefined();
    expect(spec!.apiKey).toBeDefined();
    expect(spec!.apiKey!.placeholder).toMatch(/^sk-/);
  });

  it("mirrors codex-spec's 5-model lineup (user assumption: API exposes everything subscription does)", () => {
    const spec = getProviderSpec('openai-platform');
    const ids = spec!.catalogModels!.map((m) => m.id).sort();
    expect(ids).toEqual(['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.5', 'gpt-5.5-pro']);
    for (const entry of spec!.catalogModels!) {
      expect(entry.modelProvider).toBe('openai-platform');
    }
  });

  it('proxyRoutePrefix is /openai-platform/', () => {
    const spec = getProviderSpec('openai-platform');
    expect(spec!.proxyRoutePrefix).toBe('/openai-platform/');
  });
});
