/**
 * Tests for aggregateAgentUsage in usage.ts.
 *
 * Focuses on the legacy-provider remap: rows stored in outbound.db with
 * provider='claude' or provider='codex' must still produce non-zero cost
 * via the LEGACY_PROVIDER_REMAP translation to 'anthropic'/'openai-codex'.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpDir: string;

/** Create a minimal outbound.db with a single messages_out row. */
function makeOutboundDb(
  dbPath: string,
  row: {
    timestamp: string;
    tokens_in: number;
    tokens_out: number;
    provider: string;
    model: string;
    content?: string;
  },
): void {
  const db = new Database(dbPath);
  db.prepare(
    `CREATE TABLE messages_out (
       id TEXT PRIMARY KEY,
       timestamp TEXT,
       tokens_in INTEGER,
       tokens_out INTEGER,
       provider TEXT,
       model TEXT,
       content TEXT
     )`,
  ).run();
  db.prepare(
    'INSERT INTO messages_out (id, timestamp, tokens_in, tokens_out, provider, model, content) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run('m-1', row.timestamp, row.tokens_in, row.tokens_out, row.provider, row.model, row.content ?? null);
  db.close();
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-usage-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

describe('aggregateAgentUsage — legacy provider remap', () => {
  it('a row with legacy provider "claude" still gets a non-zero price via remap to "anthropic"', async () => {
    const agentGroupId = 'ag-test';
    const sessionId = 'sess-001';
    const sessionDir = path.join(tmpDir, agentGroupId, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    // Create an outbound.db with a legacy 'claude' provider row
    makeOutboundDb(path.join(sessionDir, 'outbound.db'), {
      timestamp: new Date().toISOString(),
      tokens_in: 1000,
      tokens_out: 500,
      provider: 'claude',
      model: 'claude-sonnet-4-5',
    });

    vi.doMock('../../../session-manager.js', () => ({
      sessionsBaseDir: () => tmpDir,
    }));
    vi.doMock('../../../model-catalog.js', () => ({
      getModelCatalog: () => [
        {
          id: 'claude-sonnet-4-5',
          modelProvider: 'anthropic',
          displayName: 'Claude Sonnet 4.5',
          origin: 'cloud',
          costPer1kInUsd: 0.003,
          costPer1kOutUsd: 0.015,
        },
      ],
    }));

    const { aggregateAgentUsage } = await import('./usage.js');
    const result = aggregateAgentUsage(agentGroupId);

    expect(result.total.costUsd).toBeGreaterThan(0);
    expect(result.total.byModel).toHaveLength(1);
    expect(result.total.byModel[0]!.provider).toBe('anthropic');
    expect(result.total.byModel[0]!.costUsd).toBeGreaterThan(0);
  });

  it('a row with legacy provider "codex" still gets a non-zero price via remap to "openai-codex"', async () => {
    const agentGroupId = 'ag-test2';
    const sessionId = 'sess-002';
    const sessionDir = path.join(tmpDir, agentGroupId, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    makeOutboundDb(path.join(sessionDir, 'outbound.db'), {
      timestamp: new Date().toISOString(),
      tokens_in: 2000,
      tokens_out: 800,
      provider: 'codex',
      model: 'gpt-5-mini',
    });

    vi.doMock('../../../session-manager.js', () => ({
      sessionsBaseDir: () => tmpDir,
    }));
    vi.doMock('../../../model-catalog.js', () => ({
      getModelCatalog: () => [
        {
          id: 'gpt-5-mini',
          modelProvider: 'openai-codex',
          displayName: 'GPT-5 Mini',
          origin: 'cloud',
          costPer1kInUsd: 0.0006,
          costPer1kOutUsd: 0.0024,
        },
      ],
    }));

    const { aggregateAgentUsage } = await import('./usage.js');
    const result = aggregateAgentUsage(agentGroupId);

    expect(result.total.costUsd).toBeGreaterThan(0);
    expect(result.total.byModel).toHaveLength(1);
    expect(result.total.byModel[0]!.provider).toBe('openai-codex');
    expect(result.total.byModel[0]!.costUsd).toBeGreaterThan(0);
  });
});
