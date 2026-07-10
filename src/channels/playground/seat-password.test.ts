import { describe, expect, it } from 'vitest';

import { seatPasswordMatches } from './server.js';

describe('seatPasswordMatches', () => {
  it('accepts the correct password', () => {
    expect(seatPasswordMatches('test-password-123', 'test-password-123')).toBe(true);
  });

  it('rejects a wrong password of the same length', () => {
    expect(seatPasswordMatches('test-password-124', 'test-password-123')).toBe(false);
  });

  it('rejects a wrong-length password without throwing', () => {
    expect(() => seatPasswordMatches('short', 'test-password-123')).not.toThrow();
    expect(seatPasswordMatches('short', 'test-password-123')).toBe(false);
  });
});
