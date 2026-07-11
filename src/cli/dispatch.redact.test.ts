/**
 * Bearer-URL redaction in the cli_command approval handler (Plan 3
 * final-review Fix 3).
 *
 * `users provision` and `class-tokens issue|rotate` return the login URL —
 * a bearer credential. The approval handler relays the command result into
 * the requesting agent's session via notify(), i.e. into an LLM context and
 * the session DB. These tests pin that the agent-facing relay redacts the
 * URL/token while non-credential commands pass through untouched. The
 * host-caller path (./bin/ncl, caller:'host') never goes through this
 * handler — dispatch() returns the raw result to host stdout.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Session } from '../types.js';
import { getApprovalHandler } from '../modules/approvals/primitive.js';
import { register } from './registry.js';
import { redactBearerResult } from './dispatch.js';

const FAKE_URL = 'http://example.test:8088/?token=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

describe('redactBearerResult (pure)', () => {
  it('redacts loginUrl from users-provision results', () => {
    const out = redactBearerResult('users-provision', {
      ok: true,
      userId: 'playground:dana',
      agentGroupId: 'ag-1',
      loginUrl: FAKE_URL,
    }) as Record<string, unknown>;
    expect(out.loginUrl).not.toContain('token=');
    expect(String(out.loginUrl)).toContain('redacted');
    // Non-credential fields survive so the agent still gets a useful result.
    expect(out.userId).toBe('playground:dana');
    expect(out.agentGroupId).toBe('ag-1');
  });

  it('redacts url from class-tokens issue and rotate results', () => {
    for (const command of ['class-tokens-issue', 'class-tokens-rotate']) {
      const out = redactBearerResult(command, {
        ok: true,
        email: 'dana@example.test',
        user_id: 'playground:dana',
        url: FAKE_URL,
      }) as Record<string, unknown>;
      expect(out.url).not.toContain('token=');
      expect(out.user_id).toBe('playground:dana');
    }
  });

  it('leaves non-credential commands untouched', () => {
    const data = { ok: true, url: 'http://example.test/docs' };
    expect(redactBearerResult('groups-list', data)).toBe(data);
    // class-tokens-revoke returns no URL and is intentionally not in the set.
    const revoke = { ok: true, user_id: 'playground:dana', revoked: 2 };
    expect(redactBearerResult('class-tokens-revoke', revoke)).toBe(revoke);
  });

  it('tolerates non-object results', () => {
    expect(redactBearerResult('users-provision', 'plain string')).toBe('plain string');
    expect(redactBearerResult('users-provision', null)).toBeNull();
  });
});

describe('cli_command approval handler relay', () => {
  function fakeSession(): Session {
    return { id: 'sess-1', agent_group_id: 'ag-1', messaging_group_id: null } as unknown as Session;
  }

  it('does not relay the login URL into the agent notify message', async () => {
    register({
      name: 'users-provision',
      description: 'stub',
      access: 'approval',
      parseArgs: (raw) => raw,
      handler: async () => ({ ok: true, userId: 'playground:dana', agentGroupId: 'ag-1', loginUrl: FAKE_URL }),
    });

    const handler = getApprovalHandler('cli_command');
    expect(handler).toBeTruthy();
    const notify = vi.fn();
    await handler!({
      session: fakeSession(),
      payload: { frame: { id: 'r1', command: 'users-provision', args: {} } },
      userId: 'telegram:admin',
      notify,
    });

    expect(notify).toHaveBeenCalledTimes(1);
    const text = notify.mock.calls[0]![0] as string;
    expect(text).toContain('approved and executed');
    expect(text).not.toContain(FAKE_URL);
    expect(text).not.toContain('token=');
    expect(text).toContain('redacted');
    // The agent still learns the provisioning outcome.
    expect(text).toContain('playground:dana');
  });

  it('relays non-credential command results in full', async () => {
    register({
      name: 'stub-echo',
      description: 'stub',
      access: 'approval',
      parseArgs: (raw) => raw,
      handler: async () => ({ ok: true, detail: 'harmless result' }),
    });

    const handler = getApprovalHandler('cli_command');
    const notify = vi.fn();
    await handler!({
      session: fakeSession(),
      payload: { frame: { id: 'r2', command: 'stub-echo', args: {} } },
      userId: 'telegram:admin',
      notify,
    });

    const text = notify.mock.calls[0]![0] as string;
    expect(text).toContain('harmless result');
    expect(text).not.toContain('redacted');
  });
});
