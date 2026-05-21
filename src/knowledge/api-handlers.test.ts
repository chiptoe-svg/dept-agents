import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  handleListCorpora,
  handleCreateCorpus,
  handleDeleteCorpus,
  handleUploadSource,
  handleIngest,
  handleGetCorpus,
  handleInspect,
  handleQuery,
} from './api-handlers.js';

vi.mock('../channels/playground/draft-read-gate.js', () => ({
  canReadDraft: vi.fn().mockResolvedValue(true),
  checkDraftMutation: vi.fn().mockResolvedValue(null),
}));

let tmpFolder: string;

beforeEach(() => {
  tmpFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'api-handlers-test-'));
});

afterEach(() => {
  fs.rmSync(tmpFolder, { recursive: true, force: true });
  vi.clearAllMocks();
});

function req() {
  return { headers: { 'x-playground-token': 'test-token' } };
}

describe('handleListCorpora', () => {
  it('returns empty list initially', async () => {
    const r = await handleListCorpora(tmpFolder, req());
    expect(r.status).toBe(200);
    expect((r.body as { corpora: unknown[] }).corpora).toEqual([]);
  });
});

describe('handleCreateCorpus', () => {
  it('creates corpus and returns meta', async () => {
    const r = await handleCreateCorpus(tmpFolder, { name: 'my corpus', sourceType: 'text' }, req());
    expect(r.status).toBe(201);
    const body = r.body as { id: string; name: string };
    expect(body.name).toBe('my corpus');
    expect(typeof body.id).toBe('string');
  });

  it('returns 400 if name missing', async () => {
    const r = await handleCreateCorpus(tmpFolder, {} as { name: string; sourceType: 'text' }, req());
    expect(r.status).toBe(400);
  });
});

describe('handleDeleteCorpus', () => {
  it('deletes existing corpus', async () => {
    const createRes = await handleCreateCorpus(tmpFolder, { name: 'del', sourceType: 'text' }, req());
    const { id } = createRes.body as { id: string };
    const r = await handleDeleteCorpus(tmpFolder, id, req());
    expect(r.status).toBe(204);
  });

  it('returns 404 for unknown id', async () => {
    const r = await handleDeleteCorpus(tmpFolder, 'noexist', req());
    expect(r.status).toBe(404);
  });
});

describe('handleGetCorpus', () => {
  it('returns meta for existing corpus', async () => {
    const createRes = await handleCreateCorpus(tmpFolder, { name: 'get', sourceType: 'text' }, req());
    const { id } = createRes.body as { id: string };
    const r = await handleGetCorpus(tmpFolder, id, req());
    expect(r.status).toBe(200);
    expect((r.body as { name: string }).name).toBe('get');
  });

  it('returns 404 for unknown id', async () => {
    const r = await handleGetCorpus(tmpFolder, 'nope', req());
    expect(r.status).toBe(404);
  });
});

describe('handleUploadSource', () => {
  it('saves file to raw/ dir', async () => {
    const createRes = await handleCreateCorpus(tmpFolder, { name: 'ul', sourceType: 'text' }, req());
    const { id } = createRes.body as { id: string };
    const r = await handleUploadSource(tmpFolder, id, 'hello.txt', Buffer.from('hello world'), req());
    expect(r.status).toBe(200);
  });

  it('returns 404 for unknown corpus', async () => {
    const r = await handleUploadSource(tmpFolder, 'nope', 'f.txt', Buffer.from('x'), req());
    expect(r.status).toBe(404);
  });
});

describe('handleIngest', () => {
  it('returns 202 and starts pipeline', async () => {
    const createRes = await handleCreateCorpus(tmpFolder, { name: 'ing', sourceType: 'text' }, req());
    const { id } = createRes.body as { id: string };
    fs.writeFileSync(
      path.join(tmpFolder, 'knowledge', 'corpora', id, 'raw', 'test.txt'),
      'The quick brown fox.'
    );
    const r = await handleIngest(tmpFolder, id, req());
    expect(r.status).toBe(202);
  });

  it('returns 404 for unknown corpus', async () => {
    const r = await handleIngest(tmpFolder, 'nope', req());
    expect(r.status).toBe(404);
  });
});

describe('handleInspect', () => {
  it('returns chunks and meta after ingest', async () => {
    const createRes = await handleCreateCorpus(tmpFolder, { name: 'ins', sourceType: 'text' }, req());
    const { id } = createRes.body as { id: string };
    fs.writeFileSync(
      path.join(tmpFolder, 'knowledge', 'corpora', id, 'raw', 'ins.txt'),
      'One sentence. Two sentences. Three sentences.'
    );
    const { runTextPipeline } = await import('./pipeline.js');
    await runTextPipeline(tmpFolder, id);

    const r = await handleInspect(tmpFolder, id, req());
    expect(r.status).toBe(200);
    const body = r.body as { chunks: unknown[]; meta: { status: string } };
    expect(body.chunks.length).toBeGreaterThan(0);
    expect(body.meta.status).toBe('ready');
  });
});

describe('handleQuery', () => {
  it('returns ranked results', async () => {
    const createRes = await handleCreateCorpus(tmpFolder, { name: 'q', sourceType: 'text' }, req());
    const { id } = createRes.body as { id: string };
    fs.writeFileSync(
      path.join(tmpFolder, 'knowledge', 'corpora', id, 'raw', 'q.txt'),
      'The quick brown fox. A lazy dog. The fox jumps over the dog.'
    );
    const { runTextPipeline } = await import('./pipeline.js');
    await runTextPipeline(tmpFolder, id);

    const r = await handleQuery(tmpFolder, id, 'fox', 5, req());
    expect(r.status).toBe(200);
    const body = r.body as { results: Array<{ score: number }> };
    expect(body.results.length).toBeGreaterThan(0);
  });

  it('returns 404 for unknown corpus', async () => {
    const r = await handleQuery(tmpFolder, 'nope', 'fox', 5, req());
    expect(r.status).toBe(404);
  });
});
