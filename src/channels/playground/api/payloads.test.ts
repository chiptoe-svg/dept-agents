import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { handleGetSessionPayloads } from './payloads.js';
import { openStore } from '../../../proxy-payload-log/store.js';

describe('handleGetSessionPayloads', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'payloads-api-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns 404 when the session db does not exist', async () => {
    const res = await handleGetSessionPayloads({
      baseDir: tmpDir,
      agentGroupId: 'ag1',
      sessionId: 'missing',
      limit: 10,
      afterSeq: 0,
      canAccess: () => true,
    });
    expect(res.status).toBe(404);
  });

  it('returns 401 when access is denied', async () => {
    const res = await handleGetSessionPayloads({
      baseDir: tmpDir,
      agentGroupId: 'ag1',
      sessionId: 'sess1',
      limit: 10,
      afterSeq: 0,
      canAccess: () => false,
    });
    expect(res.status).toBe(401);
  });

  it('returns rows + parsed sections for an existing session', async () => {
    const store = openStore({ baseDir: tmpDir, agentGroupId: 'ag1', sessionId: 'sess1' });
    const body = Buffer.from(
      JSON.stringify({ model: 'claude', system: 'be helpful', messages: [{ role: 'user', content: 'hi' }] }),
    );
    const seq = store.write({ ts: 1000, upstreamRoute: 'anthropic', upstreamPath: '/v1/messages', body });
    store.patch(seq, { responseStatus: 200 });
    store.close();

    const res = await handleGetSessionPayloads({
      baseDir: tmpDir,
      agentGroupId: 'ag1',
      sessionId: 'sess1',
      limit: 10,
      afterSeq: 0,
      canAccess: () => true,
    });
    expect(res.status).toBe(200);
    const body200 = res.body as {
      rows: Array<{ sections: { system: number; messages: unknown[] }; responseStatus: number | null }>;
    };
    expect(body200.rows).toHaveLength(1);
    expect(body200.rows[0].sections.system).toBeGreaterThan(0);
    expect(body200.rows[0].sections.messages).toHaveLength(1);
    expect(body200.rows[0].responseStatus).toBe(200);
  });

  it('caches sections_json back to the row after first parse', async () => {
    const store = openStore({ baseDir: tmpDir, agentGroupId: 'ag1', sessionId: 'sess1' });
    const body = Buffer.from(JSON.stringify({ model: 'claude', messages: [] }));
    store.write({ ts: 1, upstreamRoute: 'anthropic', upstreamPath: '/v1/messages', body });
    store.close();

    await handleGetSessionPayloads({
      baseDir: tmpDir,
      agentGroupId: 'ag1',
      sessionId: 'sess1',
      limit: 10,
      afterSeq: 0,
      canAccess: () => true,
    });

    const Database = (await import('better-sqlite3')).default;
    const db = new Database(path.join(tmpDir, 'ag1', 'sess1.db'), { readonly: true });
    const row = db.prepare('SELECT sections_json FROM payloads').get() as { sections_json: string | null };
    db.close();
    expect(row.sections_json).not.toBeNull();
    expect(JSON.parse(row.sections_json as string)).toHaveProperty('totalBytes');
  });
});
