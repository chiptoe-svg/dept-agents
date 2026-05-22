import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  handleListBenchmarks,
  handleCreateBenchmark,
  handleGetBenchmark,
  handleUpdateBenchmark,
  handleDeleteBenchmark,
  handleRunBenchmark,
} from './api-handlers.js';
import { createCorpus } from '../corpus.js';
import type { BenchmarkMeta } from './types.js';

vi.mock('./runner.js', () => ({
  runBenchmark: vi.fn().mockResolvedValue({
    benchmarkId: 'b1',
    corpusId: 'c1',
    k: 5,
    runAt: new Date().toISOString(),
    queriesRun: [],
    summary: { total: 0, scored: 0, strategies: {} },
  }),
}));

let tmpFolder: string;

beforeEach(() => {
  tmpFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-api-'));
});

afterEach(() => {
  fs.rmSync(tmpFolder, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('handleCreateBenchmark', () => {
  it('creates a benchmark and returns 201', async () => {
    const corpus = createCorpus(tmpFolder, { name: 'c', sourceType: 'text' });
    const r = await handleCreateBenchmark(tmpFolder, { name: 'bench', corpusId: corpus.id });
    expect(r.status).toBe(201);
    expect((r.body as BenchmarkMeta).name).toBe('bench');
  });

  it('returns 400 if name missing', async () => {
    const r = await handleCreateBenchmark(tmpFolder, {} as { name: string; corpusId: string });
    expect(r.status).toBe(400);
  });

  it('returns 400 if corpusId missing', async () => {
    const r = await handleCreateBenchmark(tmpFolder, { name: 'b' } as { name: string; corpusId: string });
    expect(r.status).toBe(400);
  });
});

describe('handleListBenchmarks', () => {
  it('returns empty list initially', async () => {
    const r = await handleListBenchmarks(tmpFolder);
    expect(r.status).toBe(200);
    expect((r.body as { benchmarks: unknown[] }).benchmarks).toEqual([]);
  });
});

describe('handleGetBenchmark', () => {
  it('returns meta for existing benchmark', async () => {
    const corpus = createCorpus(tmpFolder, { name: 'c', sourceType: 'text' });
    const create = await handleCreateBenchmark(tmpFolder, { name: 'b', corpusId: corpus.id });
    const { id } = create.body as BenchmarkMeta;
    const r = await handleGetBenchmark(tmpFolder, id);
    expect(r.status).toBe(200);
    expect((r.body as BenchmarkMeta).id).toBe(id);
  });

  it('returns 404 for unknown id', async () => {
    const r = await handleGetBenchmark(tmpFolder, 'nope');
    expect(r.status).toBe(404);
  });
});

describe('handleUpdateBenchmark', () => {
  it('replaces queries array', async () => {
    const corpus = createCorpus(tmpFolder, { name: 'c', sourceType: 'text' });
    const create = await handleCreateBenchmark(tmpFolder, { name: 'b', corpusId: corpus.id });
    const { id } = create.body as BenchmarkMeta;

    const r = await handleUpdateBenchmark(tmpFolder, id, {
      queries: [{ id: 'q1', query: 'hello', relevant: ['world'] }],
    });
    expect(r.status).toBe(200);
    const updated = r.body as BenchmarkMeta;
    expect(updated.queries.length).toBe(1);
    expect(updated.queries[0]!.query).toBe('hello');
  });
});

describe('handleDeleteBenchmark', () => {
  it('deletes existing benchmark', async () => {
    const corpus = createCorpus(tmpFolder, { name: 'c', sourceType: 'text' });
    const create = await handleCreateBenchmark(tmpFolder, { name: 'b', corpusId: corpus.id });
    const { id } = create.body as BenchmarkMeta;
    const r = await handleDeleteBenchmark(tmpFolder, id);
    expect(r.status).toBe(204);
  });
});

describe('handleRunBenchmark', () => {
  it('returns 200 with run result', async () => {
    const corpus = createCorpus(tmpFolder, { name: 'c', sourceType: 'text' });
    const create = await handleCreateBenchmark(tmpFolder, { name: 'b', corpusId: corpus.id });
    const { id } = create.body as BenchmarkMeta;
    const r = await handleRunBenchmark(tmpFolder, id, 5);
    expect(r.status).toBe(200);
    expect((r.body as { benchmarkId: string }).benchmarkId).toBeDefined();
  });

  it('returns 404 for unknown benchmark id', async () => {
    const r = await handleRunBenchmark(tmpFolder, 'nope', 5);
    expect(r.status).toBe(404);
  });
});
