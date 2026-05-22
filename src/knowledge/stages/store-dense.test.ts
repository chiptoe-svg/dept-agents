import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildDenseIndex, queryDense } from './store-dense.js';
import type { Chunk } from '../types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dense-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeChunks(n: number): Chunk[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `c:${i}`,
    corpusId: 'c',
    source: 'f.txt',
    text: `chunk ${i}`,
    index: i,
  }));
}

function unitVec(dims: number, hotIndex: number): Float32Array {
  const v = new Float32Array(dims);
  v[hotIndex] = 1.0;
  return v;
}

describe('buildDenseIndex', () => {
  it('creates dense.db in the given dir', () => {
    const chunks = makeChunks(3);
    const embeddings = new Map<string, Float32Array>([
      ['c:0', unitVec(4, 0)],
      ['c:1', unitVec(4, 1)],
      ['c:2', unitVec(4, 2)],
    ]);
    buildDenseIndex(tmpDir, chunks, embeddings);
    expect(fs.existsSync(path.join(tmpDir, 'dense.db'))).toBe(true);
  });

  it('overwrites an existing dense.db', () => {
    const chunks = makeChunks(2);
    const embeddings = new Map<string, Float32Array>([
      ['c:0', unitVec(4, 0)],
      ['c:1', unitVec(4, 1)],
    ]);
    buildDenseIndex(tmpDir, chunks, embeddings);
    buildDenseIndex(tmpDir, chunks, embeddings);
    expect(fs.existsSync(path.join(tmpDir, 'dense.db'))).toBe(true);
  });

  it('skips chunks that have no embedding in the map', () => {
    const chunks = makeChunks(3);
    const embeddings = new Map<string, Float32Array>([['c:0', unitVec(4, 0)]]);
    expect(() => buildDenseIndex(tmpDir, chunks, embeddings)).not.toThrow();
  });
});

describe('queryDense', () => {
  it('returns the most cosine-similar chunk first', () => {
    const chunks = makeChunks(3);
    const embeddings = new Map<string, Float32Array>([
      ['c:0', unitVec(4, 0)],
      ['c:1', unitVec(4, 1)],
      ['c:2', unitVec(4, 2)],
    ]);
    buildDenseIndex(tmpDir, chunks, embeddings);

    const query = unitVec(4, 1);
    const results = queryDense(tmpDir, query, 3);

    expect(results.length).toBe(3);
    expect(results[0].chunk.id).toBe('c:1');
    expect(results[0].score).toBeCloseTo(1.0, 5);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score >= results[i]!.score).toBe(true);
    }
  });

  it('returns at most k results', () => {
    const chunks = makeChunks(5);
    const embeddings = new Map(chunks.map((c) => [c.id, unitVec(4, c.index % 4)] as [string, Float32Array]));
    buildDenseIndex(tmpDir, chunks, embeddings);
    const results = queryDense(tmpDir, unitVec(4, 0), 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('returns empty array when dense.db does not exist', () => {
    const results = queryDense(tmpDir, unitVec(4, 0), 5);
    expect(results).toEqual([]);
  });
});
