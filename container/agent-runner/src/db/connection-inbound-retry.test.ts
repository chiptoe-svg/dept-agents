/**
 * Regression test for the inbound-read readonly-retry gap: `withReadonlyRetry`
 * only guards outbound.db *writes*. Reads from inbound.db can also hit a
 * transient SQLITE_READONLY_ROLLBACK — the host's DELETE-journal commits
 * leave a hot rollback journal next to inbound.db for a brief moment, and
 * virtiofs does not propagate SQLite's advisory locks from host to guest —
 * and without a retry that surfaces as noisy, non-fatal poll-loop errors
 * that can mask a real failure underneath.
 */
import { describe, expect, it } from 'bun:test';

import { withInboundReadonlyRetry } from './connection.js';

describe('withInboundReadonlyRetry', () => {
  it('retries a transient SQLITE_READONLY_ROLLBACK and returns the eventual result', () => {
    let calls = 0;
    const result = withInboundReadonlyRetry(() => {
      calls++;
      if (calls < 3) {
        throw new Error('SQLITE_READONLY_ROLLBACK: attempt to write a readonly database');
      }
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('does not retry a non-readonly error — rethrows immediately', () => {
    let calls = 0;
    expect(() =>
      withInboundReadonlyRetry(() => {
        calls++;
        throw new Error('no such table: messages_in');
      }),
    ).toThrow('no such table: messages_in');
    expect(calls).toBe(1);
  });
});
