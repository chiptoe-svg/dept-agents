import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BenchmarkMeta } from './types.js';

const mockExistsSync = vi.hoisted(() => vi.fn());

vi.mock('../stages/store-bm25.js', () => ({
  queryBm25: vi.fn(),
}));
vi.mock('../stages/store-dense.js', () => ({
  queryDense: vi.fn(),
}));
vi.mock('../stages/embed.js', () => ({
  embedChunks: vi.fn(),
}));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: { ...actual, existsSync: mockExistsSync },
    existsSync: mockExistsSync,
  };
});

import { queryBm25 } from '../stages/store-bm25.js';
import { queryDense } from '../stages/store-dense.js';
import { embedChunks } from '../stages/embed.js';
import { runBenchmark } from './runner.js';

function makeMeta(queries: BenchmarkMeta['queries']): BenchmarkMeta {
  return {
    id: 'b1',
    name: 'test',
    corpusId: 'c1',
    queries,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeChunk(id: string, text: string, score = 1.0) {
  return { chunk: { id, corpusId: 'c1', source: 'f.txt', text, index: 0 }, score };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
});

describe('runBenchmark', () => {
  it('runs bm25 strategy when bm25.db exists', async () => {
    mockExistsSync.mockImplementation((p: string) => String(p).endsWith('bm25.db'));
    (queryBm25 as ReturnType<typeof vi.fn>).mockReturnValue([makeChunk('c:0', 'The quick brown fox', 2.5)]);

    const meta = makeMeta([{ id: 'q1', query: 'fox', relevant: ['quick brown fox'] }]);
    const result = await runBenchmark('/fake/dir', meta, 5);

    expect(queryBm25).toHaveBeenCalledTimes(1);
    expect(result.queriesRun[0]!.strategies.bm25).toBeDefined();
    expect(result.queriesRun[0]!.strategies.bm25!.hitRank).toBe(1);
  });

  it('runs dense strategy when dense.db exists', async () => {
    mockExistsSync.mockImplementation((p: string) => String(p).endsWith('dense.db'));
    (embedChunks as ReturnType<typeof vi.fn>).mockResolvedValue(new Map([['q1', new Float32Array([1, 0, 0, 0])]]));
    (queryDense as ReturnType<typeof vi.fn>).mockReturnValue([makeChunk('c:0', 'semantic match result', 0.9)]);

    const meta = makeMeta([{ id: 'q1', query: 'semantic', relevant: ['semantic match'] }]);
    const result = await runBenchmark('/fake/dir', meta, 5);

    expect(queryDense).toHaveBeenCalledTimes(1);
    expect(result.queriesRun[0]!.strategies.dense!.hitRank).toBe(1);
  });

  it('computes hitRank = null when no gold snippet matches', async () => {
    mockExistsSync.mockImplementation((p: string) => String(p).endsWith('bm25.db'));
    (queryBm25 as ReturnType<typeof vi.fn>).mockReturnValue([makeChunk('c:0', 'completely unrelated text', 1.0)]);

    const meta = makeMeta([{ id: 'q1', query: 'foo', relevant: ['gold snippet here'] }]);
    const result = await runBenchmark('/fake/dir', meta, 5);

    expect(result.queriesRun[0]!.strategies.bm25!.hitRank).toBeNull();
  });

  it('marks unscored queries (no relevant snippets) with hitRank = null', async () => {
    mockExistsSync.mockImplementation((p: string) => String(p).endsWith('bm25.db'));
    (queryBm25 as ReturnType<typeof vi.fn>).mockReturnValue([makeChunk('c:0', 'anything', 1.0)]);

    const meta = makeMeta([{ id: 'q1', query: 'anything', relevant: [] }]);
    const result = await runBenchmark('/fake/dir', meta, 5);

    expect(result.queriesRun[0]!.strategies.bm25!.hitRank).toBeNull();
    expect(result.summary.scored).toBe(0);
  });

  it('computes MRR correctly for a scored query with hitRank=2', async () => {
    mockExistsSync.mockImplementation((p: string) => String(p).endsWith('bm25.db'));
    (queryBm25 as ReturnType<typeof vi.fn>).mockReturnValue([
      makeChunk('c:0', 'irrelevant text', 2.0),
      makeChunk('c:1', 'gold snippet is here', 1.5),
    ]);

    const meta = makeMeta([{ id: 'q1', query: 'q', relevant: ['gold snippet'] }]);
    const result = await runBenchmark('/fake/dir', meta, 5);

    expect(result.summary.strategies.bm25!.mrr).toBeCloseTo(0.5, 5);
    expect(result.summary.strategies.bm25!.hitAt1).toBe(0);
    expect(result.summary.strategies.bm25!.hitAt3).toBe(1);
  });

  it('returns empty queriesRun when benchmark has no queries', async () => {
    const meta = makeMeta([]);
    const result = await runBenchmark('/fake/dir', meta, 5);
    expect(result.queriesRun).toEqual([]);
  });
});
