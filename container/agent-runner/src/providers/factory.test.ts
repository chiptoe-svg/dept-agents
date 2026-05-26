import { describe, it, expect } from 'bun:test';

import { createProvider, type ProviderName } from './factory.js';
import { MockProvider } from './mock.js';

describe('createProvider', () => {
  it('returns MockProvider for mock', () => {
    expect(createProvider('mock')).toBeInstanceOf(MockProvider);
  });

  it('throws for unknown name', () => {
    expect(() => createProvider('bogus' as ProviderName)).toThrow(/Unknown provider/);
  });
});
