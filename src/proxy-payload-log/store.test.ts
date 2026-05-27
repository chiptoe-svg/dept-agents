import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openStore, type PayloadStore } from './store.js';

describe('payload-store', () => {
  let tmpDir: string;
  let store: PayloadStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-store-'));
    store = openStore({ baseDir: tmpDir, agentGroupId: 'ag1', sessionId: 'sess1' });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a row and returns an incrementing seq', () => {
    const body = Buffer.from(JSON.stringify({ model: 'claude', messages: [] }));
    const seq1 = store.write({ ts: 1000, upstreamRoute: 'anthropic', upstreamPath: '/v1/messages', body });
    const seq2 = store.write({ ts: 1001, upstreamRoute: 'anthropic', upstreamPath: '/v1/messages', body });
    expect(seq1).toBe(1);
    expect(seq2).toBe(2);
  });

  it('reads back rows in seq order', () => {
    const body = Buffer.from('{"x":1}');
    store.write({ ts: 1000, upstreamRoute: 'anthropic', upstreamPath: '/v1/messages', body });
    store.write({ ts: 1001, upstreamRoute: 'openai', upstreamPath: '/v1/chat/completions', body });
    const rows = store.list({ limit: 10, afterSeq: 0 });
    expect(rows).toHaveLength(2);
    expect(rows[0].upstreamRoute).toBe('anthropic');
    expect(rows[1].upstreamRoute).toBe('openai');
  });

  it('creates the directory on first write', () => {
    const body = Buffer.from('{}');
    store.write({ ts: 1000, upstreamRoute: 'anthropic', upstreamPath: '/v1/messages', body });
    expect(fs.existsSync(path.join(tmpDir, 'ag1', 'sess1.db'))).toBe(true);
  });
});

describe('payload-store patch + retention + truncation', () => {
  let tmpDir: string;
  let store: PayloadStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-store-'));
    store = openStore({ baseDir: tmpDir, agentGroupId: 'ag1', sessionId: 'sess1' });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('patches response_status on a written row', () => {
    const seq = store.write({
      ts: 1,
      upstreamRoute: 'anthropic',
      upstreamPath: '/v1/messages',
      body: Buffer.from('{}'),
    });
    store.patch(seq, { responseStatus: 200 });
    const rows = store.list({ limit: 10, afterSeq: 0 });
    expect(rows[0].responseStatus).toBe(200);
  });

  it('patches sections_json on a written row', () => {
    const seq = store.write({
      ts: 1,
      upstreamRoute: 'anthropic',
      upstreamPath: '/v1/messages',
      body: Buffer.from('{}'),
    });
    store.patch(seq, { sectionsJson: '{"system":100}' });
    const rows = store.list({ limit: 10, afterSeq: 0 });
    expect(rows[0].sectionsJson).toBe('{"system":100}');
  });

  it('prunes to keep approximately the last 50 rows', () => {
    // Write 100 rows — guaranteed to hit at least one prune trigger (seq=50, seq=100).
    for (let i = 0; i < 100; i++) {
      store.write({ ts: i, upstreamRoute: 'anthropic', upstreamPath: '/v1/messages', body: Buffer.from(`${i}`) });
    }
    const rows = store.list({ limit: 200, afterSeq: 0 });
    // After prune at seq=100, rows where seq <= 100-50=50 are deleted, leaving seq 51..100 (50 rows).
    expect(rows).toHaveLength(50);
    expect(rows[0].ts).toBe(50); // seq 51 corresponds to i=50
    expect(rows[49].ts).toBe(99);
  });

  it('truncates bodies larger than 10MB and flags truncated=true', () => {
    const big = Buffer.alloc(11 * 1024 * 1024, 0x61);
    const seq = store.write({ ts: 1, upstreamRoute: 'anthropic', upstreamPath: '/v1/messages', body: big });
    const rows = store.list({ limit: 1, afterSeq: 0 });
    expect(rows[0].truncated).toBe(true);
    expect(rows[0].requestBody.length).toBe(10 * 1024 * 1024);
    expect(rows[0].requestBytes).toBe(11 * 1024 * 1024);
    expect(seq).toBe(1);
  });
});
