import { describe, expect, it } from 'bun:test';

import type { ProviderEvent } from './types.js';

describe('ProviderEvent result extensions', () => {
  it('result variant carries optional tokens, latencyMs, provider, model', () => {
    // Type-level smoke: verify the shape accepts all new fields.
    const event: ProviderEvent = {
      type: 'result',
      text: 'hi',
      tokens: { input: 123, output: 45 },
      latencyMs: 1234,
      provider: 'claude',
      model: 'claude-haiku-4-5',
    };
    expect(event.type).toBe('result');
    if (event.type === 'result') {
      expect(event.tokens).toEqual({ input: 123, output: 45 });
      expect(event.latencyMs).toBe(1234);
      expect(event.provider).toBe('claude');
      expect(event.model).toBe('claude-haiku-4-5');
    }
  });

  it('result variant works with all new fields omitted (back-compat)', () => {
    const event: ProviderEvent = {
      type: 'result',
      text: 'hi',
    };
    expect(event.type).toBe('result');
    if (event.type === 'result') {
      expect(event.tokens).toBeUndefined();
      expect(event.latencyMs).toBeUndefined();
      expect(event.provider).toBeUndefined();
      expect(event.model).toBeUndefined();
    }
  });

  it('result variant works with null text and partial fields', () => {
    const event: ProviderEvent = {
      type: 'result',
      text: null,
      latencyMs: 500,
      provider: 'claude',
    };
    expect(event.type).toBe('result');
    if (event.type === 'result') {
      expect(event.text).toBeNull();
      expect(event.tokens).toBeUndefined();
      expect(event.latencyMs).toBe(500);
      expect(event.provider).toBe('claude');
      expect(event.model).toBeUndefined();
    }
  });
});
