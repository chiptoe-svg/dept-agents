import { beforeEach, describe, expect, it } from 'bun:test';

import { getOutboundDb, initTestSessionDb } from './connection.js';
import { writeMessageOut } from './messages-out.js';

beforeEach(() => {
  initTestSessionDb();
});

describe('writeMessageOut — cost fields', () => {
  it('persists tokens_in, tokens_out, latency_ms, provider, model on agent-reply rows', () => {
    writeMessageOut({
      id: 'msg-test-1',
      kind: 'chat',
      platform_id: 'test-platform',
      channel_type: 'telegram',
      content: JSON.stringify({ text: 'hello' }),
      tokens_in: 1234,
      tokens_out: 567,
      latency_ms: 4200,
      provider: 'claude',
      model: 'claude-sonnet-4-5',
    });

    const row = getOutboundDb()
      .prepare('SELECT tokens_in, tokens_out, latency_ms, provider, model FROM messages_out WHERE id = ?')
      .get('msg-test-1') as {
      tokens_in: number | null;
      tokens_out: number | null;
      latency_ms: number | null;
      provider: string | null;
      model: string | null;
    } | undefined;

    expect(row).toBeDefined();
    expect(row!.tokens_in).toBe(1234);
    expect(row!.tokens_out).toBe(567);
    expect(row!.latency_ms).toBe(4200);
    expect(row!.provider).toBe('claude');
    expect(row!.model).toBe('claude-sonnet-4-5');
  });

  it('leaves cost fields null when not provided (non-agent-reply rows)', () => {
    writeMessageOut({
      id: 'msg-test-2',
      kind: 'chat',
      platform_id: 'test-platform',
      channel_type: 'telegram',
      content: JSON.stringify({ text: 'error message' }),
    });

    const row = getOutboundDb()
      .prepare('SELECT tokens_in, tokens_out, latency_ms, provider, model FROM messages_out WHERE id = ?')
      .get('msg-test-2') as {
      tokens_in: number | null;
      tokens_out: number | null;
      latency_ms: number | null;
      provider: string | null;
      model: string | null;
    } | undefined;

    expect(row).toBeDefined();
    expect(row!.tokens_in).toBeNull();
    expect(row!.tokens_out).toBeNull();
    expect(row!.latency_ms).toBeNull();
    expect(row!.provider).toBeNull();
    expect(row!.model).toBeNull();
  });
});
