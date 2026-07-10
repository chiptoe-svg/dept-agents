import { beforeEach, describe, expect, it } from 'vitest';
import {
  mintContainerToken,
  resolveContainerToken,
  revokeContainerToken,
  _resetForTest,
} from './container-identity.js';

beforeEach(() => _resetForTest());

describe('container identity registry', () => {
  it('resolves a minted token to its group and session', () => {
    const t = mintContainerToken('ag_alice', 'sess_1');
    expect(resolveContainerToken(t)).toEqual({ agentGroupId: 'ag_alice', sessionId: 'sess_1' });
  });

  it('returns null for an unknown, empty, or undefined token', () => {
    expect(resolveContainerToken('deadbeef')).toBeNull();
    expect(resolveContainerToken('')).toBeNull();
    expect(resolveContainerToken(undefined)).toBeNull();
  });

  it('returns null after revocation', () => {
    const t = mintContainerToken('ag_alice', 'sess_1');
    revokeContainerToken(t);
    expect(resolveContainerToken(t)).toBeNull();
  });

  it('mints unpredictable, distinct tokens', () => {
    const a = mintContainerToken('ag_alice', 'sess_1');
    const b = mintContainerToken('ag_alice', 'sess_1');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not let one group resolve another group token', () => {
    const alice = mintContainerToken('ag_alice', 'sess_1');
    const bob = mintContainerToken('ag_bob', 'sess_2');
    expect(resolveContainerToken(alice)!.agentGroupId).toBe('ag_alice');
    expect(resolveContainerToken(bob)!.agentGroupId).toBe('ag_bob');
  });
});
