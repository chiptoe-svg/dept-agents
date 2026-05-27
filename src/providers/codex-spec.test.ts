import { describe, it, expect } from 'vitest';
import { getProviderSpec } from './auth-registry.js';
import './codex-spec.js';

describe('codex-spec owns OpenAI-codex catalog entries', () => {
  it('registers all 5 codex models with modelProvider="openai-codex"', () => {
    const spec = getProviderSpec('codex');
    expect(spec).not.toBeNull();
    const ids = spec!.catalogModels!.map((m) => m.id).sort();
    expect(ids).toEqual(['gpt-5.2', 'gpt-5.3-codex', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.5']);
    for (const entry of spec!.catalogModels!) {
      expect(entry.modelProvider).toBe('openai-codex');
    }
  });

  it('preserves the gpt-5.5 default:true flag', () => {
    const spec = getProviderSpec('codex');
    const gpt55 = spec!.catalogModels!.find((m) => m.id === 'gpt-5.5');
    expect(gpt55?.default).toBe(true);
  });
});
