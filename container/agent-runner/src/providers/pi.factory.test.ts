import { describe, expect, it } from 'bun:test';

import { createProvider } from './factory.js';
import { PiProvider } from './pi.js';

describe('createProvider (pi)', () => {
  it('returns PiProvider for pi', () => {
    expect(createProvider('pi')).toBeInstanceOf(PiProvider);
  });
});
