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
import { updateStatus } from './corpus.js';
import type { CorpusMeta } from './types.js';

vi.mock('./stages/embed.js', () => ({
  embedChunks: vi.fn().mockResolvedValue(new Map([['__query__', new Float32Array([1, 0, 0, 0])]])),
}));

let tmpFolder: string;

beforeEach(() => {
  tmpFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'api-handlers-test-'));
});

afterEach(() => {
  fs.rmSync(tmpFolder, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('handleListCorpora', () => {
  it('returns empty list initially', async () => {
    const r = await handleListCorpora(tmpFolder);
    expect(r.status).toBe(200);
    expect((r.body as { corpora: unknown[] }).corpora).toEqual([]);
  });
});

describe('handleCreateCorpus', () => {
  it('creates corpus and returns meta', async () => {
    const r = await handleCreateCorpus(tmpFolder, { name: 'my corpus', sourceType: 'text' });
    expect(r.status).toBe(201);
    const body = r.body as { id: string; name: string };
    expect(body.name).toBe('my corpus');
    expect(typeof body.id).toBe('string');
  });

  it('returns 400 if name missing', async () => {
    const r = await handleCreateCorpus(tmpFolder, {} as { name: string; sourceType: 'text' });
    expect(r.status).toBe(400);
  });
});

describe('handleDeleteCorpus', () => {
  it('deletes existing corpus', async () => {
    const createRes = await handleCreateCorpus(tmpFolder, { name: 'del', sourceType: 'text' });
    const { id } = createRes.body as { id: string };
    const r = await handleDeleteCorpus(tmpFolder, id);
    expect(r.status).toBe(204);
  });

  it('returns 404 for unknown id', async () => {
    const r = await handleDeleteCorpus(tmpFolder, 'noexist');
    expect(r.status).toBe(404);
  });
});

describe('handleGetCorpus', () => {
  it('returns meta for existing corpus', async () => {
    const createRes = await handleCreateCorpus(tmpFolder, { name: 'get', sourceType: 'text' });
    const { id } = createRes.body as { id: string };
    const r = await handleGetCorpus(tmpFolder, id);
    expect(r.status).toBe(200);
    expect((r.body as { name: string }).name).toBe('get');
  });

  it('returns 404 for unknown id', async () => {
    const r = await handleGetCorpus(tmpFolder, 'nope');
    expect(r.status).toBe(404);
  });
});

describe('handleUploadSource', () => {
  it('saves file to raw/ dir', async () => {
    const createRes = await handleCreateCorpus(tmpFolder, { name: 'ul', sourceType: 'text' });
    const { id } = createRes.body as { id: string };
    const r = await handleUploadSource(tmpFolder, id, 'hello.txt', Buffer.from('hello world'));
    expect(r.status).toBe(200);
  });

  it('returns 404 for unknown corpus', async () => {
    const r = await handleUploadSource(tmpFolder, 'nope', 'f.txt', Buffer.from('x'));
    expect(r.status).toBe(404);
  });
});

describe('handleIngest', () => {
  it('returns 202 and starts pipeline', async () => {
    const createRes = await handleCreateCorpus(tmpFolder, { name: 'ing', sourceType: 'text' });
    const { id } = createRes.body as { id: string };
    fs.writeFileSync(path.join(tmpFolder, 'knowledge', 'corpora', id, 'raw', 'test.txt'), 'The quick brown fox.');
    const r = await handleIngest(tmpFolder, id);
    expect(r.status).toBe(202);
  });

  it('returns 404 for unknown corpus', async () => {
    const r = await handleIngest(tmpFolder, 'nope');
    expect(r.status).toBe(404);
  });
});

describe('handleInspect', () => {
  it('returns chunks and meta after ingest', async () => {
    const createRes = await handleCreateCorpus(tmpFolder, { name: 'ins', sourceType: 'text' });
    const { id } = createRes.body as { id: string };
    fs.writeFileSync(
      path.join(tmpFolder, 'knowledge', 'corpora', id, 'raw', 'ins.txt'),
      'One sentence. Two sentences. Three sentences.',
    );
    const { runTextPipeline } = await import('./pipeline.js');
    await runTextPipeline(tmpFolder, id);

    const r = await handleInspect(tmpFolder, id);
    expect(r.status).toBe(200);
    const body = r.body as { chunks: unknown[]; meta: { status: string } };
    expect(body.chunks.length).toBeGreaterThan(0);
    expect(body.meta.status).toBe('ready');
  });
});

describe('handleQuery', () => {
  it('returns ranked results', async () => {
    const createRes = await handleCreateCorpus(tmpFolder, { name: 'q', sourceType: 'text' });
    const { id } = createRes.body as { id: string };
    fs.writeFileSync(
      path.join(tmpFolder, 'knowledge', 'corpora', id, 'raw', 'q.txt'),
      'The quick brown fox. A lazy dog. The fox jumps over the dog.',
    );
    const { runTextPipeline } = await import('./pipeline.js');
    await runTextPipeline(tmpFolder, id);

    const r = await handleQuery(tmpFolder, id, 'fox', 5);
    expect(r.status).toBe(200);
    const body = r.body as { results: Array<{ score: number }> };
    expect(body.results.length).toBeGreaterThan(0);
  });

  it('returns 404 for unknown corpus', async () => {
    const r = await handleQuery(tmpFolder, 'nope', 'fox', 5);
    expect(r.status).toBe(404);
  });
});

describe('handleCreateCorpus — storeStrategy', () => {
  it('defaults storeStrategy to bm25', async () => {
    const result = await handleCreateCorpus(tmpFolder, { name: 'test' });
    expect(result.status).toBe(201);
    expect((result.body as CorpusMeta).storeStrategy).toBe('bm25');
  });

  it('accepts storeStrategy dense', async () => {
    const result = await handleCreateCorpus(tmpFolder, { name: 'dense-test', storeStrategy: 'dense' });
    expect(result.status).toBe(201);
    expect((result.body as CorpusMeta).storeStrategy).toBe('dense');
  });

  it('accepts storeStrategy hybrid', async () => {
    const result = await handleCreateCorpus(tmpFolder, { name: 'hybrid-test', storeStrategy: 'hybrid' });
    expect(result.status).toBe(201);
    expect((result.body as CorpusMeta).storeStrategy).toBe('hybrid');
  });
});

describe('handleQuery — dense strategy', () => {
  it('calls embedChunks for query and returns results array', async () => {
    const { embedChunks } = await import('./stages/embed.js');
    const createResult = await handleCreateCorpus(tmpFolder, { name: 'd', storeStrategy: 'dense' });
    const meta = createResult.body as CorpusMeta;
    updateStatus(tmpFolder, meta.id, 'ready');

    const result = await handleQuery(tmpFolder, meta.id, 'hello', 5);
    expect(result.status).toBe(200);
    expect(embedChunks).toHaveBeenCalled();
    expect((result.body as { results: unknown[] }).results).toBeInstanceOf(Array);
  });
});
