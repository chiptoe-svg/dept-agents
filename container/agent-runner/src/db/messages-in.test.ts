/**
 * Regression test: reads from inbound.db (getMessageIn, getPendingMessages,
 * findQuestionResponse) must retry through the same transient
 * SQLITE_READONLY_ROLLBACK window that `withReadonlyRetry` already guards
 * for outbound.db writes. See connection-inbound-retry.test.ts for the
 * retry-primitive unit tests; this file proves the call sites in
 * messages-in.ts actually route through it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { initTestSessionDb } from './connection.js';
import { getMessageIn } from './messages-in.js';

beforeEach(() => {
  initTestSessionDb();
});

// The monkeypatched `.prepare` below mutates the shared `_inbound` singleton
// in connection.ts — bun:test runs files in a shared process, so an
// un-restored patch can leak into unrelated test files' background pollers.
// Always restore the real method before the test ends, not just on the
// happy path.
let restorePrepare: (() => void) | undefined;
afterEach(() => {
  restorePrepare?.();
  restorePrepare = undefined;
});

describe('getMessageIn — inbound read retry', () => {
  it('retries a transient readonly error and returns the row instead of throwing', () => {
    const { inbound } = initTestSessionDb();
    inbound
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, ?, ?, 'pending', ?)`,
      )
      .run('m1', 1, 'chat', new Date().toISOString(), '{}');

    const realPrepare = inbound.prepare.bind(inbound);
    let calls = 0;
    const patched = (inbound as unknown as { prepare: typeof inbound.prepare }).prepare = ((sql: string) => {
      calls++;
      if (calls === 1) {
        throw new Error('SQLITE_READONLY_ROLLBACK: attempt to write a readonly database');
      }
      return realPrepare(sql);
    }) as typeof inbound.prepare;
    restorePrepare = () => {
      if ((inbound as unknown as { prepare: typeof inbound.prepare }).prepare === patched) {
        (inbound as unknown as { prepare: typeof inbound.prepare }).prepare = realPrepare;
      }
    };

    const row = getMessageIn('m1');

    expect(row?.id).toBe('m1');
    expect(calls).toBeGreaterThan(1);
  });

  it('a non-readonly error is not retried — surfaces immediately, not masked', () => {
    const { inbound } = initTestSessionDb();
    const realPrepare = inbound.prepare.bind(inbound);
    let calls = 0;
    const patched = (inbound as unknown as { prepare: typeof inbound.prepare }).prepare = (() => {
      calls++;
      throw new Error('no such table: messages_in');
    }) as typeof inbound.prepare;
    restorePrepare = () => {
      if ((inbound as unknown as { prepare: typeof inbound.prepare }).prepare === patched) {
        (inbound as unknown as { prepare: typeof inbound.prepare }).prepare = realPrepare;
      }
    };

    expect(() => getMessageIn('missing')).toThrow('no such table');
    expect(calls).toBe(1);
  });
});
