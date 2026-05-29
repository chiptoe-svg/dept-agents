import { describe, it, expect } from 'vitest';
import { getProviderSpec } from './auth-registry.js';
import './codex-spec.js';

describe('codex-spec owns OpenAI-codex catalog entries', () => {
  it('registers all 5 codex models with modelProvider="openai-codex"', () => {
    const spec = getProviderSpec('codex');
    expect(spec).not.toBeNull();
    const ids = spec!.catalogModels!.map((m) => m.id).sort();
    expect(ids).toEqual(['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.5', 'gpt-5.5-pro']);
    for (const entry of spec!.catalogModels!) {
      expect(entry.modelProvider).toBe('openai-codex');
    }
  });

  it('marks gpt-5.4 as the daily-driver default', () => {
    const spec = getProviderSpec('codex');
    const gpt54 = spec!.catalogModels!.find((m) => m.id === 'gpt-5.4');
    expect(gpt54?.default).toBe(true);
  });
});
