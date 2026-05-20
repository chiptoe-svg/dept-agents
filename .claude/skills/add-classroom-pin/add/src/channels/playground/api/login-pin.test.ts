import { afterEach, describe, expect, it, vi } from 'vitest';

describe('login-pin API', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('handleIssue returns ok for known token, calls sender', async () => {
    const sent: Array<{ email: string; pin: string }> = [];
    vi.doMock('../../../class-login-pins.js', () => ({
      issuePin: () => ({ ok: true, pendingId: 'pending-1', pin: '654321' }),
      verifyPin: () => ({ ok: true, userId: 'class:alice' }),
      getPending: () => ({ email: 'a@b', userId: 'class:alice', token: 't' }),
    }));
    const { handleIssue, registerTokenLookup, registerPinSender } = await import('./login-pin.js');
    registerTokenLookup(() => ({ userId: 'class:alice', email: 'alice@school.edu' }));
    registerPinSender(async (email, pin) => {
      sent.push({ email, pin });
    });
    const result = await handleIssue({ token: 'tok-1' });
    expect(result.status).toBe(200);
    // Wait for fire-and-forget sender to flush.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent).toEqual([{ email: 'alice@school.edu', pin: '654321' }]);
  });

  it('handleIssue returns 200 (anti-enumeration) for unknown token without sending', async () => {
    const sent: Array<{ email: string; pin: string }> = [];
    vi.doMock('../../../class-login-pins.js', () => ({
      issuePin: () => ({ ok: false, reason: 'unknown-token' }),
      verifyPin: () => ({ ok: false, reason: 'unknown-pending' }),
      getPending: () => null,
    }));
    const { handleIssue, registerTokenLookup, registerPinSender } = await import('./login-pin.js');
    registerTokenLookup(() => null); // unknown
    registerPinSender(async (email, pin) => {
      sent.push({ email, pin });
    });
    const result = await handleIssue({ token: 'fake' });
    // Anti-enumeration: same response shape as success.
    expect(result.status).toBe(200);
    expect(sent).toEqual([]);
  });

  it('handleIssue rejects missing token', async () => {
    vi.doMock('../../../class-login-pins.js', () => ({
      issuePin: () => ({ ok: true, pendingId: '', pin: '' }),
      verifyPin: () => ({ ok: true, userId: '' }),
      getPending: () => null,
    }));
    const { handleIssue } = await import('./login-pin.js');
    const result = await handleIssue({});
    expect(result.status).toBe(400);
  });

  it('handleVerify on success returns 200 + setCookie + redirect', async () => {
    vi.doMock('../../../class-login-pins.js', () => ({
      issuePin: () => ({ ok: true, pendingId: '', pin: '' }),
      verifyPin: () => ({ ok: true, userId: 'class:bob' }),
      getPending: () => null,
    }));
    vi.doMock('../auth-store.js', () => ({
      mintSessionForUser: () => ({ cookieValue: 'cookie-bob' }),
      formatSessionCookie: (v: string) => `playground_session=${v}; HttpOnly`,
    }));
    const { handleVerify } = await import('./login-pin.js');
    const result = handleVerify({ pendingId: 'p1', pin: '123456' });
    expect(result.status).toBe(200);
    expect(result.setCookie).toContain('playground_session=cookie-bob');
    expect(result.body).toEqual({ ok: true, redirect: '/playground/' });
  });

  it('handleVerify rate-limited returns 429', async () => {
    vi.doMock('../../../class-login-pins.js', () => ({
      issuePin: () => ({ ok: true, pendingId: '', pin: '' }),
      verifyPin: () => ({ ok: false, reason: 'rate-limited' }),
      getPending: () => null,
    }));
    vi.doMock('../auth-store.js', () => ({
      mintSessionForUser: () => ({ cookieValue: '' }),
      formatSessionCookie: () => '',
    }));
    const { handleVerify } = await import('./login-pin.js');
    const result = handleVerify({ pendingId: 'p1', pin: '123456' });
    expect(result.status).toBe(429);
  });

  it('handleVerify rejects malformed PIN', async () => {
    vi.doMock('../../../class-login-pins.js', () => ({
      issuePin: () => ({ ok: true, pendingId: '', pin: '' }),
      verifyPin: () => ({ ok: false, reason: 'wrong-pin' }),
      getPending: () => null,
    }));
    vi.doMock('../auth-store.js', () => ({
      mintSessionForUser: () => ({ cookieValue: '' }),
      formatSessionCookie: () => '',
    }));
    const { handleVerify } = await import('./login-pin.js');
    expect((await handleVerify({ pendingId: 'p1', pin: 'abc' })).status).toBe(400);
    expect((await handleVerify({ pendingId: 'p1', pin: '12345' })).status).toBe(400); // too short
    expect((await handleVerify({ pendingId: 'p1' })).status).toBe(400); // missing
  });
});
