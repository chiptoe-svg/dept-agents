import { beforeEach, describe, expect, it } from 'bun:test';

import { getOutboundDb, initTestSessionDb } from './connection.js';
import { backfillUsage, readMaxOutboundSeq, writeMessageOut } from './messages-out.js';

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

describe('backfillUsage (seq-bounded)', () => {
  it('populates NULL usage on chat rows written after sinceSeq', () => {
    // Pre-turn row that should NOT be touched (written before the turn boundary).
    writeMessageOut({
      id: 'msg-test-bf-pre',
      kind: 'chat',
      platform_id: 'test-platform',
      channel_type: 'telegram',
      content: JSON.stringify({ text: 'old message' }),
    });

    const sinceSeq = readMaxOutboundSeq();

    // Mid-turn row written by an MCP tool — no usage, NULL in_reply_to (matches
    // production behavior since MCP server runs in a separate process).
    writeMessageOut({
      id: 'msg-test-bf-tool',
      kind: 'chat',
      platform_id: 'test-platform',
      channel_type: 'telegram',
      content: JSON.stringify({ text: 'hello from tool' }),
    });

    backfillUsage(sinceSeq, {
      tokens_in: 100,
      tokens_out: 50,
      provider: 'openai-codex',
      model: 'gpt-5.4-mini',
    });

    const after = getOutboundDb()
      .prepare('SELECT tokens_in, tokens_out, provider, model FROM messages_out WHERE id = ?')
      .get('msg-test-bf-tool') as { tokens_in: number | null; tokens_out: number | null; provider: string | null; model: string | null } | undefined;
    expect(after!.tokens_in).toBe(100);
    expect(after!.tokens_out).toBe(50);
    expect(after!.provider).toBe('openai-codex');
    expect(after!.model).toBe('gpt-5.4-mini');

    // Pre-turn row must stay untouched
    const pre = getOutboundDb()
      .prepare('SELECT tokens_in, tokens_out, provider, model FROM messages_out WHERE id = ?')
      .get('msg-test-bf-pre') as { tokens_in: number | null; tokens_out: number | null; provider: string | null; model: string | null } | undefined;
    expect(pre!.tokens_in).toBeNull();
    expect(pre!.provider).toBeNull();
  });

  it('does not overwrite rows already populated by dispatchResultText', () => {
    const sinceSeq = readMaxOutboundSeq();

    // dispatchResultText path: writes the row WITH usage already populated
    writeMessageOut({
      id: 'msg-test-bf-direct',
      kind: 'chat',
      platform_id: 'test-platform',
      channel_type: 'telegram',
      content: JSON.stringify({ text: 'direct reply' }),
      tokens_in: 999,
      tokens_out: 88,
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    backfillUsage(sinceSeq, {
      tokens_in: 1,
      tokens_out: 1,
      provider: 'openai-codex',
      model: 'gpt-5.4-mini',
    });

    const row = getOutboundDb()
      .prepare('SELECT tokens_in, tokens_out, provider, model FROM messages_out WHERE id = ?')
      .get('msg-test-bf-direct') as { tokens_in: number | null; tokens_out: number | null; provider: string | null; model: string | null } | undefined;
    expect(row!.tokens_in).toBe(999);
    expect(row!.tokens_out).toBe(88);
    expect(row!.provider).toBe('anthropic');
    expect(row!.model).toBe('claude-sonnet-4-5');
  });

  it('does not touch non-chat rows (e.g. trace events)', () => {
    const sinceSeq = readMaxOutboundSeq();

    writeMessageOut({
      id: 'msg-test-bf-trace',
      kind: 'trace',
      content: JSON.stringify({ type: 'pi_event' }),
    });

    backfillUsage(sinceSeq, {
      tokens_in: 100,
      tokens_out: 50,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
    });

    const row = getOutboundDb()
      .prepare('SELECT tokens_in, tokens_out, provider, model FROM messages_out WHERE id = ?')
      .get('msg-test-bf-trace') as { tokens_in: number | null; tokens_out: number | null; provider: string | null; model: string | null } | undefined;
    expect(row!.tokens_in).toBeNull();
    expect(row!.provider).toBeNull();
  });
});
